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
import { getCertificateEligibilityReasons, getReportPeriod, isCertificateEligible } from '../utils/operations'

type SimpleRow = RowDataPacket & Record<string, string | number | null>
type PaymentMethod = 'tien_mat' | 'chuyen_khoan'
type CandidateRow = SimpleRow & {
  enrollmentId: number
  enrollmentStatus: string
  attendance: number
  average: number | null
  requiredExams: number
  completedExams: number
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
  if (!/^\d{4}-\d{2}-\d{2}$/.test(parsed) || Number.isNaN(Date.parse(`${parsed}T00:00:00Z`))) {
    throw new HttpError(400, `${label} phải có định dạng YYYY-MM-DD`)
  }
  return parsed
}

const invoiceSelect = `SELECT hd.id, hd.ma_hoa_don AS code, hd.ghi_danh_id AS enrollmentId,
  hv.ma_nguoi_dung AS studentCode, hv.ho_ten AS studentName,
  k.ten_khoa_hoc AS courseName, l.id AS classId, l.ten_lop AS className,
  hd.so_tien AS amount, hd.ngay_lap AS issuedAt, hd.han_thanh_toan AS dueDate,
  CASE WHEN hd.trang_thai = 'chua_thanh_toan' AND hd.han_thanh_toan < CURDATE()
    THEN 'qua_han' ELSE hd.trang_thai END AS status,
  hd.ngay_thanh_toan AS paidAt, hd.phuong_thuc AS paymentMethod,
  hd.ly_do_huy AS cancellationReason
  FROM hoa_don hd JOIN ghi_danh gd ON gd.id = hd.ghi_danh_id
  JOIN nguoi_dung hv ON hv.id = gd.hoc_vien_id
  JOIN khoa_hoc k ON k.id = gd.khoa_hoc_id
  LEFT JOIN lop_hoc l ON l.id = gd.lop_hoc_id`

