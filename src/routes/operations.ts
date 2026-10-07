import { randomBytes, randomInt } from 'node:crypto'
import { rm } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { Router } from 'express'
import type { ResultSetHeader, RowDataPacket } from 'mysql2/promise'
import { database } from '../config/database'
import { env } from '../config/env'
import { requireAuth, requireRole } from '../middlewares/auth'
import { HttpError } from '../utils/http-error'
import { createCertificatePdf } from '../services/certificate-pdf'
import { getCertificateEligibilityReasons, isCertificateEligible, parseTuitionAmount, type CertificateEligibility } from '../utils/operations'
import { createReportExcel, createReportPdf, getReportData } from '../services/reports'
import { sendDueInvoiceReminders } from '../services/invoice-reminders'
import { attendanceRateSql, attendanceStatsJoin } from '../utils/attendance'
import { normalizeLocalDateTime } from '../utils/date-time'

type SimpleRow = RowDataPacket & Record<string, string | number | null>
type PaymentMethod = 'tien_mat' | 'chuyen_khoan'
type CandidateRow = SimpleRow & {
  enrollmentId: number
  enrollmentStatus: string
  attendance: number
  average: number | null
  requiredExams: number
  completedExams: number
  expectedAttendance: number
  recordedAttendance: number
  presentAttendance: number
  paid: number
  certificateId: number | null
}
type CertificateIssueRow = CandidateRow & {
  certificateCode: string | null
  pdfPath: string | null
  studentCode: string
  studentName: string
  courseName: string
  language: string
  classCode: string
  className: string
  verificationCode: string | null
  issuedAt: string | null
}

export const operationsRouter = Router()

function positiveInt(value: unknown, label: string): number {
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < 1) throw new HttpError(400, `${label} phải là số nguyên dương`)
  return parsed
}

function requiredText(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new HttpError(400, `${label} là bắt buộc`)
  return value.trim()
}

function date(value: unknown, label: string): string {
  const parsed = requiredText(value, label)
  if (!normalizeLocalDateTime(`${parsed}T00:00`)) {
    throw new HttpError(400, `${label} phải có định dạng YYYY-MM-DD`)
  }
  return parsed
}

const invoiceSelect = `SELECT hd.id, hd.ma_hoa_don AS code, hd.ghi_danh_id AS enrollmentId,
  hv.ma_nguoi_dung AS studentCode, hv.ho_ten AS studentName,
  k.ten_khoa_hoc AS courseName, l.id AS classId, l.ma_lop AS classCode, l.ten_lop AS className,
  hd.so_tien AS amount, hd.ngay_lap AS issuedAt, hd.han_thanh_toan AS dueDate,
  CASE WHEN hd.trang_thai = 'chua_thanh_toan' AND hd.han_thanh_toan < CURDATE()
    THEN 'qua_han' ELSE hd.trang_thai END AS status,
  hd.ngay_thanh_toan AS paidAt, hd.phuong_thuc AS paymentMethod,
  hd.ly_do_huy AS cancellationReason
  FROM hoa_don hd JOIN ghi_danh gd ON gd.id = hd.ghi_danh_id
  JOIN nguoi_dung hv ON hv.id = gd.hoc_vien_id
  JOIN khoa_hoc k ON k.id = gd.khoa_hoc_id
  LEFT JOIN lop_hoc l ON l.id = gd.lop_hoc_id`

