import 'dotenv/config'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import mysql, { type ResultSetHeader, type RowDataPacket } from 'mysql2/promise'
import jwt from 'jsonwebtoken'

test('MySQL riêng: nhắc phí không trùng, thông báo phân trang, báo cáo và kiểm tra tệp chứng chỉ', {
  skip: process.env.RUN_FINANCE_INTEGRATION !== '1', timeout: 60000,
}, async () => {
  const dbName = `doan4_test_finance_${randomBytes(6).toString('hex')}`
  assert.match(dbName, /^doan4_test_finance_[a-f0-9]{12}$/)
  const connection = await mysql.createConnection({ host: process.env.DB_HOST ?? '127.0.0.1',
    port: Number(process.env.DB_PORT ?? 3306), user: process.env.DB_USER ?? 'root', password: process.env.DB_PASSWORD ?? '',
    multipleStatements: true, dateStrings: true })
  const storage = await mkdtemp(join(resolve(tmpdir()), 'doan4-finance-'))
  process.env.DB_NAME = dbName
  process.env.STORAGE_DIR = storage
  process.env.SMTP_HOST = ''
  let closeServer: (() => Promise<void>) | undefined
  let closePool: (() => Promise<void>) | undefined
  try {
    const schema = (await readFile(join(process.cwd(), 'database/schema.sql'), 'utf8')).replace(/\bdoan4\b/g, dbName)
    await connection.query(schema)
    const { app } = await import('../app')
    const { database } = await import('../config/database')
    const { env } = await import('../config/env')
    const { sendDueInvoiceReminders } = await import('./invoice-reminders')
    closePool = () => database.end()
    const server = app.listen(0, '127.0.0.1')
    await new Promise<void>((resolve, reject) => { server.once('listening', resolve); server.once('error', reject) })
    closeServer = () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
    const address = server.address()
    assert.ok(address && typeof address !== 'string')
    const base = `http://127.0.0.1:${address.port}/api`
    const { clientOrigins } = await import('../config/env')
    for (const origin of clientOrigins(env.clientUrl, env.nodeEnv)) {
      const response = await fetch(`${base}/health`, { headers: { Origin: origin } })
      assert.equal(response.headers.get('access-control-allow-origin'), origin)
    }
    const untrusted = await fetch(`${base}/health`, { headers: { Origin: 'https://untrusted.example' } })
    assert.equal(untrusted.headers.get('access-control-allow-origin'), null)
    async function insert(sql: string, params: Array<number | string>) {
      const [result] = await connection.execute<ResultSetHeader>(sql, params)
      return result.insertId
    }
    const adminId = await insert("INSERT INTO nguoi_dung (ma_nguoi_dung, ho_ten, email, google_sub, vai_tro) VALUES (?, ?, ?, 'google-qt-fin', 'quan_tri')", ['QT-FIN', 'Quản trị', 'qt-fin@example.test'])
    const studentId = await insert("INSERT INTO nguoi_dung (ma_nguoi_dung, ho_ten, email, google_sub, vai_tro) VALUES (?, ?, ?, 'google-hv-fin', 'hoc_vien')", ['HV-FIN', 'Học viên', 'hv-fin@example.test'])
    const token = (id: number, role: string) => jwt.sign({ sub: String(id), role, ver: 0 }, env.jwtSecret, { expiresIn: '5m' })
    const admin = token(adminId, 'quan_tri')
    const student = token(studentId, 'hoc_vien')
    async function request(path: string, roleToken: string, method = 'GET', body?: unknown, expected = 200) {
      const response = await fetch(`${base}${path}`, { method, headers: { Authorization: `Bearer ${roleToken}`, 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
      const result = await response.json() as { data: any; message?: string }
      assert.equal(response.status, expected, `${method} ${path}: ${JSON.stringify(result)}`)
      return result.data
    }
    const courseId = await insert('INSERT INTO khoa_hoc (ma_khoa_hoc,ten_khoa_hoc,ngoai_ngu,trinh_do,so_buoi,hoc_phi) VALUES (?, ?, ?, ?, ?, ?)',
      ['FIN-A1', 'Tiếng Anh', 'Tiếng Anh', 'A1', 2, 1000])
    const classId = await insert("INSERT INTO lop_hoc (ma_lop,ten_lop,khoa_hoc_id,ngay_khai_giang,so_buoi,si_so_toi_da,trang_thai) VALUES (?, ?, ?, CURDATE(), 2, 20, 'da_ket_thuc')", ['FIN-C1', 'Lớp tài chính', courseId])
    const enrollments = []
    for (const status of ['hoan_thanh', 'bao_luu', 'cho_xep_lop', 'da_huy']) {
      const newCourseId = status === 'hoan_thanh' ? courseId : await insert('INSERT INTO khoa_hoc (ma_khoa_hoc,ten_khoa_hoc,ngoai_ngu,trinh_do,so_buoi,hoc_phi) VALUES (?, ?, ?, ?, ?, ?)',
        [`FIN-${status}`, status, 'Tiếng Nhật', 'N5', 2, 1000])
      enrollments.push(await insert(`INSERT INTO ghi_danh (hoc_vien_id,khoa_hoc_id,lop_hoc_id,ngay_ghi_danh,trang_thai)
        VALUES (?, ?, ${status === 'hoan_thanh' ? '?' : 'NULL'}, CURDATE(), ?)`,
      status === 'hoan_thanh' ? [studentId, newCourseId, classId, status] : [studentId, newCourseId, status]))
    }
    const invoiceId = await insert("INSERT INTO hoa_don (ma_hoa_don,ghi_danh_id,so_tien,ngay_lap,han_thanh_toan) VALUES (?, ?, 1000, DATE_SUB(CURDATE(), INTERVAL 7 DAY), DATE_ADD(CURDATE(), INTERVAL 2 DAY))", ['FIN-HD1', enrollments[0]])
    const canceledInvoiceId = await insert("INSERT INTO hoa_don (ma_hoa_don,ghi_danh_id,so_tien,ngay_lap,han_thanh_toan) VALUES (?, ?, 1000, CURDATE(), CURDATE())", ['FIN-HD2', enrollments[1]])
    const firstRuns = await Promise.all([1, 2, 3].map(() => sendDueInvoiceReminders(null, database, async () => false)))
    assert.equal(firstRuns.reduce((total, result) => total + result.sent, 0), 1)
    assert.equal((await sendDueInvoiceReminders(null, database, async () => false)).sent, 0)
    await connection.execute('UPDATE hoa_don SET han_thanh_toan = DATE_SUB(CURDATE(), INTERVAL 1 DAY) WHERE id = ?', [invoiceId])
    await connection.execute("INSERT INTO nhac_hoc_phi (hoa_don_id,han_thanh_toan,loai) VALUES (?, DATE_SUB(CURDATE(), INTERVAL 1 DAY), 'sap_den_han')", [invoiceId])
    const overdueRun = await sendDueInvoiceReminders(null, database, async () => { throw new Error('SMTP kiểm thử không khả dụng') })
    assert.equal(overdueRun.sent, 1)
    assert.equal(overdueRun.emailFailures, 1)
    assert.equal((await sendDueInvoiceReminders(null, database, async () => false)).sent, 0)
    const notifications = await request('/notifications?paginated=true&page=1&pageSize=1', student)
    assert.equal(notifications.pagination.total, 2)
    assert.equal(notifications.pagination.unread, 2)
    await request('/notifications/read-all', student, 'PATCH', { ids: [notifications.items[0].id] })
    assert.equal((await request('/notifications?paginated=true', student)).pagination.unread, 1)
    // SMTP lỗi được thử lại, nhưng không lặp thông báo hoặc gửi đồng thời nhiều email.
    await connection.execute("UPDATE nhac_hoc_phi SET email_thu_luc = DATE_SUB(NOW(), INTERVAL 61 MINUTE) WHERE hoa_don_id = ? AND loai = 'qua_han'", [invoiceId])
    let emailCalls = 0
    const retryRuns = await Promise.all([1, 2, 3].map(() => sendDueInvoiceReminders(null, database, async () => { emailCalls += 1; return true })))
    assert.equal(emailCalls, 1)
    assert.equal(retryRuns.reduce((total, result) => total + result.sent, 0), 0)
    assert.equal(retryRuns.reduce((total, result) => total + result.emailed, 0), 1)
    assert.equal((await request('/notifications?paginated=true', student)).pagination.total, 2)
    const [[delivery]] = await connection.query<RowDataPacket[]>("SELECT email_da_gui_luc, email_loi FROM nhac_hoc_phi WHERE hoa_don_id = ? AND loai = 'qua_han'", [invoiceId])
    assert.ok(delivery.email_da_gui_luc)
    assert.equal(delivery.email_loi, null)
    await sendDueInvoiceReminders(null, database, async () => { emailCalls += 1; return true })
    assert.equal(emailCalls, 1, 'email thành công không gửi lại')
    await connection.execute("UPDATE nhac_hoc_phi SET email_da_gui_luc = NULL, email_thu_luc = NULL WHERE hoa_don_id = ?", [invoiceId])
    await request(`/invoices/${invoiceId}/payment`, admin, 'PATCH', { method: 'tien_mat' })
    await sendDueInvoiceReminders(null, database, async () => { emailCalls += 1; return true })
    assert.equal(emailCalls, 1, 'không thử email cho hóa đơn đã thanh toán')
    await request(`/invoices/${canceledInvoiceId}/cancel`, admin, 'PATCH', { reason: 'x'.repeat(256) }, 400)
    await request(`/invoices/${canceledInvoiceId}/cancel`, admin, 'PATCH', { reason: true }, 400)
    await request('/invoices/reminders', admin, 'POST', { classId: true }, 400)
    await request('/invoices/reminders', admin, 'POST', { classId: [1] }, 400)
    await request(`/invoices/${canceledInvoiceId}/cancel`, admin, 'PATCH', { reason: 'x'.repeat(255) })
    const [[cancellation]] = await connection.query<RowDataPacket[]>('SELECT ly_do_huy FROM hoa_don WHERE id = ?', [canceledInvoiceId])
    assert.equal(cancellation.ly_do_huy, 'x'.repeat(255))
    await request('/invoices?from=2026-02-30', admin, 'GET', undefined, 400)
    await request('/invoices?from=2026-10-31&to=2026-10-01', admin, 'GET', undefined, 400)
    const classes = await request('/student/classes', student)
    assert.equal(classes.length, 4)
    assert.ok(classes.some((item: any) => item.enrollmentStatus === 'bao_luu' && item.classId === null))
    const examId = await insert('INSERT INTO ky_thi (lop_hoc_id, ten_ky_thi) VALUES (?, ?)', [classId, 'Cuối khóa'])
    await insert('INSERT INTO ket_qua_thi (ky_thi_id, ghi_danh_id, nghe, noi, doc, viet) VALUES (?, ?, 0, 0, 0, 0)', [examId, enrollments[0]])
    const [[{ year, month }]] = await connection.query<RowDataPacket[]>('SELECT YEAR(CURDATE()) AS year, MONTH(CURDATE()) AS month')
    const params = `period=month&year=${year}&unit=${month}`
    const report = await request(`/reports?${params}`, admin)
    assert.equal(report.academicMetrics.failed, 1)
    assert.equal(report.classPerformance[0].average, 0)
    const nextExam = await insert('INSERT INTO ky_thi (lop_hoc_id, ten_ky_thi) VALUES (?, ?)', [classId, 'Kỳ thi còn thiếu'])
    assert.ok(nextExam)
    assert.equal((await request(`/reports?${params}`, admin)).academicMetrics.pending, 1)
    for (const format of ['xlsx', 'pdf']) {
      const output = await fetch(`${base}/reports/export?${params}&format=${format}`, { headers: { Authorization: `Bearer ${admin}` } })
      assert.equal(output.status, 200)
      assert.match(output.headers.get('content-disposition') ?? '', new RegExp(`\\.${format}`))
      const bytes = Buffer.from(await output.arrayBuffer())
      assert.equal(bytes.subarray(0, format === 'pdf' ? 4 : 2).toString(), format === 'pdf' ? '%PDF' : 'PK')
    }
    const certificateId = await insert(`INSERT INTO chung_chi (ghi_danh_id,nguoi_duyet_id,trang_thai,ma_chung_chi,ma_xac_thuc,duong_dan_pdf,
      ngay_cap,ma_hoc_vien_luc_cap,ten_hoc_vien_luc_cap,ten_khoa_hoc_luc_cap,ngoai_ngu_luc_cap,ma_lop_luc_cap,ten_lop_luc_cap,ho_so_luc_duyet)
      VALUES (?, ?, 'da_cap', 'FIN-CC', 'FIN-VERIFY', ?, NOW(), 'HV-FIN', 'Học viên', 'Tiếng Anh', 'Tiếng Anh', 'FIN-C1', 'Lớp tài chính', JSON_OBJECT())`,
    [enrollments[0], adminId, `${env.publicUrl}/uploads/certificates/${'a'.repeat(48)}.pdf`])
    await request(`/student/certificates/${certificateId}/download`, student, 'POST', {}, 409)
    const [[downloads]] = await connection.query<RowDataPacket[]>('SELECT COUNT(*) AS count FROM luot_tai_chung_chi')
    assert.equal(Number(downloads.count), 0)
    assert.deepEqual(await request(`/certificates/${certificateId}/corrections`, admin), [])
  } finally {
    await closeServer?.()
    await closePool?.()
    await connection.query(`DROP DATABASE IF EXISTS \`${dbName}\``)
    await connection.end()
    assert.ok(storage.startsWith(join(resolve(tmpdir()), 'doan4-finance-')))
    await rm(storage, { recursive: true, force: true })
  }
})
