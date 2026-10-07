import { Router } from 'express'
import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { ResultSetHeader, RowDataPacket } from 'mysql2/promise'
import { database } from '../config/database'
import { env } from '../config/env'
import { requireAuth, requireRole } from '../middlewares/auth'
import { HttpError } from '../utils/http-error'
import { getCertificateEligibilityReasons, isCertificateEligible } from '../utils/operations'
import { attendanceCountColumns, attendanceRateSql, attendanceStatsJoin } from '../utils/attendance'
import { normalizeLocalDateTime } from '../utils/date-time'

type SimpleRow = RowDataPacket & Record<string, string | number | null>

export const studentRouter = Router()
studentRouter.use(requireAuth, requireRole('hoc_vien'))

function positiveInt(value: unknown, label: string): number {
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < 1) throw new HttpError(400, `${label} phải là số nguyên dương`)
  return parsed
}

function optionalDate(value: unknown, label: string): string | null {
  if (value === undefined || value === null || value === '') return null
  if (typeof value !== 'string' || !normalizeLocalDateTime(`${value}T00:00`)) {
    throw new HttpError(400, `${label} phải có định dạng YYYY-MM-DD`)
  }
  return value
}

studentRouter.get('/dashboard', async (request, response) => {
  const studentId = request.auth!.userId
  const [users] = await database.query<SimpleRow[]>(
    'SELECT ma_nguoi_dung AS code, ho_ten AS fullName FROM nguoi_dung WHERE id = ?',
    [studentId],
  )
  const [summary] = await database.query<SimpleRow[]>(
    `SELECT COUNT(DISTINCT CASE WHEN gd.trang_thai = 'dang_hoc' AND l.trang_thai = 'dang_hoc' THEN gd.lop_hoc_id END) AS activeClasses,
      COUNT(DISTINCT CASE WHEN dd.trang_thai = 'co_mat' THEN dd.id END) AS present,
      COUNT(DISTINCT CASE WHEN dd.trang_thai = 'di_muon' THEN dd.id END) AS late,
      COUNT(DISTINCT CASE WHEN dd.trang_thai = 'vang' THEN dd.id END) AS absent,
      COUNT(bh.id) AS expectedAttendance, COUNT(dd.id) AS recordedAttendance,
      COALESCE(100 * SUM(CASE WHEN dd.trang_thai IN ('co_mat', 'di_muon') THEN 1 ELSE 0 END) /
        NULLIF(COUNT(bh.id), 0), 0) AS attendanceRate
     FROM ghi_danh gd JOIN lop_hoc l ON l.id = gd.lop_hoc_id
     LEFT JOIN buoi_hoc bh ON bh.lop_hoc_id = l.id AND bh.bat_dau <= NOW() AND bh.trang_thai <> 'da_huy'
     LEFT JOIN diem_danh dd ON dd.ghi_danh_id = gd.id AND dd.buoi_hoc_id = bh.id
     WHERE gd.hoc_vien_id = ? AND gd.trang_thai IN ('dang_hoc', 'hoan_thanh')`,
    [studentId],
  )
  const [debt] = await database.query<SimpleRow[]>(
    `SELECT COALESCE(SUM(hd.so_tien), 0) AS outstanding,
      MIN(hd.han_thanh_toan) AS nearestDueDate
     FROM hoa_don hd JOIN ghi_danh gd ON gd.id = hd.ghi_danh_id
     WHERE gd.hoc_vien_id = ? AND hd.trang_thai = 'chua_thanh_toan'`,
    [studentId],
  )
  const [progress] = await database.query<SimpleRow[]>(
    `SELECT COALESCE(ROUND(100 * SUM(completedSessions) / NULLIF(SUM(totalSessions), 0), 0), 0) AS courseProgress
     FROM (
       SELECT gd.id, l.so_buoi AS totalSessions,
         LEAST(COUNT(DISTINCT CASE WHEN bh.trang_thai = 'da_hoc' THEN bh.id END), l.so_buoi) AS completedSessions
       FROM ghi_danh gd JOIN lop_hoc l ON l.id = gd.lop_hoc_id
       LEFT JOIN buoi_hoc bh ON bh.lop_hoc_id = l.id
       WHERE gd.hoc_vien_id = ? AND gd.trang_thai = 'dang_hoc' AND l.trang_thai = 'dang_hoc'
       GROUP BY gd.id, l.so_buoi
     ) activeCourses`,
    [studentId],
  )
  const [certificates] = await database.query<SimpleRow[]>(
    `SELECT COALESCE(SUM(cc.trang_thai = 'da_cap'), 0) AS issuedCertificates,
      COALESCE(SUM(cc.trang_thai = 'da_duyet'), 0) AS approvedCertificates
     FROM chung_chi cc JOIN ghi_danh gd ON gd.id = cc.ghi_danh_id
     WHERE gd.hoc_vien_id = ?`,
    [studentId],
  )
  const [nextSessions] = await database.query<SimpleRow[]>(
    `SELECT bh.id, l.ma_lop AS classCode, l.ten_lop AS className,
      bh.bat_dau AS startsAt, bh.ket_thuc AS endsAt, p.ma_phong AS roomCode,
      gv.ho_ten AS teacherName
     FROM ghi_danh gd JOIN lop_hoc l ON l.id = gd.lop_hoc_id
     JOIN buoi_hoc bh ON bh.lop_hoc_id = l.id
     JOIN phong_hoc p ON p.id = bh.phong_hoc_id
     JOIN nguoi_dung gv ON gv.id = bh.giao_vien_id
     WHERE gd.hoc_vien_id = ? AND gd.trang_thai = 'dang_hoc'
       AND bh.bat_dau >= NOW() AND bh.trang_thai = 'da_len_lich'
     ORDER BY bh.bat_dau LIMIT 1`,
    [studentId],
  )
  response.json({
    success: true,
    data: {
      user: users[0], ...summary[0], ...debt[0], ...progress[0], ...certificates[0],
      nextSession: nextSessions[0] ?? null,
    },
  })
})