const frozenNumber = (key: string, fallback: string) => {
  const value = `JSON_UNQUOTE(JSON_EXTRACT(cc.ho_so_luc_duyet, '$.${key}'))`
  return `CASE WHEN cc.ho_so_luc_duyet IS NOT NULL THEN CASE ${value}
    WHEN 'true' THEN 1 WHEN 'false' THEN 0 ELSE CAST(NULLIF(${value}, 'null') AS DECIMAL(16,8)) END ELSE ${fallback} END`
}
const candidateSelect = `SELECT gd.id AS enrollmentId, gd.lop_hoc_id AS classId,
  COALESCE(JSON_UNQUOTE(JSON_EXTRACT(cc.ho_so_luc_duyet, '$.enrollmentStatus')), gd.trang_thai) AS enrollmentStatus,
  COALESCE(cc.ma_hoc_vien_luc_cap, hv.ma_nguoi_dung) AS studentCode,
  COALESCE(cc.ten_hoc_vien_luc_cap, hv.ho_ten) AS studentName,
  COALESCE(cc.ma_lop_luc_cap, l.ma_lop) AS classCode,
  COALESCE(cc.ten_lop_luc_cap, l.ten_lop) AS className,
  COALESCE(cc.ten_khoa_hoc_luc_cap, k.ten_khoa_hoc) AS courseName,
  COALESCE(cc.ngoai_ngu_luc_cap, k.ngoai_ngu) AS language,
  ${frozenNumber('attendance', attendanceRateSql)} AS attendance,
  ${frozenNumber('expectedAttendance', 'COALESCE(attendance_stats.expectedAttendance, 0)')} AS expectedAttendance,
  ${frozenNumber('recordedAttendance', 'COALESCE(attendance_stats.recordedAttendance, 0)')} AS recordedAttendance,
  ${frozenNumber('presentAttendance', 'COALESCE(attendance_stats.presentAttendance, 0)')} AS presentAttendance,
  ${frozenNumber('average', `(SELECT AVG((kq.nghe + kq.noi + kq.doc + kq.viet) / 4)
    FROM ket_qua_thi kq JOIN ky_thi kt ON kt.id = kq.ky_thi_id
    WHERE kq.ghi_danh_id = gd.id AND kt.lop_hoc_id = gd.lop_hoc_id
      AND kq.nghe IS NOT NULL AND kq.noi IS NOT NULL
      AND kq.doc IS NOT NULL AND kq.viet IS NOT NULL)`)} AS average,
  ${frozenNumber('requiredExams', '(SELECT COUNT(*) FROM ky_thi kt WHERE kt.lop_hoc_id = gd.lop_hoc_id)')} AS requiredExams,
  ${frozenNumber('completedExams', `(SELECT COUNT(*) FROM ket_qua_thi kq JOIN ky_thi kt ON kt.id = kq.ky_thi_id
    WHERE kq.ghi_danh_id = gd.id AND kt.lop_hoc_id = gd.lop_hoc_id
      AND kq.nghe IS NOT NULL AND kq.noi IS NOT NULL
      AND kq.doc IS NOT NULL AND kq.viet IS NOT NULL)`)} AS completedExams,
  ${frozenNumber('paid', `(EXISTS(SELECT 1 FROM hoa_don hd WHERE hd.ghi_danh_id = gd.id AND hd.trang_thai = 'da_thanh_toan')
    AND NOT EXISTS(SELECT 1 FROM hoa_don hd WHERE hd.ghi_danh_id = gd.id AND hd.trang_thai = 'chua_thanh_toan'))`)} AS paid,
  cc.id AS certificateId, cc.ma_chung_chi AS certificateCode,
  cc.ma_xac_thuc AS verificationCode, cc.trang_thai AS certificateStatus,
  cc.ngay_duyet AS approvedAt, cc.ngay_cap AS issuedAt, cc.duong_dan_pdf AS pdfPath
  FROM ghi_danh gd JOIN nguoi_dung hv ON hv.id = gd.hoc_vien_id
  JOIN khoa_hoc k ON k.id = gd.khoa_hoc_id
  JOIN lop_hoc l ON l.id = gd.lop_hoc_id
  LEFT JOIN chung_chi cc ON cc.ghi_danh_id = gd.id
  ${attendanceStatsJoin}`

function eligibilityOf(item: CandidateRow): CertificateEligibility {
  return {
    enrollmentStatus: item.enrollmentStatus, paid: Boolean(item.paid), attendance: Number(item.attendance),
    expectedAttendance: Number(item.expectedAttendance), recordedAttendance: Number(item.recordedAttendance),
    average: item.average === null ? null : Number(item.average),
    requiredExams: Number(item.requiredExams), completedExams: Number(item.completedExams),
  }
}

operationsRouter.get('/certificates/verify/:code', async (request, response) => {
  const code = requiredText(request.params.code, 'Mã xác thực')
  const [rows] = await database.query<SimpleRow[]>(
    `SELECT cc.ma_chung_chi AS certificateCode, cc.ma_xac_thuc AS verificationCode,
      cc.ngay_cap AS issuedAt, cc.ten_hoc_vien_luc_cap AS studentName,
      cc.ten_khoa_hoc_luc_cap AS courseName, cc.ten_lop_luc_cap AS className
     FROM chung_chi cc
     WHERE cc.ma_xac_thuc = ? AND cc.trang_thai = 'da_cap'`,
    [code],
  )
  if (!rows[0]) throw new HttpError(404, 'Mã xác thực chứng chỉ không hợp lệ')
  response.json({ success: true, data: rows[0] })
})

