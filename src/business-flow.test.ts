import 'dotenv/config'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { readFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import test from 'node:test'
import mysql, { type ResultSetHeader, type RowDataPacket } from 'mysql2/promise'
import bcrypt from 'bcryptjs'

test('luồng ghi danh → buổi học → chuyên cần → điểm → học phí → chứng chỉ trên MySQL riêng', {
  skip: process.env.RUN_BUSINESS_INTEGRATION !== '1', timeout: 60000,
}, async () => {
  const testDatabase = `doan4_test_${randomBytes(6).toString('hex')}`
  assert.match(testDatabase, /^doan4_test_[a-f0-9]{12}$/)
  const connection = await mysql.createConnection({ host: process.env.DB_HOST ?? '127.0.0.1',
    port: Number(process.env.DB_PORT ?? 3306), user: process.env.DB_USER ?? 'root', password: process.env.DB_PASSWORD ?? '',
    multipleStatements: true, dateStrings: true })
  const tempRoot = resolve(tmpdir())
  const storage = await mkdtemp(join(tempRoot, 'doan4-business-'))
  process.env.DB_NAME = testDatabase
  process.env.STORAGE_DIR = storage
  let closeServer: (() => Promise<void>) | undefined
  let closePool: (() => Promise<void>) | undefined
  try {
    const schema = (await readFile(join(process.cwd(), 'database/schema.sql'), 'utf8')).replace(/\bdoan4\b/g, testDatabase)
    await connection.query(schema)
    const { app } = await import('./app')
    const { database } = await import('./config/database')
    closePool = () => database.end()
    const server = app.listen(0, '127.0.0.1')
    await new Promise<void>((resolve, reject) => { server.once('listening', resolve); server.once('error', reject) })
    closeServer = () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
    const address = server.address()
    assert.ok(address && typeof address !== 'string')
    const base = `http://127.0.0.1:${address.port}`
    async function request(path: string, method = 'GET', token?: string, body?: unknown, status = 200) {
      const response = await fetch(`${base}/api${path}`, { method,
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      })
      const result = await response.json() as { data: Record<string, any>; message?: string }
      assert.equal(response.status, status, `${method} ${path}: ${JSON.stringify(result)}`)
      return result.data
    }
    async function insert(sql: string, values: Array<string | number>) {
      const [result] = await connection.execute<ResultSetHeader>(sql, values)
      return result.insertId
    }
    const hash = await bcrypt.hash('Test-password-123', 4)
    const users = []
    for (const [code, name, role] of [['QT-TEST', 'Quản trị kiểm thử', 'quan_tri'], ['GV-TEST', 'Giáo viên kiểm thử', 'giao_vien'], ['HV-TEST', 'Học viên gốc', 'hoc_vien'], ['HV-TEST2', 'Học viên mới', 'hoc_vien'], ['GV-TEST2', 'Giáo viên thứ hai', 'giao_vien']]) {
      users.push(await insert('INSERT INTO nguoi_dung (ma_nguoi_dung, ho_ten, email, mat_khau_bam, vai_tro) VALUES (?, ?, ?, ?, ?)',
        [code, name, `${code}@example.test`, hash, role]))
    }
    const [admin, teacher, student] = await Promise.all(['QT-TEST', 'GV-TEST', 'HV-TEST'].map(async (account) =>
      String((await request('/auth/login', 'POST', undefined, { account, password: 'Test-password-123' })).token)))
    const course = await request('/courses', 'POST', admin,
      { code: 'TEST-A1', name: 'Khóa học gốc', language: 'Tiếng Anh', level: 'A1', sessions: 2, tuition: 1000 }, 201)
    await request('/courses', 'POST', admin,
      { code: 'TEST-FREE', name: 'Không hỗ trợ', language: 'Tiếng Anh', level: 'A1', sessions: 2, tuition: 0 }, 400)
    const room = await request('/rooms', 'POST', admin, { code: 'TEST-P1', capacity: 30 }, 201)
    const future = new Date(Date.now() + 7 * 86400000)
    const startDate = `${future.getFullYear()}-${String(future.getMonth() + 1).padStart(2, '0')}-${String(future.getDate()).padStart(2, '0')}`
    const classes: Record<string, any>[] = []
    for (const code of ['TEST-C1', 'TEST-C2']) classes.push(await request('/classes', 'POST', admin,
      { code, name: code, courseId: course.id, teacherId: users[1], startDate, sessions: 2, capacity: 20 }, 201))
    const enrollment = await request('/enrollments', 'POST', admin, { studentId: users[2], courseId: course.id, classId: classes[0].id }, 201)
    const enrollmentId = Number(enrollment.id ?? enrollment.enrollmentId)
    assert.ok(enrollmentId > 0)
    await request(`/enrollments/${enrollmentId}`, 'PATCH', admin, { status: 'bao_luu' })
    let [rows] = await connection.query<RowDataPacket[]>('SELECT lop_hoc_id AS classId, trang_thai AS status FROM ghi_danh WHERE id = ?', [enrollmentId])
    assert.equal(rows[0].classId, null)
    assert.equal(rows[0].status, 'bao_luu')
    await request(`/enrollments/${enrollmentId}`, 'PATCH', admin, { status: 'dang_hoc', classId: classes[1].id })
    await request(`/enrollments/${enrollmentId}`, 'PATCH', admin, { classId: classes[0].id })
    const smallRoom = await request('/rooms', 'POST', admin, { code: 'TEST-SMALL', capacity: 10 }, 201)
    await request('/schedules', 'POST', admin, { classId: classes[0].id, roomId: smallRoom.id, dayOfWeek: future.getDay() + 1, startTime: '18:00', endTime: '19:00' }, 409)
    await request('/schedules', 'POST', admin, { classId: classes[0].id, roomId: room.id, dayOfWeek: future.getDay() + 1, startTime: '18:00', endTime: '19:00' }, 201)
    await request('/schedules', 'POST', admin, { classId: classes[1].id, roomId: room.id, dayOfWeek: future.getDay() + 1, startTime: '18:30', endTime: '19:30' }, 409)
    const otherCourse = await request('/courses', 'POST', admin, { code: 'TEST-JP', name: 'Tiếng Nhật', language: 'Tiếng Nhật', level: 'N5', sessions: 2, tuition: 1000 }, 201)
    const otherRoom = await request('/rooms', 'POST', admin, { code: 'TEST-P2', capacity: 30 }, 201)
    const otherClass = await request('/classes', 'POST', admin, { code: 'TEST-JP1', name: 'Tiếng Nhật', courseId: otherCourse.id, teacherId: users[4], startDate, sessions: 2, capacity: 20 }, 201)
    await request('/schedules', 'POST', admin, { classId: otherClass.id, roomId: otherRoom.id, dayOfWeek: future.getDay() + 1, startTime: '18:30', endTime: '19:30' }, 201)
    await request('/enrollments', 'POST', admin, { studentId: users[2], courseId: otherCourse.id, classId: otherClass.id }, 409)
    const generated = await Promise.all([0, 1].map(() => fetch(`${base}/api/classes/${classes[0].id}/generate-sessions`, { method: 'POST', headers: { Authorization: `Bearer ${admin}` } })))
    assert.deepEqual(generated.map((response) => response.status).sort(), [201, 409])
    ;[rows] = await connection.query<RowDataPacket[]>('SELECT id FROM buoi_hoc WHERE lop_hoc_id = ? ORDER BY id', [classes[0].id])
    assert.equal(rows.length, 2)
    const sessionIds = rows.map((row) => Number(row.id))
    await request(`/sessions/${sessionIds[0]}/cancel`, 'POST', admin, { reason: 'Nghỉ đột xuất, cần xếp học bù' })
    await request(`/classes/${classes[0].id}/start`, 'POST', admin, undefined, 409)
    await request(`/sessions/${sessionIds[0]}`, 'PATCH', admin, { date: startDate, startTime: '18:00', endTime: '19:00', teacherId: users[1], roomId: room.id, reason: 'Xếp lại buổi học bù' })
    // Move only isolated test fixtures into the past; never rewrite the real doan4 data.
    await connection.execute("UPDATE buoi_hoc SET bat_dau = DATE_SUB(NOW(), INTERVAL 2 DAY), ket_thuc = DATE_SUB(NOW(), INTERVAL 47 HOUR) WHERE id = ?", [sessionIds[0]])
    await connection.execute("UPDATE buoi_hoc SET bat_dau = DATE_SUB(NOW(), INTERVAL 1 DAY), ket_thuc = DATE_SUB(NOW(), INTERVAL 23 HOUR) WHERE id = ?", [sessionIds[1]])
    await connection.execute("UPDATE lop_hoc SET trang_thai = 'dang_hoc' WHERE id = ?", [classes[0].id])
    await request(`/enrollments/${enrollmentId}`, 'PATCH', admin, { classId: classes[1].id }, 409)
    await request(`/enrollments/${enrollmentId}`, 'PATCH', admin, { status: 'bao_luu' }, 409)
    await request('/enrollments', 'POST', admin, { studentId: users[3], courseId: course.id, classId: classes[0].id }, 409)
    await request('/enrollments/import/confirm', 'POST', admin, { courseId: course.id, classId: classes[0].id,
      rows: [{ fullName: 'Học viên import', email: 'import@example.test', phone: '0912345678' }] }, 409)
    ;[rows] = await connection.query<RowDataPacket[]>('SELECT COUNT(*) AS total FROM nguoi_dung WHERE email = ?', ['import@example.test'])
    assert.equal(Number(rows[0].total), 0)
    await request(`/classes/${classes[0].id}/complete`, 'POST', admin, undefined, 409)
    await request(`/teacher/sessions/${sessionIds[0]}/attendance`, 'PUT', teacher, { items: [{ enrollmentId, status: 'co_mat', note: '' }] })
    let eligibility = await request('/student/certificate-eligibility', 'GET', student)
    assert.equal(Number(eligibility[0].attendance), 50)
    assert.equal(Number(eligibility[0].expectedAttendance), 2)
    assert.equal(Number(eligibility[0].recordedAttendance), 1)
    assert.equal(eligibility[0].eligible, false)
    await request(`/teacher/sessions/${sessionIds[1]}/attendance`, 'PUT', teacher, { items: [{ enrollmentId, status: 'co_mat', note: '' }] })
    await request(`/classes/${classes[0].id}/complete`, 'POST', admin)
    const invoices = await request('/invoices', 'GET', admin)
    const originalInvoice = invoices.find((item: any) => Number(item.enrollmentId) === enrollmentId)
    await request(`/invoices/${originalInvoice.id}/cancel`, 'PATCH', admin, { reason: 'Thay hạn thanh toán' })
    await request(`/courses/${course.id}`, 'PATCH', admin, { tuition: 2000 })
    await request('/invoices', 'POST', admin, { enrollmentId, dueDate: startDate, amount: 500 }, 400)
    const invoice = await request('/invoices', 'POST', admin, { enrollmentId, dueDate: startDate }, 201)
    assert.equal(Number(invoice.amount), 1000)
    await request(`/invoices/${invoice.id}/payment`, 'PATCH', admin, { method: 'tien_mat' })
    await request(`/invoices/${invoice.id}/cancel`, 'PATCH', admin, { reason: 'Không hỗ trợ hoàn tiền' }, 409)
    const exams = []
    for (const name of ['Giữa khóa', 'Cuối khóa']) exams.push(await request(`/teacher/classes/${classes[0].id}/exams`, 'POST', teacher, { name }, 201))
    const grade = (listening: number | null, speaking: number | null, reading: number | null, writing: number | null) => ({ items: [{ enrollmentId, listening, speaking, reading, writing }] })
    await request(`/teacher/exams/${exams[0].id}/results`, 'PUT', teacher, grade(8, 8, 8, 8))
    await request(`/teacher/exams/${exams[1].id}/results`, 'PUT', teacher, grade(0, null, 8, null))
    const draft = await request(`/teacher/exams/${exams[1].id}/results`, 'GET', teacher)
    assert.equal(draft.students[0].listening, 0)
    assert.equal(draft.students[0].speaking, null)
    assert.equal(draft.students[0].average, null)
    await request('/certificates/approve', 'POST', admin, { enrollmentIds: [enrollmentId] }, 409)
    await connection.execute('UPDATE ky_thi SET han_sua_diem = DATE_SUB(NOW(), INTERVAL 1 MINUTE) WHERE id = ?', [exams[1].id])
    await request(`/teacher/exams/${exams[1].id}/results`, 'PUT', teacher, grade(0, 8, 8, 8), 409)
    await connection.execute('UPDATE ky_thi SET han_sua_diem = NULL WHERE id = ?', [exams[1].id])
    await request(`/teacher/exams/${exams[1].id}/results`, 'PUT', teacher, grade(0, 8, 8, 8))
    await request('/certificates/approve', 'POST', admin, { enrollmentIds: [enrollmentId] }, 201)
    const candidates = await request('/certificates/candidates', 'GET', admin)
    const certificate = candidates.find((item: any) => Number(item.enrollmentId) === enrollmentId)
    assert.equal(Number(certificate.average), 7)
    await request(`/teacher/classes/${classes[0].id}/exams`, 'POST', teacher, { name: 'Không được thêm sau duyệt' }, 409)
    await request(`/teacher/exams/${exams[0].id}/results`, 'PUT', teacher, grade(1, 1, 1, 1), 409)
    await request(`/teacher/sessions/${sessionIds[0]}/attendance`, 'PUT', teacher, { items: [{ enrollmentId, status: 'vang' }] }, 409)
    await request(`/users/${users[2]}`, 'PATCH', admin, { fullName: 'Tên hồ sơ hiện tại đã đổi' })
    await request(`/courses/${course.id}`, 'PATCH', admin, { name: 'Khóa học hiện tại đã đổi' })
    const correction = { studentCode: 'HV-TEST', studentName: 'Học viên đính chính', courseName: 'Khóa học gốc', language: 'Tiếng Anh', classCode: 'TEST-C1', className: 'TEST-C1', reason: 'Sửa lỗi chính tả trước phát hành' }
    await request(`/certificates/${certificate.certificateId}/details`, 'PATCH', admin, correction)
    const issued = await request(`/certificates/${certificate.certificateId}/issue`, 'PATCH', admin)
    const verified = await request(`/certificates/verify/${issued.verificationCode}`)
    assert.equal(verified.studentName, correction.studentName)
    assert.equal(verified.courseName, 'Khóa học gốc')
    const pdf = await fetch(`${base}${new URL(issued.pdfPath).pathname}`)
    assert.equal(pdf.status, 200)
    assert.equal(Buffer.from(await pdf.arrayBuffer()).subarray(0, 4).toString(), '%PDF')
    const reissued = await request(`/certificates/${certificate.certificateId}/reissue`, 'POST', admin)
    assert.equal(reissued.verificationCode, issued.verificationCode)
    assert.equal(reissued.code, issued.code)
    const verifiedAgain = await request(`/certificates/verify/${issued.verificationCode}`)
    assert.deepEqual(verifiedAgain, verified)
    await request(`/certificates/${certificate.certificateId}/details`, 'PATCH', admin, correction, 409)
    const certificates = await request('/student/certificates', 'GET', student)
    assert.equal(Number(certificates[0].average), 7)
    assert.equal(certificates[0].courseName, 'Khóa học gốc')
    eligibility = await request('/student/certificate-eligibility', 'GET', student)
    assert.equal(eligibility[0].certificateStatus, 'da_cap')
    assert.equal(Number(eligibility[0].attendance), 100)
    ;[rows] = await connection.query<RowDataPacket[]>('SELECT ho_so_luc_duyet AS snapshot FROM chung_chi WHERE id = ?', [certificate.certificateId])
    const snapshot = typeof rows[0].snapshot === 'string' ? JSON.parse(rows[0].snapshot) : rows[0].snapshot
    assert.equal(snapshot.corrections.length, 1)
    assert.equal(snapshot.average, 7)
  } finally {
    await closeServer?.()
    await closePool?.()
    await connection.query(`DROP DATABASE IF EXISTS \`${testDatabase}\``)
    await connection.end()
    assert.equal(dirname(storage), tempRoot)
    assert.match(basename(storage), /^doan4-business-[a-z0-9]+$/i)
    await rm(storage, { recursive: true, force: true })
  }
})