studentRouter.get('/classes', async (request, response) => {
  const [rows] = await database.query(
    `SELECT gd.id AS enrollmentId, gd.trang_thai AS enrollmentStatus, gd.ngay_ghi_danh AS enrolledAt,
      l.id, l.id AS classId, l.ma_lop AS code, l.ten_lop AS name, l.ngay_khai_giang AS startDate,
      l.so_buoi AS totalSessions, l.trang_thai AS status, l.si_so_toi_da AS maxStudents,
      (SELECT COUNT(*) FROM ghi_danh roster WHERE roster.lop_hoc_id = l.id
        AND roster.trang_thai IN ('dang_hoc', 'hoan_thanh')) AS enrolled,
      k.id AS courseId, k.ten_khoa_hoc AS courseName, k.ngoai_ngu AS language, k.trinh_do AS level,
      k.mo_ta AS description,
      gv.ho_ten AS teacherName,
      COUNT(DISTINCT CASE WHEN bh.trang_thai = 'da_hoc' THEN bh.id END) AS completedSessions
     FROM ghi_danh gd LEFT JOIN lop_hoc l ON l.id = gd.lop_hoc_id
     JOIN khoa_hoc k ON k.id = gd.khoa_hoc_id
     LEFT JOIN nguoi_dung gv ON gv.id = l.giao_vien_id
     LEFT JOIN buoi_hoc bh ON bh.lop_hoc_id = l.id
     WHERE gd.hoc_vien_id = ?
     GROUP BY gd.id, l.id ORDER BY gd.id DESC`,
    [request.auth!.userId],
  )
  response.json({ success: true, data: rows })
})