const candidateSelect = `SELECT gd.id AS enrollmentId, gd.trang_thai AS enrollmentStatus,
  COALESCE(cc.ma_hoc_vien_luc_cap, hv.ma_nguoi_dung) AS studentCode,
  COALESCE(cc.ten_hoc_vien_luc_cap, hv.ho_ten) AS studentName,
  COALESCE(cc.ma_lop_luc_cap, l.ma_lop) AS classCode,
  COALESCE(cc.ten_lop_luc_cap, l.ten_lop) AS className,
  COALESCE(cc.ten_khoa_hoc_luc_cap, k.ten_khoa_hoc) AS courseName,
  COALESCE(cc.ngoai_ngu_luc_cap, k.ngoai_ngu) AS language,
  COALESCE((SELECT ROUND(100 * SUM(dd.trang_thai IN ('co_mat', 'di_muon')) / NULLIF(COUNT(*), 0), 0)
    FROM diem_danh dd WHERE dd.ghi_danh_id = gd.id), 0) AS attendance,
  (SELECT ROUND(AVG((kq.nghe + kq.noi + kq.doc + kq.viet) / 4), 2)
    FROM ket_qua_thi kq JOIN ky_thi kt ON kt.id = kq.ky_thi_id
    WHERE kq.ghi_danh_id = gd.id AND kt.lop_hoc_id = gd.lop_hoc_id
      AND kq.nghe IS NOT NULL AND kq.noi IS NOT NULL
      AND kq.doc IS NOT NULL AND kq.viet IS NOT NULL) AS average,
  (SELECT COUNT(*) FROM ky_thi kt WHERE kt.lop_hoc_id = gd.lop_hoc_id) AS requiredExams,
  (SELECT COUNT(*) FROM ket_qua_thi kq JOIN ky_thi kt ON kt.id = kq.ky_thi_id
    WHERE kq.ghi_danh_id = gd.id AND kt.lop_hoc_id = gd.lop_hoc_id
      AND kq.nghe IS NOT NULL AND kq.noi IS NOT NULL
      AND kq.doc IS NOT NULL AND kq.viet IS NOT NULL) AS completedExams,
  (EXISTS(SELECT 1 FROM hoa_don hd WHERE hd.ghi_danh_id = gd.id AND hd.trang_thai = 'da_thanh_toan')
    AND NOT EXISTS(SELECT 1 FROM hoa_don hd WHERE hd.ghi_danh_id = gd.id AND hd.trang_thai = 'chua_thanh_toan')) AS paid,
  cc.id AS certificateId, cc.ma_chung_chi AS certificateCode,
  cc.ma_xac_thuc AS verificationCode, cc.trang_thai AS certificateStatus,
  cc.ngay_duyet AS approvedAt, cc.ngay_cap AS issuedAt, cc.duong_dan_pdf AS pdfPath
  FROM ghi_danh gd JOIN nguoi_dung hv ON hv.id = gd.hoc_vien_id
  JOIN khoa_hoc k ON k.id = gd.khoa_hoc_id
  JOIN lop_hoc l ON l.id = gd.lop_hoc_id
  LEFT JOIN chung_chi cc ON cc.ghi_danh_id = gd.id`

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
  const validStatuses = ['chua_thanh_toan', 'da_thanh_toan', 'qua_han', 'da_huy']
  if (status && !validStatuses.includes(status)) throw new HttpError(400, 'Trạng thái hóa đơn không hợp lệ')
  const [rows] = await database.query(
    `SELECT * FROM (${invoiceSelect}) invoices
     WHERE (code LIKE ? OR studentCode LIKE ? OR studentName LIKE ? OR className LIKE ?)
       AND (? IS NULL OR status = ?) AND (? IS NULL OR classId = ?)
     ORDER BY id DESC`,
    [query, query, query, query, status, status, classId, classId],
  )
  response.json({ success: true, data: rows })
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
      `SELECT gd.id, k.hoc_phi AS tuition FROM ghi_danh gd
       JOIN khoa_hoc k ON k.id = gd.khoa_hoc_id
       WHERE gd.id = ? AND gd.trang_thai <> 'da_huy' FOR UPDATE`,
      [enrollmentId],
    )
    if (!enrollments[0]) throw new HttpError(404, 'Không tìm thấy ghi danh còn hiệu lực')
    const [existing] = await connection.query<SimpleRow[]>(
      `SELECT id FROM hoa_don WHERE ghi_danh_id = ? AND trang_thai <> 'da_huy' LIMIT 1`,
      [enrollmentId],
    )
    if (existing[0]) throw new HttpError(409, 'Ghi danh đã có hóa đơn còn hiệu lực')
    const amount = request.body.amount === undefined ? Number(enrollments[0].tuition) : Number(request.body.amount)
    if (!Number.isFinite(amount) || amount <= 0) throw new HttpError(400, 'Số tiền phải lớn hơn 0')
    const code = `HD-${new Date().getFullYear()}-${randomInt(100000, 1000000)}`
    const [result] = await connection.execute<ResultSetHeader>(
      `INSERT INTO hoa_don (ma_hoa_don, ghi_danh_id, so_tien, ngay_lap, han_thanh_toan)
       VALUES (?, ?, ?, CURDATE(), ?)`,
      [code, enrollmentId, Math.trunc(amount), dueDate],
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
  const [result] = await database.execute<ResultSetHeader>(
    `UPDATE hoa_don SET trang_thai = 'da_huy', ly_do_huy = ?
     WHERE id = ? AND trang_thai = 'chua_thanh_toan'`,
    [reason, invoiceId],
  )
  if (!result.affectedRows) throw new HttpError(409, 'Chỉ được hủy hóa đơn chưa thanh toán')
  response.json({ success: true, message: 'Đã hủy hóa đơn' })
})

