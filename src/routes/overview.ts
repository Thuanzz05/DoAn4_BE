import { Router } from 'express'
import type { ResultSetHeader, RowDataPacket } from 'mysql2/promise'
import { database } from '../config/database'
import { requireAuth, requireRole } from '../middlewares/auth'
import { HttpError } from '../utils/http-error'
import { getNotificationTarget } from '../utils/operations'

type SimpleRow = RowDataPacket & Record<string, string | number | null>

export const overviewRouter = Router()

function positiveInt(value: unknown, label: string): number {
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < 1) throw new HttpError(400, `${label} phải là số nguyên dương`)
  return parsed
}

function text(value: unknown, label: string, maxLength: number): string {
  if (typeof value !== 'string' || !value.trim()) throw new HttpError(400, `${label} là bắt buộc`)
  return value.trim().slice(0, maxLength)
}

overviewRouter.get('/admin/dashboard', requireAuth, requireRole('quan_tri'), async (_request, response) => {
  const [[metrics], [todaySessions], [recentEnrollments]] = await Promise.all([
    database.query<SimpleRow[]>(
      `SELECT
        (SELECT COUNT(*) FROM nguoi_dung WHERE vai_tro = 'hoc_vien' AND dang_hoat_dong = TRUE) AS students,
        (SELECT COUNT(*) FROM nguoi_dung WHERE vai_tro = 'giao_vien' AND dang_hoat_dong = TRUE) AS teachers,
        (SELECT COUNT(*) FROM khoa_hoc WHERE trang_thai = 'dang_mo') AS openCourses,
        (SELECT COUNT(*) FROM lop_hoc WHERE trang_thai = 'dang_hoc') AS activeClasses,
        (SELECT COALESCE(SUM(so_tien), 0) FROM hoa_don
          WHERE trang_thai = 'da_thanh_toan' AND YEAR(ngay_thanh_toan) = YEAR(CURDATE())
            AND MONTH(ngay_thanh_toan) = MONTH(CURDATE())) AS monthlyRevenue,
        (SELECT COALESCE(SUM(so_tien), 0) FROM hoa_don WHERE trang_thai = 'chua_thanh_toan') AS debt,
        (SELECT COUNT(*) FROM hoa_don
          WHERE trang_thai = 'chua_thanh_toan' AND han_thanh_toan < CURDATE()) AS overdueInvoices,
        (SELECT COUNT(*) FROM chung_chi WHERE trang_thai = 'da_duyet') AS certificatesWaitingIssue`,
    ),
    database.query(
      `SELECT bh.id, bh.bat_dau AS startsAt, bh.ket_thuc AS endsAt,
        l.ma_lop AS classCode, l.ten_lop AS className,
        gv.ho_ten AS teacherName, p.ma_phong AS roomCode, bh.trang_thai AS status
       FROM buoi_hoc bh JOIN lop_hoc l ON l.id = bh.lop_hoc_id
       JOIN nguoi_dung gv ON gv.id = bh.giao_vien_id
       JOIN phong_hoc p ON p.id = bh.phong_hoc_id
       WHERE DATE(bh.bat_dau) = CURDATE() ORDER BY bh.bat_dau`,
    ),
    database.query(
      `SELECT gd.id, gd.ngay_ghi_danh AS enrolledAt, gd.trang_thai AS status,
        hv.ma_nguoi_dung AS studentCode, hv.ho_ten AS studentName,
        k.ten_khoa_hoc AS courseName, l.ten_lop AS className
       FROM ghi_danh gd JOIN nguoi_dung hv ON hv.id = gd.hoc_vien_id
       JOIN khoa_hoc k ON k.id = gd.khoa_hoc_id
       LEFT JOIN lop_hoc l ON l.id = gd.lop_hoc_id
       ORDER BY gd.id DESC LIMIT 8`,
    ),
  ])
  response.json({ success: true, data: { metrics: metrics[0], todaySessions, recentEnrollments } })
})