studentRouter.get('/sessions', async (request, response) => {
  const from = optionalDate(request.query.from, 'Ngày bắt đầu')
  const to = optionalDate(request.query.to, 'Ngày kết thúc')
  if (from && to && to < from) throw new HttpError(400, 'Ngày kết thúc phải từ ngày bắt đầu trở đi')
  const [rows] = await database.query(
    `SELECT bh.id, l.id AS classId, l.ma_lop AS classCode, l.ten_lop AS className,
      bh.bat_dau AS startsAt, bh.ket_thuc AS endsAt, bh.trang_thai AS status,
      p.ma_phong AS roomCode, gv.ho_ten AS teacherName,
      dd.trang_thai AS attendanceStatus, dd.ghi_chu AS attendanceNote
     FROM ghi_danh gd JOIN lop_hoc l ON l.id = gd.lop_hoc_id
     JOIN buoi_hoc bh ON bh.lop_hoc_id = l.id
     JOIN phong_hoc p ON p.id = bh.phong_hoc_id
     JOIN nguoi_dung gv ON gv.id = bh.giao_vien_id
     LEFT JOIN diem_danh dd ON dd.buoi_hoc_id = bh.id AND dd.ghi_danh_id = gd.id
     WHERE gd.hoc_vien_id = ? AND gd.trang_thai IN ('dang_hoc', 'hoan_thanh')
       AND (? IS NULL OR DATE(bh.bat_dau) >= ?)
       AND (? IS NULL OR DATE(bh.bat_dau) <= ?)
     ORDER BY bh.bat_dau`,
    [request.auth!.userId, from, from, to, to],
  )
  response.json({ success: true, data: rows })
})

studentRouter.get('/results', async (request, response) => {
  const studentId = request.auth!.userId
  const [exams] = await database.query(
    `SELECT kt.id AS examId, gd.id AS enrollmentId, kt.ten_ky_thi AS examName, kt.ngay_thi AS examDate,
      l.id AS classId, l.ma_lop AS classCode, l.ten_lop AS className,
      kq.nghe AS listening, kq.noi AS speaking, kq.doc AS reading, kq.viet AS writing,
      CASE WHEN kq.nghe IS NULL OR kq.noi IS NULL OR kq.doc IS NULL OR kq.viet IS NULL THEN NULL
        ELSE ROUND((kq.nghe + kq.noi + kq.doc + kq.viet) / 4, 2) END AS average
     FROM ghi_danh gd JOIN ky_thi kt ON kt.lop_hoc_id = gd.lop_hoc_id
       OR EXISTS (SELECT 1 FROM ket_qua_thi old
         WHERE old.ky_thi_id = kt.id AND old.ghi_danh_id = gd.id)
     JOIN lop_hoc l ON l.id = kt.lop_hoc_id
     LEFT JOIN ket_qua_thi kq ON kq.ky_thi_id = kt.id AND kq.ghi_danh_id = gd.id
     WHERE gd.hoc_vien_id = ? AND gd.trang_thai <> 'da_huy'
     ORDER BY kt.ngay_thi DESC, kt.id DESC`,
    [studentId],
  )
  const [attendance] = await database.query(
    `SELECT bh.id AS sessionId, gd.id AS enrollmentId, l.id AS classId,
      l.ma_lop AS classCode, l.ten_lop AS className,
      bh.bat_dau AS startsAt, dd.trang_thai AS status, dd.ghi_chu AS note
     FROM ghi_danh gd JOIN buoi_hoc bh ON bh.lop_hoc_id = gd.lop_hoc_id
       OR EXISTS (SELECT 1 FROM diem_danh old WHERE old.buoi_hoc_id = bh.id AND old.ghi_danh_id = gd.id)
     LEFT JOIN diem_danh dd ON dd.ghi_danh_id = gd.id AND dd.buoi_hoc_id = bh.id
     JOIN lop_hoc l ON l.id = bh.lop_hoc_id
     WHERE gd.hoc_vien_id = ? AND (gd.trang_thai IN ('dang_hoc', 'hoan_thanh') OR dd.id IS NOT NULL)
       AND bh.bat_dau <= NOW() AND bh.trang_thai <> 'da_huy'
     ORDER BY bh.bat_dau DESC`,
    [studentId],
  )
  response.json({ success: true, data: { exams, attendance } })
})

