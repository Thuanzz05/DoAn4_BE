import 'dotenv/config'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'
import mysql, { type ResultSetHeader, type RowDataPacket } from 'mysql2/promise'

test('kiểm tra đầu vào độc lập ghi danh, đúng quyền/biên điểm, giữ snapshot và lịch sử hủy', {
  skip: process.env.RUN_PLACEMENT_INTEGRATION !== '1', timeout: 60000,
}, async () => {
  const isolatedDatabase = `doan4_placement_test_${randomBytes(6).toString('hex')}`
  assert.match(isolatedDatabase, /^doan4_placement_test_[a-f0-9]{12}$/)
  const connection = await mysql.createConnection({ host: process.env.DB_HOST ?? '127.0.0.1', port: Number(process.env.DB_PORT ?? 3306),
    user: process.env.DB_USER ?? 'root', password: process.env.DB_PASSWORD ?? '', multipleStatements: true, dateStrings: true })
  process.env.DB_NAME = isolatedDatabase
  process.env.SMTP_HOST = ''
  process.env.SMTP_USER = ''
  process.env.SMTP_PASSWORD = ''
  let closeServer: (() => Promise<void>) | undefined
  let closePool: (() => Promise<void>) | undefined
  try {
    const schema = await readFile(join(process.cwd(), 'database/schema.sql'), 'utf8')
    await connection.query(schema.replace(/\bdoan4\b/g, isolatedDatabase))
    const migration = await readFile(join(process.cwd(), 'database/migrations/20261008_kiem_tra_dau_vao.sql'), 'utf8')
    await connection.query(migration.replace(/\bdoan4\b/g, isolatedDatabase))
    await connection.query(migration.replace(/\bdoan4\b/g, isolatedDatabase))
    const { app } = await import('./app')
    const { database } = await import('./config/database')
    const { env } = await import('./config/env')
    closePool = () => database.end()
    const server = app.listen(0, '127.0.0.1')
    await new Promise<void>((resolve, reject) => { server.once('listening', resolve); server.once('error', reject) })
    closeServer = () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
    const address = server.address()
    assert.ok(address && typeof address !== 'string')
    const base = `http://127.0.0.1:${address.port}/api`
    const call = (path: string, token: string, method = 'GET', body?: unknown) => fetch(`${base}${path}`, {
      method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    async function request(path: string, token: string, method = 'GET', body?: unknown, status = 200): Promise<any> {
      const response = await call(path, token, method, body)
      const result = response.status === 204 ? undefined : await response.json() as { data: unknown; message?: string }
      assert.equal(response.status, status, `${method} ${path}: ${result?.message ?? 'HTTP status'}`)
      if (path !== '/users' || method !== 'POST') noSecrets(result)
      return result?.data
    }
    async function insert(sql: string, values: Array<string | number | null>) {
      const [result] = await connection.execute<ResultSetHeader>(sql, values)
      return result.insertId
    }
    function noSecrets(value: unknown): void {
      if (!value || typeof value !== 'object') return
      for (const [key, item] of Object.entries(value)) {
        assert.ok(!/password|mat_khau|secret|token|ma_hmac|google_sub/i.test(key), `Không công khai trường bí mật: ${key}`)
        noSecrets(item)
      }
    }
    const users: number[] = []
    for (const [code, role] of [['QT-PLACEMENT', 'quan_tri'], ['GV-PLACEMENT', 'giao_vien'],
      ['HV-OTHER', 'hoc_vien'], ['HV-LOCKED', 'hoc_vien']]) {
      users.push(await insert('INSERT INTO nguoi_dung (ma_nguoi_dung, ho_ten, email, mat_khau_bam, vai_tro) VALUES (?, ?, ?, ?, ?)',
        [code, code, `${code}@example.test`, 'unused-password-hash', role]))
    }
    await connection.execute('UPDATE nguoi_dung SET dang_hoat_dong = FALSE WHERE id = ?', [users[3]])
    const token = (id: number, role: string) => jwt.sign({ role, ver: 0 }, env.jwtSecret, { subject: String(id), expiresIn: '5m' })
    const admin = token(users[0], 'quan_tri'), teacher = token(users[1], 'giao_vien'), otherStudent = token(users[2], 'hoc_vien')
    const created = await request('/users', admin, 'POST', {
      fullName: 'Học viên kiểm tra đầu vào', email: 'placement@example.test', phone: '0901000001', role: 'hoc_vien',
    }, 201)
    assert.equal(created.role, 'hoc_vien')
    assert.equal(created.emailSent, false, 'Không gửi SMTP trong kiểm thử')
    assert.equal(Number(created.hasPlacementHistory), 0)
    assert.ok(typeof created.temporaryPassword === 'string' && created.temporaryPassword.length >= 8)
    const [hashes] = await connection.query<RowDataPacket[]>('SELECT mat_khau_bam FROM nguoi_dung WHERE id = ?', [created.id])
    assert.ok(await bcrypt.compare(created.temporaryPassword, hashes[0].mat_khau_bam), 'Mật khẩu bàn giao khớp băm, không công khai băm')
    assert.equal(created.mat_khau_bam, undefined)
    const student = token(created.id, 'hoc_vien')
    const academicCounts = async () => (await connection.query<RowDataPacket[]>(`SELECT
      (SELECT COUNT(*) FROM ghi_danh) AS enrollments, (SELECT COUNT(*) FROM hoa_don) AS invoices,
      (SELECT COUNT(*) FROM ky_thi) AS exams, (SELECT COUNT(*) FROM ket_qua_thi) AS results,
      (SELECT COUNT(*) FROM chung_chi) AS certificates`))[0][0]
    const emptyAcademic = { enrollments: 0, invoices: 0, exams: 0, results: 0, certificates: 0 }
    assert.deepEqual({ ...await academicCounts() }, emptyAcademic, 'Tạo tài khoản trước khóa học không tự ghi danh')
    const courseIds: number[] = []
    for (const [code, language, status] of [['PLACE-EN', 'Tiếng Anh', 'dang_mo'], ['PLACE-JA', 'Tiếng Nhật', 'dang_mo'],
      ['PLACE-HIDDEN', 'Tiếng Anh', 'tam_an'], ['PLACE-ENROLL', 'Tiếng Anh', 'dang_mo']]) {
      courseIds.push(await insert(`INSERT INTO khoa_hoc (ma_khoa_hoc, ten_khoa_hoc, ngoai_ngu, trinh_do, so_buoi, hoc_phi, trang_thai)
        VALUES (?, ?, ?, 'A2', 20, 1500000, ?)`, [code, `Khóa ${code}`, language, status]))
    }
    const [dates] = await connection.query<RowDataPacket[]>(`SELECT CURDATE() AS today, DATE_ADD(CURDATE(), INTERVAL 1 DAY) AS future`)
    const body = { studentId: created.id, assessedAt: dates[0].today, language: 'Tiếng Anh', score: 7.25, level: 'B1',
      recommendedCourseId: courseIds[0], note: '  Khuyến nghị thủ công  ' }
    const list = () => request(`/placement-assessments?studentId=${created.id}`, admin)

    await request(`/placement-assessments?studentId=${created.id}`, '', 'GET', undefined, 401)
    await request('/placement-assessments', '', 'POST', body, 401)
    await request('/placement-assessments/1/cancel', '', 'POST', { reason: 'Không có quyền' }, 401)
    for (const unauthorized of [teacher, otherStudent, token(users[1], 'quan_tri')]) {
      await request(`/placement-assessments?studentId=${created.id}`, unauthorized, 'GET', undefined, 403)
      await request('/placement-assessments', unauthorized, 'POST', body, 403)
      await request('/placement-assessments/1/cancel', unauthorized, 'POST', { reason: 'Không có quyền' }, 403)
    }
    await request('/student/placement-assessments', admin, 'GET', undefined, 403)
    await request('/student/placement-assessments', teacher, 'GET', undefined, 403)
    await request('/placement-assessments', admin, 'GET', undefined, 400)
    await request('/placement-assessments?studentId=0', admin, 'GET', undefined, 400)
    await request(`/placement-assessments?studentId=${users[1]}`, admin, 'GET', undefined, 404)
    await request('/placement-assessments?studentId=999999', admin, 'GET', undefined, 404)
    assert.deepEqual(await request(`/placement-assessments?studentId=${users[3]}`, admin), [])
    for (const score of [-0.01, 10.01, 7.251, 1.005, '7.25', '', null, true]) {
      await request('/placement-assessments', admin, 'POST', { ...body, score }, 400)
    }
    const invalid: Array<Record<string, unknown>> = [
      { studentId: true }, { studentId: [created.id] }, { assessedAt: dates[0].future },
      { assessedAt: '2026-02-30' }, { assessedAt: '2026-13-01' }, { assessedAt: '0999-01-01' }, { assessedAt: '' },
      { language: ' ' }, { language: 'x'.repeat(51) }, { level: '' }, { level: 'x'.repeat(51) },
      { recommendedCourseId: true }, { recommendedCourseId: [courseIds[0]] }, { recommendedCourseId: 0 },
      { recommendedCourseId: 1.1 }, { note: 'x'.repeat(1001) }, { note: 1 },
    ]
    for (const patch of invalid) await request('/placement-assessments', admin, 'POST', { ...body, ...patch }, 400)
    await request('/placement-assessments', admin, 'POST', [], 400)
    await request('/placement-assessments', admin, 'POST', { ...body, studentId: users[1] }, 404)
    await request('/placement-assessments', admin, 'POST', { ...body, studentId: 999999 }, 404)
    await request('/placement-assessments', admin, 'POST', { ...body, studentId: users[3] }, 409)
    await request('/placement-assessments', admin, 'POST', { ...body, recommendedCourseId: 999999 }, 404)
    await request('/placement-assessments', admin, 'POST', { ...body, recommendedCourseId: courseIds[1] }, 400)
    await request('/placement-assessments', admin, 'POST', { ...body, recommendedCourseId: courseIds[2] }, 409)
    assert.equal((await list()).length, 0, 'Lỗi kiểm tra không để lại hồ sơ dở dang')

    const assessment = await request('/placement-assessments', admin, 'POST', { ...body, language: '  tIẾNG aNH  ',
      createdById: users[1], status: 'da_huy' }, 201)
    assert.equal(assessment.score, 7.25)
    assert.equal(assessment.language, 'tIẾNG aNH')
    assert.equal(assessment.level, 'B1', 'Trình độ do quản trị xác nhận, không tự đổi sang trình độ khóa đề xuất')
    assert.equal(assessment.note, 'Khuyến nghị thủ công')
    assert.equal(assessment.createdById, users[0])
    assert.equal(assessment.status, 'da_ghi_nhan')
    assert.equal(assessment.cancelReason, null)
    noSecrets(assessment)
    const snapshot = (record: any) => ({ code: record.recommendedCourseCode, name: record.recommendedCourseName,
      language: record.recommendedCourseLanguage, level: record.recommendedCourseLevel })
    assert.deepEqual(snapshot(assessment), { code: 'PLACE-EN', name: 'Khóa PLACE-EN', language: 'Tiếng Anh', level: 'A2' })
    const zero = await request('/placement-assessments', admin, 'POST', { ...body, score: 0, recommendedCourseId: null, note: null }, 201)
    const ten = await request('/placement-assessments', admin, 'POST', { ...body, score: 10, recommendedCourseId: undefined, note: '' }, 201)
    const decimal = await request('/placement-assessments', admin, 'POST', { ...body, score: 1.23, recommendedCourseId: null }, 201)
    assert.equal(zero.score, 0)
    assert.equal(ten.score, 10)
    assert.equal(decimal.score, 1.23, 'Số thập phân hợp lệ không bị lỗi sai số dấu phẩy động')
    assert.equal(zero.recommendedCourseId, null)
    assert.deepEqual(snapshot(zero), { code: null, name: null, language: null, level: null })
    assert.equal(ten.note, null)
    const maximum = await request('/placement-assessments', admin, 'POST', { ...body, language: 'x'.repeat(50), level: 'y'.repeat(50),
      note: 'n'.repeat(1000), recommendedCourseId: null, assessedAt: '1000-01-01' }, 201)
    assert.equal(maximum.note.length, 1000)
    assert.deepEqual({ ...await academicCounts() }, emptyAcademic, 'Ghi nhận kiểm tra không tự tạo ghi danh/học phí/kỳ thi')
    const ownHistory = await request(`/student/placement-assessments?studentId=${users[2]}`, student)
    assert.equal(ownHistory.length, 5)
    assert.ok(ownHistory.every((item: any) => item.studentId === created.id))
    assert.deepEqual(await request(`/student/placement-assessments?studentId=${created.id}`, otherStudent), [], 'Học viên không đọc hồ sơ người khác qua query')
    noSecrets(ownHistory)
    const usersBeforeEnrollment = await request('/users?role=hoc_vien', admin)
    noSecrets(usersBeforeEnrollment)
    assert.equal(Number(usersBeforeEnrollment.find((item: any) => item.id === created.id).hasPlacementHistory), 1)
    await insert('INSERT INTO thong_bao (nguoi_dung_id, tieu_de, noi_dung) VALUES (?, ?, ?)', [created.id, 'Giữ lịch sử', 'Không xóa khi delete bị chặn'])
    await request(`/users/${created.id}`, admin, 'DELETE', undefined, 409)
    const [notifications] = await connection.query<RowDataPacket[]>('SELECT COUNT(*) AS total FROM thong_bao WHERE nguoi_dung_id = ?', [created.id])
    assert.equal(notifications[0].total, 1, 'Delete bị chặn không mất dữ liệu phụ')
    await assert.rejects(connection.execute('DELETE FROM nguoi_dung WHERE id = ?', [users[0]]),
      (error: any) => error.code === 'ER_ROW_IS_REFERENCED_2', 'FK bảo vệ người ghi nhận')

    await request(`/courses/${courseIds[0]}`, admin, 'PATCH', { code: 'PLACE-CHANGED', name: 'Đã đổi tên khóa', language: 'Tiếng Đức', level: 'C1', status: 'tam_an' })
    assert.deepEqual(snapshot((await list()).find((item: any) => item.id === assessment.id)), snapshot(assessment), 'Sửa khóa không làm đổi snapshot')
    await request('/placement-assessments', admin, 'POST', body, 409)
    await request(`/courses/${courseIds[0]}`, admin, 'DELETE', undefined, 204)
    const deletedCourseAssessment = (await list()).find((item: any) => item.id === assessment.id)
    assert.equal(deletedCourseAssessment.recommendedCourseId, null)
    assert.deepEqual(snapshot(deletedCourseAssessment), snapshot(assessment), 'Xóa khóa chỉ xóa liên kết, giữ đủ snapshot')
    await request('/placement-assessments', admin, 'POST', body, 404)
    await request(`/placement-assessments/${assessment.id}`, admin, 'PATCH', { score: 9 }, 404)
    await request(`/placement-assessments/${assessment.id}`, admin, 'DELETE', undefined, 404)
    await request('/placement-assessments/not-an-id/cancel', admin, 'POST', { reason: 'Sai mã' }, 400)
    await request(`/placement-assessments/${assessment.id}/cancel`, admin, 'POST', undefined, 400)
    for (const reason of ['', ' ', null, 'x'.repeat(256)]) {
      await request(`/placement-assessments/${assessment.id}/cancel`, admin, 'POST', { reason }, 400)
    }
    await request('/placement-assessments/999999/cancel', admin, 'POST', { reason: 'Không tồn tại' }, 404)
    const canceled = await request(`/placement-assessments/${assessment.id}/cancel`, admin, 'POST', { reason: '  Nhập nhầm kết quả  ' })
    assert.equal(canceled.status, 'da_huy')
    assert.equal(canceled.cancelReason, 'Nhập nhầm kết quả')
    assert.equal(canceled.canceledById, users[0])
    assert.ok(canceled.canceledAt)
    assert.equal(canceled.score, assessment.score)
    assert.deepEqual(snapshot(canceled), snapshot(assessment))
    await request(`/placement-assessments/${assessment.id}/cancel`, admin, 'POST', { reason: 'Lặp hủy' }, 409)
    const races = await Promise.all(['Hủy A', 'Hủy B'].map((reason) => call(`/placement-assessments/${zero.id}/cancel`, admin, 'POST', { reason })))
    assert.deepEqual(races.map((response) => response.status).sort(), [200, 409], 'Hai lần hủy chỉ một lần thành công')
    const afterRace = (await list()).find((item: any) => item.id === zero.id)
    assert.ok(['Hủy A', 'Hủy B'].includes(afterRace.cancelReason))
    assert.equal(afterRace.score, 0)
    assert.equal((await list()).length, 5, 'Hủy giữ hồ sơ thay vì xóa lịch sử')
    await request(`/users/${created.id}`, admin, 'DELETE', undefined, 409)
    const canceledOnly = await request('/placement-assessments', admin, 'POST', {
      ...body, studentId: users[2], recommendedCourseId: null,
    }, 201)
    await request(`/placement-assessments/${canceledOnly.id}/cancel`, admin, 'POST', { reason: 'Giữ hồ sơ đã hủy' })
    await request(`/users/${users[2]}`, admin, 'DELETE', undefined, 409)
    const canceledHistory = await request('/student/placement-assessments', otherStudent)
    assert.equal(canceledHistory.length, 1)
    assert.equal(canceledHistory[0].status, 'da_huy')
    const canceledStudent = (await request('/users?role=hoc_vien', admin)).find((item: any) => item.id === users[2])
    assert.equal(Number(canceledStudent.hasPlacementHistory), 1, 'Chỉ có lịch sử đã hủy cũng không xóa học viên')

    const enrollment = await request('/enrollments', admin, 'POST', { studentId: created.id, courseId: courseIds[3] }, 201)
    assert.equal(enrollment.status, 'cho_xep_lop')
    await request('/enrollments', admin, 'POST', { studentId: created.id, courseId: courseIds[3] }, 409)
    assert.deepEqual({ ...await academicCounts() }, { ...emptyAcademic, enrollments: 1, invoices: 1 }, 'Ghi danh thủ công giữ luồng tạo một học phí')
    const [invoices] = await connection.query<RowDataPacket[]>('SELECT so_tien, trang_thai FROM hoa_don WHERE ghi_danh_id = ?', [enrollment.id])
    assert.equal(Number(invoices[0].so_tien), 1500000)
    assert.equal(invoices[0].trang_thai, 'chua_thanh_toan')
    await request(`/placement-assessments/${ten.id}/cancel`, admin, 'POST', { reason: 'x'.repeat(255) })
    assert.deepEqual({ ...await academicCounts() }, { ...emptyAcademic, enrollments: 1, invoices: 1 }, 'Hủy kiểm tra không hủy ghi danh/học phí')
    await request(`/users/${users[1]}`, admin, 'DELETE', undefined, 204)
    noSecrets(await list())
  } finally {
    await closeServer?.()
    await closePool?.()
    await connection.query(`DROP DATABASE IF EXISTS ${isolatedDatabase}`)
    await connection.end()
  }
})
