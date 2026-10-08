import { Router } from 'express'
import type { ResultSetHeader, RowDataPacket } from 'mysql2/promise'
import { database } from '../config/database'
import { requireAuth, requireRole } from '../middlewares/auth'
import { academicId, examReason } from '../utils/academic'
import { normalizeLocalDateTime } from '../utils/date-time'
import { HttpError } from '../utils/http-error'

type DataRow = RowDataPacket & Record<string, string | number | null>
export const placementAssessmentsRouter = Router()

const selectAssessments = `SELECT kt.id, kt.hoc_vien_id AS studentId, hv.ma_nguoi_dung AS studentCode,
  hv.ho_ten AS studentName, kt.ngay_danh_gia AS assessedAt, kt.ngoai_ngu AS language,
  kt.diem AS score, kt.trinh_do AS level, kt.khoa_hoc_de_xuat_id AS recommendedCourseId,
  kt.ma_khoa_hoc_luc_de_xuat AS recommendedCourseCode, kt.ten_khoa_hoc_luc_de_xuat AS recommendedCourseName,
  kt.ngoai_ngu_luc_de_xuat AS recommendedCourseLanguage, kt.trinh_do_luc_de_xuat AS recommendedCourseLevel,
  kt.ghi_chu AS note, kt.trang_thai AS status, kt.nguoi_danh_gia_id AS createdById,
  nd.ho_ten AS createdByName, kt.ngay_tao AS createdAt, kt.nguoi_huy_id AS canceledById,
  nh.ho_ten AS canceledByName, kt.ngay_huy AS canceledAt, kt.ly_do_huy AS cancelReason
  FROM kiem_tra_dau_vao kt JOIN nguoi_dung hv ON hv.id = kt.hoc_vien_id
  JOIN nguoi_dung nd ON nd.id = kt.nguoi_danh_gia_id
  LEFT JOIN nguoi_dung nh ON nh.id = kt.nguoi_huy_id`

function requiredText(value: unknown, label: string, maximum: number): string {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > maximum) {
    throw new HttpError(400, `${label} là bắt buộc và tối đa ${maximum} ký tự`)
  }
  return value.trim()
}

placementAssessmentsRouter.get('/placement-assessments', requireAuth, requireRole('quan_tri'), async (request, response) => {
  const studentId = academicId(request.query.studentId, 'Học viên')
  const [students] = await database.query<DataRow[]>("SELECT id FROM nguoi_dung WHERE id = ? AND vai_tro = 'hoc_vien'", [studentId])
  if (!students[0]) throw new HttpError(404, 'Không tìm thấy học viên')
  const [rows] = await database.query<DataRow[]>(`${selectAssessments} WHERE kt.hoc_vien_id = ? ORDER BY kt.ngay_danh_gia DESC, kt.id DESC`, [studentId])
  response.json({ success: true, data: rows })
})

placementAssessmentsRouter.get('/student/placement-assessments', requireAuth, requireRole('hoc_vien'), async (request, response) => {
  const [rows] = await database.query<DataRow[]>(`${selectAssessments} WHERE kt.hoc_vien_id = ? ORDER BY kt.ngay_danh_gia DESC, kt.id DESC`, [request.auth!.userId])
  response.json({ success: true, data: rows })
})

