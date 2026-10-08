import 'dotenv/config'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import jwt from 'jsonwebtoken'
import mysql, { type ResultSetHeader, type RowDataPacket } from 'mysql2/promise'

test('điểm nháp trống không sinh lịch sử; xóa điểm cũ, khóa chứng chỉ và điểm sát ngưỡng giữ đúng nghĩa', {
  skip: process.env.RUN_GRADE_INTEGRATION !== '1', timeout: 60000,
}, async () => {
  const isolatedDatabase = `doan4_grade_test_${randomBytes(6).toString('hex')}`
  assert.match(isolatedDatabase, /^doan4_grade_test_[a-f0-9]{12}$/)
  const connection = await mysql.createConnection({ host: process.env.DB_HOST ?? '127.0.0.1', port: Number(process.env.DB_PORT ?? 3306),
    user: process.env.DB_USER ?? 'root', password: process.env.DB_PASSWORD ?? '', multipleStatements: true, dateStrings: true })
  process.env.DB_NAME = isolatedDatabase
  process.env.SMTP_USER = ''
  process.env.SMTP_PASSWORD = ''
  let closeServer: (() => Promise<void>) | undefined
  let closePool: (() => Promise<void>) | undefined
  try {
    await connection.query((await readFile(join(process.cwd(), 'database/schema.sql'), 'utf8')).replace(/\bdoan4\b/g, isolatedDatabase))
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
    async function request(path: string, token: string, method = 'GET', body?: unknown, status = 200): Promise<any> {
      const response = await fetch(`${base}${path}`, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
      const result = await response.json() as { data: unknown; message?: string }
      assert.equal(response.status, status, `${method} ${path}: ${JSON.stringify(result)}`)
      return result.data
    }
    async function insert(sql: string, values: Array<string | number | null>) {
      const [result] = await connection.execute<ResultSetHeader>(sql, values)
      return result.insertId
    }
    const users: number[] = []
    for (const [code, role] of [['QT-GRADE', 'quan_tri'], ['GV-GRADE', 'giao_vien'], ['HV-GRADE', 'hoc_vien']]) {
      users.push(await insert('INSERT INTO nguoi_dung (ma_nguoi_dung, ho_ten, email, mat_khau_bam, vai_tro) VALUES (?, ?, ?, ?, ?)',
        [code, code, `${code}@example.test`, 'unused-password-hash', role]))
    }
    const token = (id: number, role: string) => jwt.sign({ role, ver: 0 }, env.jwtSecret, { subject: String(id), expiresIn: '5m' })
    const admin = token(users[0], 'quan_tri'), teacher = token(users[1], 'giao_vien'), student = token(users[2], 'hoc_vien')
    const courseId = await insert('INSERT INTO khoa_hoc (ma_khoa_hoc, ten_khoa_hoc, ngoai_ngu, trinh_do, so_buoi, hoc_phi) VALUES (?, ?, ?, ?, ?, ?)',
      ['GRADE-A1', 'Khóa kiểm thử điểm', 'Tiếng Anh', 'A1', 1, 1000])
    const classId = await insert(`INSERT INTO lop_hoc (ma_lop, ten_lop, khoa_hoc_id, giao_vien_id, ngay_khai_giang, so_buoi, si_so_toi_da)
      VALUES (?, ?, ?, ?, DATE_ADD(CURDATE(), INTERVAL 10 DAY), 1, 20)`, ['GRADE-C1', 'Lớp kiểm thử điểm', courseId, users[1]])
    const enrollmentId = await insert(`INSERT INTO ghi_danh (hoc_vien_id, khoa_hoc_id, lop_hoc_id, ngay_ghi_danh, trang_thai)
      VALUES (?, ?, ?, CURDATE(), 'dang_hoc')`, [users[2], courseId, classId])
    await insert(`INSERT INTO hoa_don (ma_hoa_don, ghi_danh_id, so_tien, ngay_lap, han_thanh_toan, trang_thai, ngay_thanh_toan, phuong_thuc)
      VALUES (?, ?, 1000, CURDATE(), CURDATE(), 'da_thanh_toan', NOW(), 'tien_mat')`, ['GRADE-HD1', enrollmentId])
    const exam = await request(`/teacher/classes/${classId}/exams`, teacher, 'POST', { name: 'Thi kiểm thử' }, 201)
    const save = (listening: number | null, speaking: number | null, reading: number | null, writing: number | null, status = 200) =>
      request(`/teacher/exams/${exam.id}/results`, teacher, 'PUT', { items: [{ enrollmentId, listening, speaking, reading, writing }] }, status)
    const resultRows = async () => (await connection.query<RowDataPacket[]>('SELECT * FROM ket_qua_thi WHERE ghi_danh_id = ?', [enrollmentId]))[0]

    assert.equal((await save(null, null, null, null)).saved, 0)
    assert.equal((await resultRows()).length, 0, 'Không tạo lịch sử khi chưa nhập điểm nào')
    const enrollment = (await request('/enrollments', admin)).find((item: any) => item.id === enrollmentId)
    assert.equal(Number(enrollment.canChangeClass), 1, 'Bản nháp trống không khóa chuyển lớp/bảo lưu trước khi học')
    await save(0, null, null, null)
    assert.equal((await resultRows()).length, 1, 'Điểm 0 thật vẫn được lưu')
    assert.equal((await request('/student/results', student)).exams[0].average, null)
    await save(0, 0, 0, 0)
    assert.equal((await request('/student/results', student)).exams[0].average, 0)
    await save(4.99, 5, 5, 5)
    const borderline = (await request('/student/results', student)).exams[0].average
    assert.equal(borderline, 4.9975, 'Không làm tròn kỳ thi chưa đạt thành 5')
    assert.ok(borderline < 5)
    assert.equal((await request(`/teacher/exams/${exam.id}/results`, teacher)).students[0].average, borderline)
    assert.ok((await request('/student/certificate-eligibility', student))[0].average < 5)

    const resultId = (await resultRows())[0].id
    assert.equal((await save(null, null, null, null)).saved, 1)
    const cleared = await resultRows()
    assert.equal(cleared[0].id, resultId, 'Xóa hết điểm phải cập nhật dòng đã tồn tại')
    for (const skill of ['nghe', 'noi', 'doc', 'viet']) assert.equal(cleared[0][skill], null)
    await save(8, 8, 8, 8)
    await insert(`INSERT INTO chung_chi (ghi_danh_id, nguoi_duyet_id, ma_hoc_vien_luc_cap, ten_hoc_vien_luc_cap,
      ten_khoa_hoc_luc_cap, ngoai_ngu_luc_cap, ma_lop_luc_cap, ten_lop_luc_cap, ho_so_luc_duyet)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, [enrollmentId, users[0], 'HV-GRADE', 'HV-GRADE', 'Khóa kiểm thử điểm', 'Tiếng Anh', 'GRADE-C1', 'Lớp kiểm thử điểm', '{}'])
    await save(null, null, null, null, 409)
    assert.equal(Number((await resultRows())[0].nghe), 8, 'Không xóa được điểm của hồ sơ chứng chỉ đã chốt')
  } finally {
    await closeServer?.()
    await closePool?.()
    await connection.query(`DROP DATABASE IF EXISTS ${isolatedDatabase}`)
    await connection.end()
  }
})