studentRouter.get('/invoices', async (request, response) => {
  const [rows] = await database.query(
    `SELECT hd.id, hd.ma_hoa_don AS code, hd.so_tien AS amount,
      hd.ngay_lap AS issuedAt, hd.han_thanh_toan AS dueAt,
      hd.trang_thai AS status, hd.ngay_thanh_toan AS paidAt,
      hd.phuong_thuc AS paymentMethod, hd.ly_do_huy AS cancellationReason,
      k.ten_khoa_hoc AS courseName, l.ma_lop AS classCode, l.ten_lop AS className
     FROM hoa_don hd JOIN ghi_danh gd ON gd.id = hd.ghi_danh_id
     JOIN khoa_hoc k ON k.id = gd.khoa_hoc_id
     LEFT JOIN lop_hoc l ON l.id = gd.lop_hoc_id
     WHERE gd.hoc_vien_id = ? ORDER BY hd.id DESC`,
    [request.auth!.userId],
  )
  response.json({ success: true, data: rows })
})

studentRouter.get('/certificates', async (request, response) => {
  const [rows] = await database.query(
    `SELECT cc.id, cc.ma_chung_chi AS code, cc.ma_xac_thuc AS verificationCode,
      cc.trang_thai AS status, cc.ngay_duyet AS approvedAt, cc.ngay_cap AS issuedAt,
      cc.duong_dan_pdf AS pdfPath,
      COALESCE(cc.ten_khoa_hoc_luc_cap, k.ten_khoa_hoc) AS courseName,
      COALESCE(cc.ma_lop_luc_cap, l.ma_lop) AS classCode,
      COALESCE(cc.ten_lop_luc_cap, l.ten_lop) AS className,
      CAST(NULLIF(JSON_UNQUOTE(JSON_EXTRACT(cc.ho_so_luc_duyet, '$.average')), 'null') AS DECIMAL(10,4)) AS average,
      COUNT(lt.id) AS downloads
     FROM chung_chi cc JOIN ghi_danh gd ON gd.id = cc.ghi_danh_id
     JOIN khoa_hoc k ON k.id = gd.khoa_hoc_id
     LEFT JOIN lop_hoc l ON l.id = gd.lop_hoc_id
     LEFT JOIN luot_tai_chung_chi lt ON lt.chung_chi_id = cc.id
     WHERE gd.hoc_vien_id = ? GROUP BY cc.id ORDER BY cc.id DESC`,
    [request.auth!.userId],
  )
  response.json({ success: true, data: rows })
})

studentRouter.get('/certificate-downloads', async (request, response) => {
  const [rows] = await database.query(
    `SELECT lt.id, cc.ma_chung_chi AS certificateCode,
      COALESCE(cc.ten_khoa_hoc_luc_cap, k.ten_khoa_hoc) AS courseName,
      lt.thoi_gian_tai AS downloadedAt
     FROM luot_tai_chung_chi lt JOIN chung_chi cc ON cc.id = lt.chung_chi_id
     JOIN ghi_danh gd ON gd.id = cc.ghi_danh_id
     JOIN khoa_hoc k ON k.id = gd.khoa_hoc_id
     WHERE gd.hoc_vien_id = ? ORDER BY lt.thoi_gian_tai DESC`,
    [request.auth!.userId],
  )
  response.json({ success: true, data: rows })
})