placementAssessmentsRouter.post('/placement-assessments', requireAuth, requireRole('quan_tri'), async (request, response) => {
  const body = request.body
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'Dữ liệu kiểm tra đầu vào không hợp lệ')
  const studentId = academicId(body.studentId, 'Học viên')
  const assessedAt = body.assessedAt
  if (typeof assessedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(assessedAt) || assessedAt < '1000-01-01'
    || !normalizeLocalDateTime(`${assessedAt}T00:00`)) {
    throw new HttpError(400, 'Ngày kiểm tra không hợp lệ (YYYY-MM-DD)')
  }
  const language = requiredText(body.language, 'Ngoại ngữ', 50)
  const level = requiredText(body.level, 'Trình độ', 50)
  const score = body.score
  if (typeof score !== 'number' || !Number.isFinite(score) || score < 0 || score > 10
    || Math.abs(score * 100 - Math.round(score * 100)) > 1e-8) {
    throw new HttpError(400, 'Điểm phải là số từ 0 đến 10, tối đa 2 chữ số thập phân')
  }
  const recommendedCourseId = body.recommendedCourseId === undefined || body.recommendedCourseId === null
    ? null : academicId(body.recommendedCourseId, 'Khóa học đề xuất')
  if (body.note !== undefined && body.note !== null && (typeof body.note !== 'string' || body.note.trim().length > 1000)) {
    throw new HttpError(400, 'Ghi chú phải là chuỗi tối đa 1000 ký tự')
  }
  const note = typeof body.note === 'string' && body.note.trim() ? body.note.trim() : null
  const connection = await database.getConnection()
  try {
    await connection.beginTransaction()
    const [students] = await connection.query<DataRow[]>('SELECT id, vai_tro AS role, dang_hoat_dong AS active FROM nguoi_dung WHERE id = ? FOR UPDATE', [studentId])
    const student = students[0]
    if (!student || student.role !== 'hoc_vien') throw new HttpError(404, 'Không tìm thấy học viên')
    if (!Number(student.active)) throw new HttpError(409, 'Không thể ghi nhận kiểm tra đầu vào cho học viên đã khóa')
    const [dates] = await connection.query<DataRow[]>('SELECT ? > CURDATE() AS future', [assessedAt])
    if (Number(dates[0].future)) throw new HttpError(400, 'Ngày kiểm tra không được ở tương lai')
    let course: DataRow | undefined
    if (recommendedCourseId !== null) {
      const [courses] = await connection.query<DataRow[]>(`SELECT ma_khoa_hoc AS code, ten_khoa_hoc AS name,
        ngoai_ngu AS language, trinh_do AS level, trang_thai AS status FROM khoa_hoc WHERE id = ? FOR UPDATE`, [recommendedCourseId])
      course = courses[0]
      if (!course) throw new HttpError(404, 'Không tìm thấy khóa học đề xuất')
      if (course.status !== 'dang_mo') throw new HttpError(409, 'Khóa học đề xuất hiện không mở đăng ký')
      if (String(course.language).trim().toLowerCase() !== language.toLowerCase()) throw new HttpError(400, 'Khóa học đề xuất phải cùng ngoại ngữ kiểm tra')
    }
    const [result] = await connection.execute<ResultSetHeader>(`INSERT INTO kiem_tra_dau_vao
      (hoc_vien_id, ngay_danh_gia, ngoai_ngu, diem, trinh_do, khoa_hoc_de_xuat_id,
       ma_khoa_hoc_luc_de_xuat, ten_khoa_hoc_luc_de_xuat, ngoai_ngu_luc_de_xuat, trinh_do_luc_de_xuat,
       ghi_chu, nguoi_danh_gia_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [studentId, assessedAt, language, score, level, recommendedCourseId, course?.code ?? null,
      course?.name ?? null, course?.language ?? null, course?.level ?? null, note, request.auth!.userId])
    const [rows] = await connection.query<DataRow[]>(`${selectAssessments} WHERE kt.id = ?`, [result.insertId])
    await connection.commit()
    response.status(201).json({ success: true, data: rows[0] })
  } catch (error) { await connection.rollback(); throw error }
  finally { connection.release() }
})

placementAssessmentsRouter.post('/placement-assessments/:id/cancel', requireAuth, requireRole('quan_tri'), async (request, response) => {
  const assessmentId = academicId(request.params.id, 'Kiểm tra đầu vào')
  const reason = examReason(request.body?.reason)
  const connection = await database.getConnection()
  try {
    await connection.beginTransaction()
    const [rows] = await connection.query<DataRow[]>('SELECT trang_thai AS status FROM kiem_tra_dau_vao WHERE id = ? FOR UPDATE', [assessmentId])
    if (!rows[0]) throw new HttpError(404, 'Không tìm thấy kiểm tra đầu vào')
    if (rows[0].status === 'da_huy') throw new HttpError(409, 'Kiểm tra đầu vào đã hủy')
    await connection.execute(`UPDATE kiem_tra_dau_vao SET trang_thai = 'da_huy', nguoi_huy_id = ?,
      ngay_huy = NOW(), ly_do_huy = ? WHERE id = ?`, [request.auth!.userId, reason, assessmentId])
    const [updated] = await connection.query<DataRow[]>(`${selectAssessments} WHERE kt.id = ?`, [assessmentId])
    await connection.commit()
    response.json({ success: true, data: updated[0] })
  } catch (error) { await connection.rollback(); throw error }
  finally { connection.release() }
})