overviewRouter.get('/notifications', requireAuth, async (request, response) => {
  const unreadOnly = request.query.unreadOnly === 'true'
  const page = request.query.page === undefined ? 1 : positiveInt(request.query.page, 'Trang')
  const pageSize = request.query.pageSize === undefined ? 20 : positiveInt(request.query.pageSize, 'Số thông báo mỗi trang')
  if (pageSize > 100 || page > 100_000) throw new HttpError(400, 'Phân trang thông báo không hợp lệ')
  const paginated = request.query.paginated === 'true'
  const [rows] = await database.query(
    `SELECT id, tieu_de AS title, noi_dung AS content, da_doc_luc AS readAt,
      ngay_tao AS createdAt FROM thong_bao
     WHERE nguoi_dung_id = ? AND (? = FALSE OR da_doc_luc IS NULL)
     ORDER BY id DESC LIMIT ? OFFSET ?`,
    [request.auth!.userId, unreadOnly, paginated ? pageSize : 50, paginated ? (page - 1) * pageSize : 0],
  )
  if (!paginated) { response.json({ success: true, data: rows }); return }
  const [counts] = await database.query<SimpleRow[]>(
    `SELECT COUNT(CASE WHEN ? = FALSE OR da_doc_luc IS NULL THEN 1 END) AS total,
      COUNT(CASE WHEN da_doc_luc IS NULL THEN 1 END) AS unread FROM thong_bao WHERE nguoi_dung_id = ?`,
    [unreadOnly, request.auth!.userId],
  )
  response.json({ success: true, data: { items: rows, pagination: { page, pageSize,
    total: Number(counts[0].total), unread: Number(counts[0].unread) } } })
})

overviewRouter.patch('/notifications/read-all', requireAuth, async (request, response) => {
  const hasIds = request.body?.ids !== undefined
  if (hasIds && (!Array.isArray(request.body.ids) || request.body.ids.length > 100)) {
    throw new HttpError(400, 'Danh sách thông báo không hợp lệ (tối đa 100)')
  }
  const ids: number[] = hasIds ? [...new Set<number>(request.body.ids.map((id: unknown) => positiveInt(id, 'Thông báo')))] : []
  if (hasIds && ids.length === 0) { response.json({ success: true, data: { updated: 0 } }); return }
  const [result] = await database.execute<ResultSetHeader>(
    `UPDATE thong_bao SET da_doc_luc = NOW() WHERE nguoi_dung_id = ? AND da_doc_luc IS NULL
      ${hasIds ? `AND id IN (${ids.map(() => '?').join(',')})` : ''}`,
    [request.auth!.userId, ...ids],
  )
  response.json({ success: true, data: { updated: result.affectedRows } })
})

overviewRouter.patch('/notifications/:id/read', requireAuth, async (request, response) => {
  const notificationId = positiveInt(request.params.id, 'Thông báo')
  const [result] = await database.execute<ResultSetHeader>(
    'UPDATE thong_bao SET da_doc_luc = COALESCE(da_doc_luc, NOW()) WHERE id = ? AND nguoi_dung_id = ?',
    [notificationId, request.auth!.userId],
  )
  if (!result.affectedRows) throw new HttpError(404, 'Không tìm thấy thông báo')
  response.json({ success: true, message: 'Đã đánh dấu thông báo là đã đọc' })
})

overviewRouter.post('/notifications', requireAuth, requireRole('quan_tri'), async (request, response) => {
  const title = text(request.body.title, 'Tiêu đề', 150)
  const content = text(request.body.content, 'Nội dung', 10_000)
  const target = getNotificationTarget(request.body.userId, request.body.role)
  if (!target) throw new HttpError(400, 'Chỉ chọn một người dùng hoặc một vai trò nhận thông báo')
  const [result] = await database.execute<ResultSetHeader>(
    `INSERT INTO thong_bao (nguoi_dung_id, tieu_de, noi_dung)
     SELECT id, ?, ? FROM nguoi_dung
     WHERE dang_hoat_dong = TRUE
       AND (? IS NULL OR id = ?) AND (? IS NULL OR vai_tro = ?)`,
    [title, content, target.userId, target.userId, target.role, target.role],
  )
  if (!result.affectedRows) throw new HttpError(404, 'Không tìm thấy người nhận phù hợp')
  response.status(201).json({ success: true, data: { sent: result.affectedRows } })
})