operationsRouter.use(['/invoices', '/certificates', '/reports'], requireAuth, requireRole('quan_tri'))

operationsRouter.get('/invoices', async (request, response) => {
  const query = typeof request.query.query === 'string' ? `%${request.query.query.trim()}%` : '%%'
  const status = typeof request.query.status === 'string' ? request.query.status : null
  const classId = request.query.classId === undefined ? null : positiveInt(request.query.classId, 'Lớp học')
  const from = request.query.from === undefined || request.query.from === '' ? null : date(request.query.from, 'Ngày bắt đầu')
  const to = request.query.to === undefined || request.query.to === '' ? null : date(request.query.to, 'Ngày kết thúc')
  if (from && to && to < from) throw new HttpError(400, 'Ngày kết thúc phải từ ngày bắt đầu trở đi')
  const validStatuses = ['chua_thanh_toan', 'da_thanh_toan', 'qua_han', 'da_huy']
  if (status && !validStatuses.includes(status)) throw new HttpError(400, 'Trạng thái hóa đơn không hợp lệ')
  const [rows] = await database.query(
    `SELECT * FROM (${invoiceSelect}) invoices
     WHERE (code LIKE ? OR studentCode LIKE ? OR studentName LIKE ? OR className LIKE ?)
       AND (? IS NULL OR status = ?) AND (? IS NULL OR classId = ?)
       AND (? IS NULL OR issuedAt >= ?) AND (? IS NULL OR issuedAt <= ?)
     ORDER BY id DESC`,
    [query, query, query, query, status, status, classId, classId, from, from, to, to],
  )
  response.json({ success: true, data: rows })
})

operationsRouter.post('/invoices/reminders', async (request, response) => {
  const classId = request.body?.classId === undefined || request.body?.classId === null
    ? null : positiveInt(request.body.classId, 'Lớp học')
  response.json({ success: true, data: await sendDueInvoiceReminders(classId) })
})

operationsRouter.post('/invoices', async (request, response) => {
  const enrollmentId = positiveInt(request.body.enrollmentId, 'Ghi danh')
  const dueDate = date(request.body.dueDate, 'Hạn thanh toán')
  const now = new Date()
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
  if (dueDate < today) throw new HttpError(400, 'Hạn thanh toán không được trước ngày hiện tại')
  const connection = await database.getConnection()
  try {
    await connection.beginTransaction()
    const [enrollments] = await connection.query<SimpleRow[]>(
      `SELECT gd.id, k.hoc_phi AS tuition, cc.id AS certificateId,
        (SELECT hd.so_tien FROM hoa_don hd WHERE hd.ghi_danh_id = gd.id ORDER BY hd.id DESC LIMIT 1) AS originalAmount
       FROM ghi_danh gd
       JOIN khoa_hoc k ON k.id = gd.khoa_hoc_id
       LEFT JOIN chung_chi cc ON cc.ghi_danh_id = gd.id
       WHERE gd.id = ? AND gd.trang_thai <> 'da_huy' FOR UPDATE`,
      [enrollmentId],
    )
    if (!enrollments[0]) throw new HttpError(404, 'Không tìm thấy ghi danh còn hiệu lực')
    if (enrollments[0].certificateId) throw new HttpError(409, 'Hồ sơ đã duyệt chứng chỉ, không được thay đổi nghĩa vụ học phí')
    const [existing] = await connection.query<SimpleRow[]>(
      `SELECT id FROM hoa_don WHERE ghi_danh_id = ? AND trang_thai <> 'da_huy' LIMIT 1`,
      [enrollmentId],
    )
    if (existing[0]) throw new HttpError(409, 'Ghi danh đã có hóa đơn còn hiệu lực')
    const amount = parseTuitionAmount(enrollments[0].originalAmount ?? enrollments[0].tuition)
    if (amount === null) throw new HttpError(400, 'Học phí phải là số nguyên dương; chưa hỗ trợ khóa miễn phí')
    if (request.body.amount !== undefined && parseTuitionAmount(request.body.amount) !== amount) {
      throw new HttpError(400, 'Thu trọn học phí đã chốt khi ghi danh, không hỗ trợ giảm phí hoặc trả góp')
    }
    const code = `HD-${new Date().getFullYear()}-${randomInt(100000, 1000000)}`
    const [result] = await connection.execute<ResultSetHeader>(
      `INSERT INTO hoa_don (ma_hoa_don, ghi_danh_id, so_tien, ngay_lap, han_thanh_toan)
       VALUES (?, ?, ?, CURDATE(), ?)`,
      [code, enrollmentId, amount, dueDate],
    )
    await connection.execute(
      `INSERT INTO thong_bao (nguoi_dung_id, tieu_de, noi_dung)
       SELECT hoc_vien_id, 'Hóa đơn học phí mới', ? FROM ghi_danh WHERE id = ?`,
      [`Hóa đơn ${code} có hạn thanh toán đến ${dueDate}.`, enrollmentId],
    )
    await connection.commit()
    const [rows] = await database.query(`${invoiceSelect} WHERE hd.id = ?`, [result.insertId])
    response.status(201).json({ success: true, data: (rows as SimpleRow[])[0] })
  } catch (error) {
    await connection.rollback()
    if ((error as { code?: string }).code === 'ER_DUP_ENTRY') throw new HttpError(409, 'Mã hóa đơn đã tồn tại, vui lòng thử lại')
    throw error
  } finally {
    connection.release()
  }
})

