import 'dotenv/config'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import bcrypt from 'bcryptjs'
import ExcelJS from 'exceljs'
import mysql, { type ResultSetHeader, type RowDataPacket } from 'mysql2/promise'

test('học vụ quản trị và giáo viên trên MySQL riêng: kỳ thi, gia hạn, học phí, chuyên cần, Excel, khóa chứng chỉ', {
  skip: process.env.RUN_ACADEMIC_INTEGRATION !== '1', timeout: 60000,
}, async () => {
  const isolatedDatabase = `doan4_academic_test_${randomBytes(6).toString('hex')}`
  assert.match(isolatedDatabase, /^doan4_academic_test_[a-f0-9]{12}$/)
  const connection = await mysql.createConnection({ host: process.env.DB_HOST ?? '127.0.0.1', port: Number(process.env.DB_PORT ?? 3306),
    user: process.env.DB_USER ?? 'root', password: process.env.DB_PASSWORD ?? '', multipleStatements: true, dateStrings: true })
  process.env.DB_NAME = isolatedDatabase
  process.env.SMTP_USER = ''
  process.env.SMTP_PASSWORD = ''
  let closeServer: (() => Promise<void>) | undefined
  let closePool: (() => Promise<void>) | undefined
  try {
    const schema = (await readFile(join(process.cwd(), 'database/schema.sql'), 'utf8')).replace(/\bdoan4\b/g, isolatedDatabase)
    await connection.query(schema)
    const { app } = await import('./app')
    const { database } = await import('./config/database')
    closePool = () => database.end()
    const server = app.listen(0, '127.0.0.1')
    await new Promise<void>((resolve, reject) => { server.once('listening', resolve); server.once('error', reject) })
    closeServer = () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
    const address = server.address()
    assert.ok(address && typeof address !== 'string')
    const base = `http://127.0.0.1:${address.port}/api`
    async function request(path: string, token: string | undefined, method = 'GET', body?: unknown, status = 200): Promise<any> {
      const response = await fetch(`${base}${path}`, { method, headers: { 'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
      const result = await response.json() as { data: unknown; message?: string }
      assert.equal(response.status, status, `${method} ${path}: ${JSON.stringify(result)}`)
      return result.data
    }
    async function insert(sql: string, values: Array<string | number | null>) {
      const [result] = await connection.execute<ResultSetHeader>(sql, values)
      return result.insertId
    }
    const hash = await bcrypt.hash('Academic-test-password-123', 4)
    const users: number[] = []
    for (const [code, name, role] of [['QT-ACADEMIC', 'Quản trị kiểm thử', 'quan_tri'], ['GV-ACADEMIC', 'Giáo viên kiểm thử', 'giao_vien'],
      ['HV-ACADEMIC', 'Học viên đã đóng', 'hoc_vien'], ['HV-ACADEMIC2', 'Học viên chưa đóng', 'hoc_vien'], ['GV-ACADEMIC2', 'Giáo viên khác', 'giao_vien'],
      ['HV-ACADEMIC3', 'Học viên đã hủy ghi danh', 'hoc_vien']]) {
      users.push(await insert('INSERT INTO nguoi_dung (ma_nguoi_dung, ho_ten, email, mat_khau_bam, vai_tro) VALUES (?, ?, ?, ?, ?)',
        [code, name, `${code}@example.test`, hash, role]))
    }
    const [admin, teacher, student, otherTeacher] = await Promise.all(['QT-ACADEMIC', 'GV-ACADEMIC', 'HV-ACADEMIC', 'GV-ACADEMIC2'].map(async (account) =>
      String((await request('/auth/login', undefined, 'POST', { account, password: 'Academic-test-password-123' })).token)))
    const courseId = await insert('INSERT INTO khoa_hoc (ma_khoa_hoc, ten_khoa_hoc, ngoai_ngu, trinh_do, so_buoi, hoc_phi) VALUES (?, ?, ?, ?, ?, ?)',
      ['ACADEMIC-A1', 'Khóa học kiểm thử', 'Tiếng Anh', 'A1', 2, 1000])
    const roomId = await insert('INSERT INTO phong_hoc (ma_phong, suc_chua) VALUES (?, ?)', ['ACADEMIC-P1', 30])
    const classId = await insert('INSERT INTO lop_hoc (ma_lop, ten_lop, khoa_hoc_id, giao_vien_id, ngay_khai_giang, so_buoi, si_so_toi_da, trang_thai) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      ['ACADEMIC-C1', 'Lớp kiểm thử', courseId, users[1], '2026-01-01', 2, 20, 'dang_hoc'])
    const enrollmentIds: number[] = []
    for (const userId of [users[2], users[3]]) enrollmentIds.push(await insert('INSERT INTO ghi_danh (hoc_vien_id, khoa_hoc_id, lop_hoc_id, ngay_ghi_danh, trang_thai) VALUES (?, ?, ?, ?, ?)',
      [userId, courseId, classId, '2026-01-01', 'dang_hoc']))
    await insert('INSERT INTO hoa_don (ma_hoa_don, ghi_danh_id, so_tien, ngay_lap, han_thanh_toan, trang_thai, ngay_thanh_toan, phuong_thuc) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      ['ACADEMIC-HD1', enrollmentIds[0], 1000, '2026-01-01', '2026-01-02', 'da_thanh_toan', '2026-01-01 12:00:00', 'tien_mat'])
    await insert('INSERT INTO hoa_don (ma_hoa_don, ghi_danh_id, so_tien, ngay_lap, han_thanh_toan, trang_thai) VALUES (?, ?, ?, ?, ?, ?)',
      ['ACADEMIC-HD2', enrollmentIds[1], 1000, '2026-01-01', '2026-01-02', 'chua_thanh_toan'])
    const sessionIds: number[] = []
    for (const [days, status] of [[3, 'da_len_lich'], [2, 'da_len_lich'], [1, 'da_huy']] as const) {
      sessionIds.push(await insert(`INSERT INTO buoi_hoc (lop_hoc_id, giao_vien_id, phong_hoc_id, bat_dau, ket_thuc, trang_thai)
        VALUES (?, ?, ?, DATE_SUB(NOW(), INTERVAL ${days} DAY), DATE_ADD(DATE_SUB(NOW(), INTERVAL ${days} DAY), INTERVAL 1 HOUR), ?)`,
      [classId, users[1], roomId, status]))
    }
    const future = (days: number) => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Bangkok', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).format(new Date(Date.now() + days * 86400000)).replace(' ', 'T')
    await request('/exams', student, 'GET', undefined, 403)
    await request('/exams', admin, 'POST', { classId, name: 'Thi 1' }, 400)
    const first = await request('/exams', admin, 'POST', { classId, name: 'Thi 1', examDate: '2026-01-03', deadline: future(1), reason: 'Tạo kỳ thi đầu khóa' }, 201)
    const second = await request(`/teacher/classes/${classId}/exams`, teacher, 'POST', { name: 'Thi 2', examDate: '2026-01-04', deadline: future(1) }, 201)
    const historyCreated = await request(`/exams/${second.id}/history`, admin)
    assert.equal(historyCreated[0].action, 'tao')
    const draft = await request('/exams', admin, 'POST', { classId, name: 'Thi tạo nhầm', reason: 'Kiểm thử hủy kỳ thi nháp' }, 201)
    assert.equal((await request(`/classes/${classId}/academic`, admin)).students[0].requiredExams, 3)
    await request(`/exams/${draft.id}/cancel`, teacher, 'POST', { reason: 'Giáo viên không được hủy' }, 403)
    await request(`/exams/${draft.id}/cancel`, admin, 'POST', { reason: '' }, 400)
    await request(`/exams/${draft.id}/cancel`, admin, 'POST', { reason: 'x'.repeat(256) }, 400)
    const canceledExam = await request(`/exams/${draft.id}/cancel`, admin, 'POST', { reason: 'Tạo nhầm kỳ thi, chưa có dữ liệu điểm' })
    assert.equal(canceledExam.canceled, true)
    assert.equal(canceledExam.status, 'da_huy')
    assert.equal((await request(`/classes/${classId}/academic`, admin)).students[0].requiredExams, 2)
    const canceledHistory = await request(`/exams/${draft.id}/history`, admin)
    assert.deepEqual(canceledHistory.map((item: any) => item.action), ['huy', 'tao'])
    assert.equal(canceledHistory[0].before.canceled, false)
    assert.equal(canceledHistory[0].after.canceled, true)
    assert.equal((await request(`/exams?classId=${classId}`, admin)).find((item: any) => item.id === draft.id).canceled, true)
    assert.equal((await request(`/teacher/classes/${classId}/exams`, teacher)).some((item: any) => item.id === draft.id), false)
    assert.equal((await request('/student/results', student)).exams.some((item: any) => item.examId === draft.id), false)
    assert.equal((await request('/student/certificate-eligibility', student))[0].requiredExams, 2)
    await request(`/exams/${draft.id}/cancel`, admin, 'POST', { reason: 'Hủy lại' }, 409)
    await request(`/exams/${draft.id}`, admin, 'PATCH', { name: 'Sửa sau hủy', reason: 'Không được sửa kỳ đã hủy' }, 409)
    await request(`/teacher/exams/${draft.id}/results`, teacher, 'GET', undefined, 409)
    await request(`/teacher/exams/${draft.id}/results`, teacher, 'PUT', { items: [{ enrollmentId: enrollmentIds[0], listening: 8, speaking: 8, reading: 8, writing: 8 }] }, 409)
    const legacyDraft = await request('/exams', admin, 'POST', { classId, name: 'Kỳ có bản nháp cũ', reason: 'Kiểm thử giữ mọi lịch sử điểm' }, 201)
    const legacyResultId = await insert('INSERT INTO ket_qua_thi (ky_thi_id, ghi_danh_id, nghe, noi, doc, viet) VALUES (?, ?, NULL, NULL, NULL, NULL)', [legacyDraft.id, enrollmentIds[0]])
    await request(`/exams/${legacyDraft.id}/cancel`, admin, 'POST', { reason: 'Dù trống cũng đã có lịch sử' }, 409)
    assert.equal((await request(`/exams?classId=${classId}`, admin)).find((item: any) => item.id === legacyDraft.id).canceled, false)
    // Remove only this synthetic legacy fixture to keep the remaining class/certificate checks independent.
    await connection.execute('DELETE FROM ket_qua_thi WHERE id = ? AND ky_thi_id = ?', [legacyResultId, legacyDraft.id])
    await request(`/exams/${legacyDraft.id}/cancel`, admin, 'POST', { reason: 'Dọn kỳ kiểm thử sau khi bỏ dữ liệu fixture' })
    const raceExam = await request('/exams', admin, 'POST', { classId, name: 'Kỳ kiểm thử đồng thời', reason: 'Kiểm thử khóa hủy và lưu điểm' }, 201)
    const [cancelResponse, gradeResponse] = await Promise.all([
      fetch(`${base}/exams/${raceExam.id}/cancel`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${admin}` }, body: JSON.stringify({ reason: 'Hủy đồng thời với nhập điểm' }) }),
      fetch(`${base}/teacher/exams/${raceExam.id}/results`, { method: 'PUT', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${teacher}` }, body: JSON.stringify({ items: [{ enrollmentId: enrollmentIds[0], listening: 8, speaking: 8, reading: 8, writing: 8 }] }) }),
    ])
    assert.ok(cancelResponse.status === 200 && gradeResponse.status === 409 || cancelResponse.status === 409 && gradeResponse.status === 200,
      'Hủy và lưu điểm đồng thời chỉ được có một thao tác thành công')
    if (gradeResponse.status === 200) {
      await connection.execute('DELETE FROM ket_qua_thi WHERE ky_thi_id = ? AND ghi_danh_id = ?', [raceExam.id, enrollmentIds[0]])
      await request(`/exams/${raceExam.id}/cancel`, admin, 'POST', { reason: 'Dọn kỳ kiểm thử sau khi bỏ dữ liệu fixture' })
    }
    const canceledClassId = await insert('INSERT INTO lop_hoc (ma_lop, ten_lop, khoa_hoc_id, giao_vien_id, ngay_khai_giang, so_buoi, si_so_toi_da, trang_thai) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      ['ACADEMIC-CANCELED', 'Lớp đã hủy kiểm thử', courseId, users[1], '2026-01-01', 2, 20, 'da_huy'])
    const canceledClassExamId = await insert('INSERT INTO ky_thi (lop_hoc_id, ten_ky_thi) VALUES (?, ?)', [canceledClassId, 'Kỳ thi lớp đã hủy'])
    await request(`/exams/${canceledClassExamId}/cancel`, admin, 'POST', { reason: 'Không được đổi kỳ thi lớp đã hủy' }, 409)
    await request(`/exams/${first.id}`, admin, 'PATCH', { name: 'Thi sửa', reason: '' }, 400)
    await request(`/exams/${first.id}`, admin, 'PATCH', { deadline: null, reason: 'Bỏ hạn' }, 400)
    await connection.execute('UPDATE ky_thi SET han_sua_diem = DATE_SUB(NOW(), INTERVAL 1 HOUR) WHERE id = ?', [first.id])
    const renamed = await request(`/exams/${first.id}`, admin, 'PATCH', { name: 'Thi sửa tên', reason: 'Sửa tên kỳ thi' })
    assert.equal(renamed.deadlinePassed, true)
    await request(`/teacher/exams/${first.id}/results`, teacher, 'PUT', { items: [{ enrollmentId: enrollmentIds[0], listening: 0, speaking: 0, reading: 0, writing: 0 }] }, 409)
    const reopened = await request(`/exams/${first.id}`, admin, 'PATCH', { deadline: future(3), reason: 'Nhập bù điểm sau kiểm tra' })
    assert.equal(reopened.deadlinePassed, false)
    const history = await request(`/exams/${first.id}/history`, admin)
    assert.deepEqual(history.map((item: any) => item.action), ['gia_han', 'cap_nhat', 'tao'])
    assert.equal(history[0].before.name, 'Thi sửa tên')
    assert.equal(history[0].after.deadline, reopened.deadline)
    const roster = await request(`/teacher/exams/${first.id}/results`, teacher)
    assert.equal(roster.students.length, 2)
    assert.equal(roster.students.find((item: any) => item.enrollmentId === enrollmentIds[1]).eligible, false)
    assert.equal(roster.students.find((item: any) => item.enrollmentId === enrollmentIds[1]).eligibilityReason, 'Chưa hoàn tất học phí')
    await request(`/teacher/exams/${first.id}/results`, teacher, 'PUT', { items: [{ enrollmentId: enrollmentIds[1], listening: 10, speaking: 10, reading: 10, writing: 10 }] }, 400)
    await request(`/teacher/exams/${first.id}/results`, teacher, 'PUT', { items: [{ enrollmentId: enrollmentIds[0], listening: 0, speaking: 0, reading: 0, writing: 0 }] })
    await request(`/exams/${first.id}/cancel`, admin, 'POST', { reason: 'Không được hủy kỳ đã có điểm thật' }, 409)
    await request(`/teacher/sessions/${sessionIds[0]}/attendance`, teacher, 'PUT', { items: [{ enrollmentId: enrollmentIds[0], status: 'co_mat' }, { enrollmentId: enrollmentIds[1], status: 'vang' }] })
    const canceledEnrollmentId = await insert('INSERT INTO ghi_danh (hoc_vien_id, khoa_hoc_id, lop_hoc_id, ngay_ghi_danh, trang_thai) VALUES (?, ?, ?, ?, ?)',
      [users[5], courseId, classId, '2026-01-01', 'da_huy'])
    await insert('INSERT INTO diem_danh (buoi_hoc_id, ghi_danh_id, trang_thai) VALUES (?, ?, ?)', [sessionIds[0], canceledEnrollmentId, 'co_mat'])
    const sessionSummary = (await request('/teacher/sessions', teacher)).find((item: any) => item.id === sessionIds[0])
    assert.equal(Number(sessionSummary.students), 2)
    assert.equal(Number(sessionSummary.attendanceMarked), 2, 'Điểm danh lịch sử của ghi danh đã hủy không tăng số đã điểm danh hiện tại')
    let details = await request(`/classes/${classId}/academic`, admin)
    const paidStudent = () => details.students.find((item: any) => item.enrollmentId === enrollmentIds[0])
    assert.equal(paidStudent().expectedAttendance, 2)
    assert.equal(paidStudent().recordedAttendance, 1)
    assert.equal(paidStudent().attendanceRate, 50)
    assert.equal(paidStudent().requiredExams, 2)
    assert.equal(paidStudent().completedExams, 1)
    assert.equal(paidStudent().average, null)
    assert.equal(details.missingAttendance.length, 2)
    assert.equal(details.sessions.find((item: any) => item.id === sessionIds[1]).missingStudents.length, 2)
    assert.equal(details.sessions.find((item: any) => item.id === sessionIds[2]).expectedAttendance, 0)
    assert.equal(details.missingAttendance.every((item: any) => item.canMarkAttendance), true)
    let teacherDetails = await request(`/teacher/classes/${classId}/academic`, teacher)
    assert.equal(teacherDetails.missingAttendance.every((item: any) => item.canMarkAttendance), true)
    await connection.execute('UPDATE buoi_hoc SET giao_vien_id = ? WHERE id = ?', [users[4], sessionIds[1]])
    teacherDetails = await request(`/teacher/classes/${classId}/academic`, teacher)
    assert.equal(teacherDetails.missingAttendance.every((item: any) => !item.canMarkAttendance), true)
    assert.equal(teacherDetails.sessions.find((item: any) => item.id === sessionIds[1]).canMarkAttendance, false)
    assert.equal((await request(`/classes/${classId}/academic`, admin)).missingAttendance.every((item: any) => item.canMarkAttendance), true)
    await request(`/teacher/sessions/${sessionIds[1]}/attendance`, teacher, 'GET', undefined, 404)
    await request(`/teacher/sessions/${sessionIds[1]}/attendance`, teacher, 'PUT', { items: [{ enrollmentId: enrollmentIds[0], status: 'co_mat' }] }, 404)
    await connection.execute('UPDATE buoi_hoc SET giao_vien_id = ? WHERE id = ?', [users[1], sessionIds[1]])
    await request(`/teacher/classes/${classId}/academic`, otherTeacher, 'GET', undefined, 404)
    await request(`/classes/${classId}/academic`, student, 'GET', undefined, 403)
    await request(`/teacher/exams/${second.id}/results`, teacher, 'PUT', { items: [{ enrollmentId: enrollmentIds[0], listening: 10, speaking: 10, reading: 10, writing: 10 }] })
    details = await request(`/teacher/classes/${classId}/academic`, teacher)
    assert.equal(paidStudent().average, 5)
    const exported = await fetch(`${base}/classes/${classId}/academic/export?section=all`, { headers: { Authorization: `Bearer ${admin}` } })
    assert.equal(exported.status, 200)
    assert.match(exported.headers.get('content-type')!, /spreadsheetml/)
    const workbook = new ExcelJS.Workbook()
    await workbook.xlsx.load(Buffer.from(await exported.arrayBuffer()))
    assert.equal(workbook.worksheets.length, 5)
    assert.equal(workbook.getWorksheet('Chi tiết kỳ thi')!.rowCount, 5, 'Excel chỉ chứa hai kỳ thi còn hiệu lực và hai học viên')
    assert.equal(workbook.getWorksheet('Điểm danh còn thiếu')!.rowCount, 3)
    const studentRows = workbook.getWorksheet('Điểm toàn khóa')!
    const paidRow = [...Array(studentRows.rowCount - 1)].map((_, index) => studentRows.getRow(index + 2)).find((row) => row.getCell(1).value === 'HV-ACADEMIC')!
    assert.equal(paidRow.getCell(5).value, 5)
    await request(`/teacher/sessions/${sessionIds[1]}/attendance`, teacher, 'PUT', { items: [{ enrollmentId: enrollmentIds[0], status: 'di_muon' }, { enrollmentId: enrollmentIds[1], status: 'vang' }] })
    // Extra canceled fixture tests attendance exclusion; normal makeup reuses one of the two planned rows.
    await connection.execute('DELETE FROM buoi_hoc WHERE id = ? AND lop_hoc_id = ?', [sessionIds[2], classId])
    await request(`/classes/${classId}/complete`, admin, 'POST')
    const report = await request('/reports?period=year&year=2026', admin)
    assert.equal(Number(report.classPerformance.find((item: any) => item.id === classId).passed), 1, 'Kỳ thi hủy không làm học viên đủ điểm thành chờ kết quả')
    assert.equal((await request('/certificates/candidates', admin)).find((item: any) => item.enrollmentId === enrollmentIds[0]).requiredExams, 2)
    await request('/certificates/approve', admin, 'POST', { enrollmentIds: [enrollmentIds[0]] }, 201)
    await request(`/exams/${first.id}/cancel`, admin, 'POST', { reason: 'Không được hủy kỳ thi lớp đã chốt chứng chỉ' }, 409)
    await request(`/exams/${first.id}`, admin, 'PATCH', { deadline: future(4), reason: 'Không được phép sau chốt' }, 409)
    await request('/exams', admin, 'POST', { classId, name: 'Thi 3', reason: 'Không được phép sau chốt' }, 409)
    await request(`/teacher/classes/${classId}/exams`, teacher, 'POST', { name: 'Thi 3' }, 409)
    const locked = await request(`/classes/${classId}/academic`, admin)
    assert.equal(locked.class.certificateLocked, true)
    assert.equal(locked.exams.every((item: any) => item.certificateLocked), true)
    const [saved] = await connection.query<RowDataPacket[]>('SELECT COUNT(*) AS total FROM ket_qua_thi WHERE ghi_danh_id = ?', [enrollmentIds[1]])
    assert.equal(Number(saved[0].total), 0)
  } finally {
    await closeServer?.()
    await closePool?.()
    await connection.query(`DROP DATABASE IF EXISTS ${isolatedDatabase}`)
    await connection.end()
  }
})