operationsRouter.get('/certificates/candidates', async (_request, response) => {
  const [rows] = await database.query<CandidateRow[]>(`${candidateSelect} ORDER BY gd.id DESC`)
  response.json({
    success: true,
    data: rows.map((item) => {
      const input = {
        enrollmentStatus: item.enrollmentStatus,
        paid: Boolean(item.paid),
        attendance: Number(item.attendance),
        average: item.average === null ? null : Number(item.average),
        requiredExams: Number(item.requiredExams),
        completedExams: Number(item.completedExams),
      }
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
    const [rows] = await connection.query<CandidateRow[]>(
      `${candidateSelect} WHERE gd.id IN (${ids.map(() => '?').join(',')}) FOR UPDATE`,
      ids,
    )
    if (rows.length !== ids.length || rows.some((item) => !isCertificateEligible({
      enrollmentStatus: item.enrollmentStatus,
      paid: Boolean(item.paid),
      attendance: Number(item.attendance),
      average: item.average === null ? null : Number(item.average),
      requiredExams: Number(item.requiredExams),
      completedExams: Number(item.completedExams),
    }))) {
      throw new HttpError(409, 'Danh sách có học viên chưa đủ điều kiện cấp chứng chỉ')
    }
    if (rows.some((item) => item.certificateId !== null)) throw new HttpError(409, 'Danh sách có học viên đã được phê duyệt chứng chỉ')
    let approved = 0
    for (const enrollmentId of ids) {
      const [result] = await connection.execute<ResultSetHeader>(
        'INSERT INTO chung_chi (ghi_danh_id, nguoi_duyet_id) VALUES (?, ?)',
        [enrollmentId, request.auth!.userId],
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
  const verificationCode = randomBytes(24).toString('hex')
  const filename = `${verificationCode}.pdf`
  const outputPath = join(env.storageDir, 'certificates', filename)
  const pdfPath = `${env.publicUrl}/uploads/certificates/${filename}`
  const verificationUrl = `${env.clientUrl}/verify-certificate?code=${verificationCode}`
  const connection = await database.getConnection()
  let oldPdfPath: string | null = null
  let code = ''
  try {
    await connection.beginTransaction()
    const [certificates] = await connection.query<CertificateIssueRow[]>(
      `${candidateSelect} WHERE cc.id = ? AND cc.trang_thai = ? FOR UPDATE`,
      [certificateId, expectedStatus],
    )
    const certificate = certificates[0]
    if (!certificate) throw new HttpError(409, expectedStatus === 'da_duyet' ? 'Chứng chỉ không tồn tại hoặc đã được cấp' : 'Chỉ được cấp lại chứng chỉ đã phát hành')
    const eligibility = {
      enrollmentStatus: certificate.enrollmentStatus,
      paid: Boolean(certificate.paid),
      attendance: Number(certificate.attendance),
      average: certificate.average === null ? null : Number(certificate.average),
      requiredExams: Number(certificate.requiredExams),
      completedExams: Number(certificate.completedExams),
    }
    if (!isCertificateEligible(eligibility)) {
      throw new HttpError(409, `Không thể cấp chứng chỉ: ${getCertificateEligibilityReasons(eligibility).join('; ')}`)
    }
    code = certificate.certificateCode ?? `CC-${new Date().getFullYear()}-${String(certificateId).padStart(6, '0')}`
    oldPdfPath = certificate.pdfPath
    await createCertificatePdf(outputPath, {
      certificateCode: code,
      studentName: certificate.studentName,
      studentCode: certificate.studentCode,
      courseName: certificate.courseName,
      className: certificate.className,
      classCode: certificate.classCode,
      language: certificate.language,
      issuedAt: new Date(),
      verificationUrl,
    })
    const [result] = await connection.execute<ResultSetHeader>(
      `UPDATE chung_chi SET ma_chung_chi = ?, ma_xac_thuc = ?, trang_thai = 'da_cap',
        ngay_cap = NOW(), duong_dan_pdf = ?, ma_hoc_vien_luc_cap = ?, ten_hoc_vien_luc_cap = ?,
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

operationsRouter.get('/reports', async (request, response) => {
  const now = new Date()
  const periodName = request.query.period ?? 'month'
  const year = request.query.year ?? now.getFullYear()
  const unit = request.query.unit ?? (periodName === 'quarter' ? Math.floor(now.getMonth() / 3) + 1 : now.getMonth() + 1)
  const period = getReportPeriod(periodName, year, unit)
  if (!period) throw new HttpError(400, 'Kỳ báo cáo không hợp lệ')
  const params = [period.start, period.end]
  const [[metrics], [revenueByMonth], [languageShare], [coursePerformance]] = await Promise.all([
    database.query<SimpleRow[]>(
      `SELECT
        COALESCE(SUM(CASE WHEN trang_thai = 'da_thanh_toan' AND ngay_thanh_toan >= ? AND ngay_thanh_toan < ? THEN so_tien ELSE 0 END), 0) AS revenue,
        COALESCE(SUM(CASE WHEN trang_thai = 'chua_thanh_toan' AND ngay_lap >= ? AND ngay_lap < ? THEN so_tien ELSE 0 END), 0) AS debt
       FROM hoa_don`,
      [...params, ...params],
    ),
    database.query(
      `SELECT DATE_FORMAT(ngay_thanh_toan, '%Y-%m') AS month, SUM(so_tien) AS revenue
       FROM hoa_don WHERE trang_thai = 'da_thanh_toan'
         AND ngay_thanh_toan >= DATE_SUB(?, INTERVAL 6 MONTH) AND ngay_thanh_toan < ?
       GROUP BY month ORDER BY month`,
      [period.end, period.end],
    ),
    database.query(
      `SELECT k.ngoai_ngu AS language, COUNT(DISTINCT gd.hoc_vien_id) AS students
       FROM ghi_danh gd JOIN khoa_hoc k ON k.id = gd.khoa_hoc_id
       WHERE gd.ngay_ghi_danh >= ? AND gd.ngay_ghi_danh < ? AND gd.trang_thai <> 'da_huy'
       GROUP BY k.ngoai_ngu ORDER BY students DESC`,
      params,
    ),
    database.query(
      `SELECT k.id, k.ten_khoa_hoc AS courseName,
        (SELECT COUNT(*) FROM lop_hoc l WHERE l.khoa_hoc_id = k.id) AS classes,
        (SELECT COUNT(DISTINCT gd.hoc_vien_id) FROM ghi_danh gd
          WHERE gd.khoa_hoc_id = k.id AND gd.ngay_ghi_danh >= ? AND gd.ngay_ghi_danh < ?
            AND gd.trang_thai <> 'da_huy') AS students,
        (SELECT ROUND(100 * SUM(gd.trang_thai = 'hoan_thanh') / NULLIF(COUNT(*), 0), 0)
          FROM ghi_danh gd WHERE gd.khoa_hoc_id = k.id
            AND gd.ngay_ghi_danh >= ? AND gd.ngay_ghi_danh < ? AND gd.trang_thai <> 'da_huy') AS completion,
        (SELECT COALESCE(SUM(hd.so_tien), 0) FROM hoa_don hd
          JOIN ghi_danh gd ON gd.id = hd.ghi_danh_id
          WHERE gd.khoa_hoc_id = k.id AND hd.trang_thai = 'da_thanh_toan'
            AND hd.ngay_thanh_toan >= ? AND hd.ngay_thanh_toan < ?) AS revenue
       FROM khoa_hoc k ORDER BY revenue DESC`,
      [...params, ...params, ...params],
    ),
  ])
  const [counts] = await database.query<SimpleRow[]>(
    `SELECT
      (SELECT COUNT(DISTINCT gd.hoc_vien_id) FROM ghi_danh gd
        WHERE gd.ngay_ghi_danh >= ? AND gd.ngay_ghi_danh < ? AND gd.trang_thai <> 'da_huy') AS students,
      (SELECT COUNT(*) FROM lop_hoc l WHERE l.trang_thai = 'dang_hoc') AS activeClasses,
      (SELECT COUNT(*) FROM chung_chi cc WHERE cc.trang_thai = 'da_cap'
        AND cc.ngay_cap >= ? AND cc.ngay_cap < ?) AS certificates`,
    [...params, ...params],
  )
  response.json({
    success: true,
    data: { period, metrics: { ...metrics[0], ...counts[0] }, revenueByMonth, languageShare, coursePerformance },
  })
})