operationsRouter.patch('/invoices/:id/payment', async (request, response) => {
  const invoiceId = positiveInt(request.params.id, 'Hóa đơn')
  const method = request.body.method as PaymentMethod
  if (!['tien_mat', 'chuyen_khoan'].includes(method)) throw new HttpError(400, 'Phương thức thanh toán không hợp lệ')
  const connection = await database.getConnection()
  try {
    await connection.beginTransaction()
    const [result] = await connection.execute<ResultSetHeader>(
      `UPDATE hoa_don SET trang_thai = 'da_thanh_toan', ngay_thanh_toan = NOW(), phuong_thuc = ?
       WHERE id = ? AND trang_thai = 'chua_thanh_toan'`,
      [method, invoiceId],
    )
    if (!result.affectedRows) throw new HttpError(409, 'Hóa đơn không tồn tại hoặc không thể thanh toán')
    await connection.execute(
      `INSERT INTO thong_bao (nguoi_dung_id, tieu_de, noi_dung)
       SELECT gd.hoc_vien_id, 'Đã xác nhận học phí', CONCAT('Hóa đơn ', hd.ma_hoa_don, ' đã được xác nhận thanh toán.')
       FROM hoa_don hd JOIN ghi_danh gd ON gd.id = hd.ghi_danh_id WHERE hd.id = ?`,
      [invoiceId],
    )
    await connection.commit()
  } catch (error) {
    await connection.rollback()
    throw error
  } finally {
    connection.release()
  }
  const [rows] = await database.query(`${invoiceSelect} WHERE hd.id = ?`, [invoiceId])
  response.json({ success: true, data: (rows as SimpleRow[])[0] })
})

operationsRouter.patch('/invoices/:id/cancel', async (request, response) => {
  const invoiceId = positiveInt(request.params.id, 'Hóa đơn')
  const reason = requiredText(request.body.reason, 'Lý do hủy').slice(0, 255)
  const connection = await database.getConnection()
  try {
    await connection.beginTransaction()
    const [result] = await connection.execute<ResultSetHeader>(
      `UPDATE hoa_don hd SET hd.trang_thai = 'da_huy', hd.ly_do_huy = ?
       WHERE hd.id = ? AND hd.trang_thai = 'chua_thanh_toan'
         AND NOT EXISTS (SELECT 1 FROM chung_chi cc WHERE cc.ghi_danh_id = hd.ghi_danh_id)`,
      [reason, invoiceId],
    )
    if (!result.affectedRows) throw new HttpError(409, 'Chỉ được hủy hóa đơn chưa thanh toán và chưa chốt chứng chỉ; chưa hỗ trợ hoàn tiền')
    await connection.execute(
      `INSERT INTO thong_bao (nguoi_dung_id, tieu_de, noi_dung)
       SELECT gd.hoc_vien_id, 'Hóa đơn đã hủy', CONCAT('Hóa đơn ', hd.ma_hoa_don, ': ', ?)
       FROM hoa_don hd JOIN ghi_danh gd ON gd.id = hd.ghi_danh_id WHERE hd.id = ?`, [reason, invoiceId],
    )
    await connection.commit()
  } catch (error) {
    await connection.rollback()
    throw error
  } finally { connection.release() }
  response.json({ success: true, message: 'Đã hủy hóa đơn' })
})