studentRouter.get('/certificate-eligibility', async (request, response) => {
  const [rows] = await database.query<SimpleRow[]>(
    `SELECT gd.id AS enrollmentId, gd.trang_thai AS enrollmentStatus,
      COALESCE(cc.ten_khoa_hoc_luc_cap, k.ten_khoa_hoc) AS courseName, l.id AS classId,
      COALESCE(cc.ma_lop_luc_cap, l.ma_lop) AS classCode,
      COALESCE(cc.ten_lop_luc_cap, l.ten_lop) AS className,
      cc.trang_thai AS certificateStatus,
      cc.ho_so_luc_duyet AS approvalSnapshot,
      ${attendanceRateSql} AS attendance, ${attendanceCountColumns},
      (SELECT AVG((kq.nghe + kq.noi + kq.doc + kq.viet) / 4)
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
        AND NOT EXISTS(SELECT 1 FROM hoa_don hd WHERE hd.ghi_danh_id = gd.id AND hd.trang_thai = 'chua_thanh_toan')) AS paid
     FROM ghi_danh gd JOIN khoa_hoc k ON k.id = gd.khoa_hoc_id
     LEFT JOIN lop_hoc l ON l.id = gd.lop_hoc_id
     LEFT JOIN chung_chi cc ON cc.ghi_danh_id = gd.id
     ${attendanceStatsJoin}
     WHERE gd.hoc_vien_id = ? AND gd.trang_thai <> 'da_huy'
     ORDER BY gd.id DESC`,
    [request.auth!.userId],
  )
  response.json({
    success: true,
    data: rows.map((item) => {
      const snapshot = item.approvalSnapshot
        ? (typeof item.approvalSnapshot === 'string' ? JSON.parse(item.approvalSnapshot) : item.approvalSnapshot) as Record<string, unknown>
        : null
      const value = (key: string) => snapshot ? snapshot[key] : item[key]
      const averageValue = value('average')
      const average = averageValue === null || averageValue === undefined || averageValue === 'null' ? null : Number(averageValue)
      const input = {
        enrollmentStatus: String(value('enrollmentStatus')),
        paid: [true, 1, '1'].includes(value('paid') as boolean | number | string),
        attendance: Number(value('attendance')),
        expectedAttendance: Number(value('expectedAttendance')),
        recordedAttendance: Number(value('recordedAttendance')),
        average: average !== null && Number.isFinite(average) ? average : null,
        requiredExams: Number(value('requiredExams')),
        completedExams: Number(value('completedExams')),
      }
      const { approvalSnapshot: _snapshot, ...output } = item
      return {
        ...output, ...input, presentAttendance: Number(value('presentAttendance')),
        eligible: isCertificateEligible(input), ineligibleReasons: getCertificateEligibilityReasons(input),
      }
    }),
  })
})

studentRouter.post('/certificates/:id/download', async (request, response) => {
  const certificateId = positiveInt(request.params.id, 'Chứng chỉ')
  const [rows] = await database.query<SimpleRow[]>(
    `SELECT cc.duong_dan_pdf AS pdfPath, cc.ma_xac_thuc AS verificationCode
     FROM chung_chi cc JOIN ghi_danh gd ON gd.id = cc.ghi_danh_id
     WHERE cc.id = ? AND gd.hoc_vien_id = ? AND cc.trang_thai = 'da_cap'`,
    [certificateId, request.auth!.userId],
  )
  const certificate = rows[0]
  if (!certificate) throw new HttpError(404, 'Không tìm thấy chứng chỉ đã cấp')
  if (!certificate.pdfPath) throw new HttpError(409, 'Tệp PDF của chứng chỉ chưa sẵn sàng')
  let filename: string | undefined
  try { filename = new URL(String(certificate.pdfPath)).pathname.match(/^\/uploads\/certificates\/([a-f0-9]{48}\.pdf)$/)?.[1] }
  catch { /* Invalid stored URLs are handled as an unavailable file. */ }
  if (!filename) throw new HttpError(409, 'Đường dẫn PDF chứng chỉ không hợp lệ; liên hệ trung tâm tạo lại tệp')
  try {
    const file = await stat(join(env.storageDir, 'certificates', filename))
    if (!file.isFile() || file.size === 0) throw new Error('PDF unavailable')
  } catch { throw new HttpError(409, 'Tệp PDF không còn tồn tại; liên hệ trung tâm tạo lại tệp chứng chỉ') }
  const [result] = await database.execute<ResultSetHeader>(
    'INSERT INTO luot_tai_chung_chi (chung_chi_id) VALUES (?)',
    [certificateId],
  )
  response.status(201).json({
    success: true,
    data: { downloadId: result.insertId, pdfPath: certificate.pdfPath, verificationCode: certificate.verificationCode },
  })
})
