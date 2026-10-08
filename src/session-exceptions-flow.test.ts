import 'dotenv/config'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import bcrypt from 'bcryptjs'
import mysql, { type ResultSetHeader, type RowDataPacket } from 'mysql2/promise'

test('ngoại lệ buổi học trên MySQL riêng: bổ sung thiếu, hủy buổi nghỉ, học bù, audit và bàn giao giáo viên', {
  skip: process.env.RUN_SESSION_EXCEPTIONS_INTEGRATION !== '1', timeout: 60000,
}, async () => {
  const isolatedDatabase = `doan4_session_test_${randomBytes(6).toString('hex')}`
  assert.match(isolatedDatabase, /^doan4_session_test_[a-f0-9]{12}$/)
  const connection = await mysql.createConnection({ host: process.env.DB_HOST ?? '127.0.0.1', port: Number(process.env.DB_PORT ?? 3306),
    user: process.env.DB_USER ?? 'root', password: process.env.DB_PASSWORD ?? '', multipleStatements: true, dateStrings: true })
  process.env.DB_NAME = isolatedDatabase
  process.env.SMTP_USER = ''; process.env.SMTP_PASSWORD = ''
  let closeServer: (() => Promise<void>) | undefined
  let closePool: (() => Promise<void>) | undefined
  try {
    await connection.query((await readFile(join(process.cwd(), 'database/schema.sql'), 'utf8')).replace(/\bdoan4\b/g, isolatedDatabase))
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
      const result = await response.json() as { data?: unknown; message?: string; code?: string }
      assert.equal(response.status, status, `${method} ${path}: ${JSON.stringify(result)}`)
      return result.data ?? result
    }
    async function insert(sql: string, values: Array<string | number | null> = []) {
      const [result] = await connection.execute<ResultSetHeader>(sql, values)
      return result.insertId
    }
    const hash = await bcrypt.hash('Session-test-password-123', 4)
    const users: number[] = []
    for (const [code, role] of [['QT-SESSION', 'quan_tri'], ['GV-SESSION', 'giao_vien'], ['GV-SESSION2', 'giao_vien'],
      ['HV-SESSION', 'hoc_vien'], ['HV-SESSION2', 'hoc_vien'], ['HV-SESSION3', 'hoc_vien']]) {
      users.push(await insert('INSERT INTO nguoi_dung (ma_nguoi_dung, ho_ten, email, mat_khau_bam, vai_tro) VALUES (?, ?, ?, ?, ?)',
        [code, code, `${code}@example.test`, hash, role]))
    }
    const [admin, teacher, student] = await Promise.all(['QT-SESSION', 'GV-SESSION', 'HV-SESSION'].map(async (account) =>
      String((await request('/auth/login', undefined, 'POST', { account, password: 'Session-test-password-123' })).token)))
    const courseId = await insert(`INSERT INTO khoa_hoc (ma_khoa_hoc, ten_khoa_hoc, ngoai_ngu, trinh_do, so_buoi, hoc_phi)
      VALUES ('SESSION-A1', 'Khóa kiểm thử', 'Tiếng Anh', 'A1', 3, 1000)`)
    const roomId = await insert("INSERT INTO phong_hoc (ma_phong, suc_chua) VALUES ('SESSION-P1', 30)")
    const otherRoomId = await insert("INSERT INTO phong_hoc (ma_phong, suc_chua) VALUES ('SESSION-P2', 30)")
    const classId = await insert(`INSERT INTO lop_hoc (ma_lop, ten_lop, khoa_hoc_id, giao_vien_id, ngay_khai_giang, so_buoi, si_so_toi_da, trang_thai)
      VALUES ('SESSION-C1', 'Lớp xử lý ngoại lệ', ?, ?, CURDATE(), 3, 20, 'dang_hoc')`, [courseId, users[1]])
    const otherClassId = await insert(`INSERT INTO lop_hoc (ma_lop, ten_lop, khoa_hoc_id, giao_vien_id, ngay_khai_giang, so_buoi, si_so_toi_da, trang_thai)
      VALUES ('SESSION-C2', 'Lớp khóa hồ sơ', ?, ?, CURDATE(), 1, 20, 'dang_hoc')`, [courseId, users[2]])
    const enrollmentIds: number[] = []
    for (const userId of [users[3], users[4]]) enrollmentIds.push(await insert(`INSERT INTO ghi_danh
      (hoc_vien_id, khoa_hoc_id, lop_hoc_id, ngay_ghi_danh, trang_thai) VALUES (?, ?, ?, CURDATE(), 'dang_hoc')`, [userId, courseId, classId]))
    const outsiderEnrollment = await insert(`INSERT INTO ghi_danh
      (hoc_vien_id, khoa_hoc_id, lop_hoc_id, ngay_ghi_danh, trang_thai) VALUES (?, ?, ?, CURDATE(), 'dang_hoc')`, [users[5], courseId, otherClassId])
    const pastEmpty = await insert(`INSERT INTO buoi_hoc (lop_hoc_id, giao_vien_id, phong_hoc_id, bat_dau, ket_thuc)
      VALUES (?, ?, ?, DATE_SUB(NOW(), INTERVAL 3 DAY), DATE_ADD(DATE_SUB(NOW(), INTERVAL 3 DAY), INTERVAL 1 HOUR))`, [classId, users[1], roomId])
    const pastPartial = await insert(`INSERT INTO buoi_hoc (lop_hoc_id, giao_vien_id, phong_hoc_id, bat_dau, ket_thuc)
      VALUES (?, ?, ?, DATE_SUB(NOW(), INTERVAL 2 DAY), DATE_ADD(DATE_SUB(NOW(), INTERVAL 2 DAY), INTERVAL 1 HOUR))`, [classId, users[1], roomId])
    const future = await insert(`INSERT INTO buoi_hoc (lop_hoc_id, giao_vien_id, phong_hoc_id, bat_dau, ket_thuc)
      VALUES (?, ?, ?, DATE_ADD(NOW(), INTERVAL 2 DAY), DATE_ADD(DATE_ADD(NOW(), INTERVAL 2 DAY), INTERVAL 1 HOUR))`, [classId, users[1], roomId])
    const canceled = await insert(`INSERT INTO buoi_hoc (lop_hoc_id, giao_vien_id, phong_hoc_id, bat_dau, ket_thuc, trang_thai)
      VALUES (?, ?, ?, DATE_SUB(NOW(), INTERVAL 1 DAY), DATE_ADD(DATE_SUB(NOW(), INTERVAL 1 DAY), INTERVAL 1 HOUR), 'da_huy')`, [classId, users[1], roomId])
    const originalMarkId = await insert(`INSERT INTO diem_danh (buoi_hoc_id, ghi_danh_id, trang_thai, ghi_chu)
      VALUES (?, ?, 'co_mat', 'Giáo viên đã ghi')`, [pastPartial, enrollmentIds[0]])
    const originalMark = (await connection.query<RowDataPacket[]>('SELECT * FROM diem_danh WHERE id = ?', [originalMarkId]))[0][0]
    const originalSession = (await connection.query<RowDataPacket[]>('SELECT * FROM buoi_hoc WHERE id = ?', [pastPartial]))[0][0]
    const body = { reason: 'Bàn giao điểm danh giáo viên nghỉ việc', items: [{ enrollmentId: enrollmentIds[1], status: 'di_muon', note: 'Đã xác nhận với lớp' }] }
    await request(`/sessions/${pastPartial}/attendance`, undefined, 'GET', undefined, 401)
    await request(`/sessions/${pastPartial}/attendance`, teacher, 'PUT', body, 403)
    await request(`/sessions/${pastPartial}/history`, student, 'GET', undefined, 403)
    const roster = await request(`/sessions/${pastPartial}/attendance`, admin)
    assert.equal(roster.students.length, 2)
    assert.equal(roster.students.find((row: any) => row.enrollmentId === enrollmentIds[0]).status, 'co_mat')
    assert.equal(roster.students.find((row: any) => row.enrollmentId === enrollmentIds[1]).status, null)
    for (const sessionId of [future, canceled]) {
      await request(`/sessions/${sessionId}/attendance`, admin, 'GET', undefined, 409)
      await request(`/sessions/${sessionId}/attendance`, admin, 'PUT', body, 409)
    }
    await request('/sessions/not-an-id/attendance', admin, 'GET', undefined, 400)
    await request(`/users/not-an-id/status`, admin, 'PATCH', { active: false }, 400)
    const forcedLock = await request(`/users/${users[1]}/status?force=true`, admin, 'PATCH', { active: false }, 409)
    assert.equal(forcedLock.code, 'ATTENDANCE_BACKLOG')
    assert.equal((await connection.query<RowDataPacket[]>('SELECT dang_hoat_dong AS active FROM nguoi_dung WHERE id = ?', [users[1]]))[0][0].active, 1)
    for (const invalidReason of [undefined, '', ' ', 'x'.repeat(256)]) await request(`/sessions/${pastPartial}/attendance`, admin, 'PUT', { ...body, reason: invalidReason }, 400)
    await request(`/sessions/${pastPartial}/attendance`, admin, 'PUT', { ...body, items: [{ enrollmentId: enrollmentIds[0], status: 'vang' }] }, 409)
    for (const invalidItems of [
      [{ enrollmentId: outsiderEnrollment, status: 'co_mat' }], [{ enrollmentId: true, status: 'co_mat' }],
      [{ enrollmentId: [enrollmentIds[1]], status: 'co_mat' }], [{ enrollmentId: enrollmentIds[1], status: ['co_mat'] }],
      [{ enrollmentId: enrollmentIds[1], status: 'co_mat', note: 'x'.repeat(256) }],
      [{ enrollmentId: enrollmentIds[1], status: 'co_mat' }, { enrollmentId: enrollmentIds[1], status: 'vang' }],
    ]) await request(`/sessions/${pastPartial}/attendance`, admin, 'PUT', { ...body, items: invalidItems }, 400)
    assert.equal((await connection.query<RowDataPacket[]>('SELECT COUNT(*) AS total FROM diem_danh WHERE buoi_hoc_id = ?', [pastPartial]))[0][0].total, 1, 'Validation failure rolls back every partial insert')
    assert.deepEqual(await request(`/sessions/${pastPartial}/attendance`, admin, 'PUT', body), { saved: 1, remaining: 0 })
    assert.deepEqual((await connection.query<RowDataPacket[]>('SELECT * FROM diem_danh WHERE id = ?', [originalMarkId]))[0][0], originalMark)
    const updatedSession = (await connection.query<RowDataPacket[]>('SELECT * FROM buoi_hoc WHERE id = ?', [pastPartial]))[0][0]
    for (const field of ['giao_vien_id', 'phong_hoc_id', 'bat_dau', 'ket_thuc']) assert.equal(updatedSession[field], originalSession[field])
    assert.equal(updatedSession.trang_thai, 'da_hoc')
    const attendanceHistory = await request(`/sessions/${pastPartial}/history`, admin)
    assert.equal(attendanceHistory.length, 1); assert.equal(attendanceHistory[0].action, 'bo_sung_diem_danh')
    assert.equal(attendanceHistory[0].before.items.length, 1); assert.equal(attendanceHistory[0].after.items.length, 2)
    assert.equal(attendanceHistory[0].actorName, 'QT-SESSION')
    await request(`/sessions/${pastPartial}/cancel`, admin, 'POST', { reason: 'Không được hủy lịch sử có điểm danh' }, 409)
    await request(`/sessions/${pastEmpty}/cancel`, admin, 'POST', undefined, 400)
    await request(`/sessions/${pastEmpty}/cancel`, admin, 'POST', { reason: 'x'.repeat(256) }, 400)
    await connection.execute('UPDATE phong_hoc SET suc_chua = 1 WHERE id = ?', [roomId])
    await request(`/sessions/${pastEmpty}/cancel`, admin, 'POST', { reason: 'Trung tâm đã nghỉ đột xuất, ghi nhận muộn' })
    const cancelHistory = await request(`/sessions/${pastEmpty}/history`, admin)
    assert.equal(cancelHistory[0].before.status, 'da_len_lich'); assert.equal(cancelHistory[0].after.status, 'da_huy')
    await request(`/sessions/${pastEmpty}/cancel`, admin, 'POST', { reason: 'Hủy lại' }, 409)
    await request(`/users/${users[1]}/status`, admin, 'PATCH', { active: false }, 409)
    await request(`/users/${users[1]}/status?force=true`, admin, 'PATCH', { active: false })
    assert.equal((await request('/users?role=giao_vien', admin)).find((row: any) => row.id === users[1]).active, 0)
    await request('/teacher/dashboard', teacher, 'GET', undefined, 401)
    const futureDate = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Bangkok', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(Date.now() + 10 * 86400000))
    const makeup = { date: futureDate, startTime: '18:00', endTime: '19:30', teacherId: users[2], roomId, reason: 'Lên lịch bù cho buổi nghỉ, giáo viên mới' }
    await request(`/sessions/${pastEmpty}`, admin, 'PATCH', makeup, 409)
    await request(`/sessions/${pastEmpty}`, admin, 'PATCH', { ...makeup, roomId: otherRoomId, reason: undefined }, 400)
    await request(`/sessions/${pastEmpty}`, admin, 'PATCH', { ...makeup, roomId: otherRoomId, teacherId: [users[2]] }, 400)
    await request(`/sessions/${pastEmpty}`, admin, 'PATCH', { ...makeup, roomId: otherRoomId })
    const makeupHistory = await request(`/sessions/${pastEmpty}/history`, admin)
    assert.deepEqual(makeupHistory.map((row: any) => row.action), ['cap_nhat', 'huy'])
    assert.equal(makeupHistory[0].before.startsAt, cancelHistory[0].before.startsAt)
    assert.equal(makeupHistory[0].after.teacherId, users[2]); assert.equal(makeupHistory[0].after.roomId, otherRoomId)
    const certifiedSession = await insert(`INSERT INTO buoi_hoc (lop_hoc_id, giao_vien_id, phong_hoc_id, bat_dau, ket_thuc)
      VALUES (?, ?, ?, DATE_SUB(NOW(), INTERVAL 1 DAY), NOW())`, [otherClassId, users[2], otherRoomId])
    await insert(`INSERT INTO chung_chi (ghi_danh_id, nguoi_duyet_id, ma_hoc_vien_luc_cap, ten_hoc_vien_luc_cap,
      ten_khoa_hoc_luc_cap, ngoai_ngu_luc_cap, ma_lop_luc_cap, ten_lop_luc_cap, ho_so_luc_duyet)
      VALUES (?, ?, 'HV-SESSION3', 'HV-SESSION3', 'Khóa kiểm thử', 'Tiếng Anh', 'SESSION-C2', 'Lớp khóa hồ sơ', '{}')`, [outsiderEnrollment, users[0]])
    await request(`/sessions/${certifiedSession}/attendance`, admin, 'PUT', { reason: 'Không được sửa hồ sơ đã duyệt', items: [{ enrollmentId: outsiderEnrollment, status: 'co_mat' }] }, 409)
    await request(`/sessions/${certifiedSession}/cancel`, admin, 'POST', { reason: 'Không được hủy nghĩa vụ đã chốt' }, 409)
    const frozenFuture = await insert(`INSERT INTO buoi_hoc (lop_hoc_id, giao_vien_id, phong_hoc_id, bat_dau, ket_thuc)
      VALUES (?, ?, ?, DATE_ADD(NOW(), INTERVAL 5 DAY), DATE_ADD(DATE_ADD(NOW(), INTERVAL 5 DAY), INTERVAL 1 HOUR))`, [otherClassId, users[2], otherRoomId])
    await request(`/sessions/${frozenFuture}`, admin, 'PATCH', { ...makeup, roomId: otherRoomId }, 409)
    await connection.execute("UPDATE lop_hoc SET trang_thai = 'da_ket_thuc' WHERE id = ?", [classId])
    await request(`/sessions/${future}/cancel`, admin, 'POST', { reason: 'Không hủy lớp đã kết thúc' }, 409)
    assert.deepEqual(await request(`/sessions/${certifiedSession}/history`, admin), [], 'Rejected writes have no audit rows')
  } finally {
    await closeServer?.(); await closePool?.()
    await connection.query(`DROP DATABASE IF EXISTS ${isolatedDatabase}`)
    await connection.end()
  }
})