operationsRouter.get('/certificates/candidates', async (_request, response) => {
  const [rows] = await database.query<CandidateRow[]>(`${candidateSelect} ORDER BY gd.id DESC`)
  response.json({
    success: true,
    data: rows.map((item) => {
      const input = eligibilityOf(item)
      return { ...item, eligible: isCertificateEligible(input), ineligibleReasons: getCertificateEligibilityReasons(input) }
    }),
  })
})

operationsRouter.post('/certificates/approve', async (request, response) => {
  const ids: number[] = Array.isArray(request.body.enrollmentIds)
    ? [...new Set<number>(request.body.enrollmentIds.map((item: unknown) => positiveInt(item, 'Ghi danh')))]
    : []
  if (!ids.length) throw new HttpError(400, 'Danh sách ghi danh là bắt buộc')
  const connection = await database.getConnection()
  try {
    await connection.beginTransaction()
    await connection.query(
      `SELECT id FROM lop_hoc WHERE id IN (SELECT lop_hoc_id FROM ghi_danh
       WHERE id IN (${ids.map(() => '?').join(',')})) ORDER BY id FOR UPDATE`, ids,
    )
    const [rows] = await connection.query<CandidateRow[]>(
      `${candidateSelect} WHERE gd.id IN (${ids.map(() => '?').join(',')}) FOR UPDATE`,
      ids,
    )
    if (rows.length !== ids.length || rows.some((item) => !isCertificateEligible(eligibilityOf(item)))) {
      throw new HttpError(409, 'Danh sách có học viên chưa đủ điều kiện cấp chứng chỉ')
    }
    if (rows.some((item) => item.certificateId !== null)) throw new HttpError(409, 'Danh sách có học viên đã được phê duyệt chứng chỉ')
    let approved = 0
    for (const item of rows) {
      const enrollmentId = item.enrollmentId
      const [result] = await connection.execute<ResultSetHeader>(
        `INSERT INTO chung_chi (ghi_danh_id, nguoi_duyet_id, ma_hoc_vien_luc_cap, ten_hoc_vien_luc_cap,
          ten_khoa_hoc_luc_cap, ngoai_ngu_luc_cap, ma_lop_luc_cap, ten_lop_luc_cap, ho_so_luc_duyet)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [enrollmentId, request.auth!.userId, item.studentCode, item.studentName, item.courseName,
          item.language, item.classCode, item.className,
          JSON.stringify({ ...eligibilityOf(item), paid: Number(item.paid), presentAttendance: Number(item.presentAttendance) })],
      )
      approved += result.affectedRows ? 1 : 0
      await connection.execute(
        `INSERT INTO thong_bao (nguoi_dung_id, tieu_de, noi_dung)
         SELECT hoc_vien_id, 'Đã duyệt chứng chỉ', 'Hồ sơ chứng chỉ của bạn đã được phê duyệt.'
         FROM ghi_danh WHERE id = ?`,
        [enrollmentId],
      )
    }
    await connection.commit()
    response.status(201).json({ success: true, data: { approved } })
  } catch (error) {
    await connection.rollback()
    throw error
  } finally {
    connection.release()
  }
})

async function generateCertificate(certificateId: number, expectedStatus: 'da_duyet' | 'da_cap') {
  const filename = `${randomBytes(24).toString('hex')}.pdf`
  const outputPath = join(env.storageDir, 'certificates', filename)
  const pdfPath = `${env.publicUrl}/uploads/certificates/${filename}`
  const connection = await database.getConnection()
  let oldPdfPath: string | null = null
  let code = ''
  let verificationCode = ''
  try {
    await connection.beginTransaction()
    const [certificates] = await connection.query<CertificateIssueRow[]>(
      `${candidateSelect} WHERE cc.id = ? AND cc.trang_thai = ? FOR UPDATE`,
      [certificateId, expectedStatus],
    )
    const certificate = certificates[0]
    if (!certificate) throw new HttpError(409, expectedStatus === 'da_duyet' ? 'Chứng chỉ không tồn tại hoặc đã được cấp' : 'Chỉ được cấp lại chứng chỉ đã phát hành')
    const eligibility = eligibilityOf(certificate)
    if (expectedStatus === 'da_duyet' && !isCertificateEligible(eligibility)) {
      throw new HttpError(409, `Không thể cấp chứng chỉ: ${getCertificateEligibilityReasons(eligibility).join('; ')}`)
    }
    code = certificate.certificateCode ?? `CC-${new Date().getFullYear()}-${String(certificateId).padStart(6, '0')}`
    verificationCode = certificate.verificationCode ?? randomBytes(24).toString('hex')
    const issuedAt = certificate.issuedAt ? new Date(certificate.issuedAt.replace(' ', 'T') + '+07:00') : new Date()
    const verificationUrl = `${env.clientUrl}/verify-certificate?code=${verificationCode}`
    oldPdfPath = certificate.pdfPath
    await createCertificatePdf(outputPath, {
      certificateCode: code,
      studentName: certificate.studentName,
      studentCode: certificate.studentCode,
      courseName: certificate.courseName,
      className: certificate.className,
      classCode: certificate.classCode,
      language: certificate.language,
      issuedAt,
      verificationUrl,
    })
    const [result] = await connection.execute<ResultSetHeader>(
      `UPDATE chung_chi SET ma_chung_chi = ?, ma_xac_thuc = ?, trang_thai = 'da_cap',
        ngay_cap = COALESCE(ngay_cap, NOW()), duong_dan_pdf = ?, ma_hoc_vien_luc_cap = ?, ten_hoc_vien_luc_cap = ?,
        ten_khoa_hoc_luc_cap = ?, ngoai_ngu_luc_cap = ?, ma_lop_luc_cap = ?, ten_lop_luc_cap = ?
       WHERE id = ? AND trang_thai = ?`,
      [code, verificationCode, pdfPath, certificate.studentCode, certificate.studentName,
        certificate.courseName, certificate.language, certificate.classCode, certificate.className,
        certificateId, expectedStatus],
    )
    if (!result.affectedRows) throw new HttpError(409, 'Trạng thái chứng chỉ đã thay đổi, vui lòng thử lại')
    await connection.execute(
      `INSERT INTO thong_bao (nguoi_dung_id, tieu_de, noi_dung)
       SELECT gd.hoc_vien_id, ?, CONCAT('Chứng chỉ ', cc.ma_chung_chi, ' đã sẵn sàng để tải xuống.')
       FROM chung_chi cc JOIN ghi_danh gd ON gd.id = cc.ghi_danh_id WHERE cc.id = ?`,
      [expectedStatus === 'da_cap' ? 'Chứng chỉ đã được cấp lại' : 'Chứng chỉ đã được cấp', certificateId],
    )
    await connection.commit()
  } catch (error) {
    await connection.rollback()
    await rm(outputPath, { force: true }).catch(() => undefined)
    throw error
  } finally {
    connection.release()
  }
  if (oldPdfPath && oldPdfPath !== pdfPath) {
    await rm(join(env.storageDir, 'certificates', basename(oldPdfPath)), { force: true }).catch(() => undefined)
  }
  return { id: certificateId, code, verificationCode, pdfPath }
}

operationsRouter.patch('/certificates/:id/issue', async (request, response) => {
  const data = await generateCertificate(positiveInt(request.params.id, 'Chứng chỉ'), 'da_duyet')
  response.json({ success: true, data })
})

operationsRouter.post('/certificates/:id/reissue', async (request, response) => {
  const data = await generateCertificate(positiveInt(request.params.id, 'Chứng chỉ'), 'da_cap')
  response.json({ success: true, data })
})

operationsRouter.patch('/certificates/:id/details', async (request, response) => {
  const certificateId = positiveInt(request.params.id, 'Chứng chỉ')
  const reason = requiredText(request.body.reason, 'Lý do đính chính')
  if (reason.length > 255) throw new HttpError(400, 'Lý do đính chính tối đa 255 ký tự')
  const fields = [
    ['studentCode', 'ma_hoc_vien_luc_cap', 20], ['studentName', 'ten_hoc_vien_luc_cap', 150],
    ['courseName', 'ten_khoa_hoc_luc_cap', 150], ['language', 'ngoai_ngu_luc_cap', 50],
    ['classCode', 'ma_lop_luc_cap', 30], ['className', 'ten_lop_luc_cap', 150],
  ] as const
  const values = fields.map(([key, , limit]) => {
    const value = requiredText(request.body[key], key)
    if (value.length > limit) throw new HttpError(400, `${key} tối đa ${limit} ký tự`)
    return value
  })
  const connection = await database.getConnection()
  try {
    await connection.beginTransaction()
    const [rows] = await connection.query<CertificateIssueRow[]>(`${candidateSelect} WHERE cc.id = ? FOR UPDATE`, [certificateId])
    const previous = rows[0]
    if (!previous || previous.certificateStatus !== 'da_duyet') {
      throw new HttpError(409, 'Chỉ được đính chính thông tin trước khi phát hành; cấp lại không thay nội dung chứng chỉ đã cấp')
    }
    const audit = JSON.stringify({ at: new Date().toISOString(), userId: request.auth!.userId, reason,
      before: Object.fromEntries(fields.map(([key]) => [key, previous[key]])),
      after: Object.fromEntries(fields.map(([key], index) => [key, values[index]])),
    })
    await connection.execute(
      `UPDATE chung_chi SET ${fields.map(([, column]) => `${column} = ?`).join(', ')},
        ho_so_luc_duyet = JSON_SET(ho_so_luc_duyet, '$.corrections',
          JSON_ARRAY_APPEND(COALESCE(JSON_EXTRACT(ho_so_luc_duyet, '$.corrections'), JSON_ARRAY()), '$', CAST(? AS JSON)))
       WHERE id = ?`, [...values, audit, certificateId],
    )
    await connection.execute(
      `INSERT INTO thong_bao (nguoi_dung_id, tieu_de, noi_dung)
       SELECT gd.hoc_vien_id, 'Đính chính hồ sơ chứng chỉ', ?
       FROM chung_chi cc JOIN ghi_danh gd ON gd.id = cc.ghi_danh_id WHERE cc.id = ?`, [reason, certificateId],
    )
    await connection.commit()
    response.json({ success: true, message: 'Đã đính chính thông tin; giữ nguyên điểm, chuyên cần và nghĩa vụ học phí đã duyệt' })
  } catch (error) { await connection.rollback(); throw error } finally { connection.release() }
})

operationsRouter.get('/certificates/:id/corrections', async (request, response) => {
  const id = positiveInt(request.params.id, 'Chứng chỉ')
  const [rows] = await database.query<SimpleRow[]>(
    "SELECT JSON_EXTRACT(ho_so_luc_duyet, '$.corrections') AS corrections FROM chung_chi WHERE id = ?", [id],
  )
  if (!rows[0]) throw new HttpError(404, 'Không tìm thấy chứng chỉ')
  const stored = rows[0].corrections
  const corrections = (typeof stored === 'string' ? JSON.parse(stored) : stored) as Array<Record<string, unknown>> | null
  const items = Array.isArray(corrections) ? corrections : []
  const ids = [...new Set(items.map((item) => Number(item.userId)).filter((userId) => Number.isInteger(userId) && userId > 0))]
  const [users] = ids.length ? await database.query<SimpleRow[]>(
    `SELECT id, ho_ten AS fullName FROM nguoi_dung WHERE id IN (${ids.map(() => '?').join(',')})`, ids,
  ) : [[]]
  response.json({ success: true, data: items.map((item) => ({ ...item,
    adminName: users.find((user) => Number(user.id) === Number(item.userId))?.fullName ?? null })) })
})

operationsRouter.get('/reports', async (request, response) => {
  response.json({ success: true, data: await getReportData(request.query.period, request.query.year, request.query.unit) })
})

operationsRouter.get('/reports/export', async (request, response) => {
  const format = request.query.format
  if (format !== 'xlsx' && format !== 'pdf') throw new HttpError(400, 'Định dạng xuất phải là xlsx hoặc pdf')
  const data = await getReportData(request.query.period, request.query.year, request.query.unit)
  const output = format === 'xlsx' ? await createReportExcel(data) : await createReportPdf(data)
  response.setHeader('Content-Type', format === 'xlsx' ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' : 'application/pdf')
  response.setHeader('Content-Disposition', `attachment; filename="bao-cao-${data.period.start}.${format}"`)
  response.send(output)
})
