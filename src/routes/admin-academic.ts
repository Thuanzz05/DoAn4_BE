import { Router } from 'express'
import type { PoolConnection, ResultSetHeader, RowDataPacket } from 'mysql2/promise'
import { database } from '../config/database'
import { requireAuth, requireRole } from '../middlewares/auth'
import { academicExamSelect, asAcademicExam, classAcademicWorkbook, loadClassAcademic } from '../services/class-academic'
import { academicId, assertExamUnlocked, examDetails, examReason, type ExamDetails } from '../utils/academic'
import { HttpError } from '../utils/http-error'

type DataRow = RowDataPacket & Record<string, string | number | null>
export const adminAcademicRouter = Router()
adminAcademicRouter.use(['/classes', '/exams'], requireAuth, requireRole('quan_tri'))

async function lockExamClass(connection: PoolConnection, classId: number): Promise<void> {
  const [classes] = await connection.query<DataRow[]>('SELECT id, trang_thai AS status FROM lop_hoc WHERE id = ? FOR UPDATE', [classId])
  if (!classes[0]) throw new HttpError(404, 'Không tìm thấy lớp học')
  const [certificates] = await connection.query<DataRow[]>(
    'SELECT cc.id FROM chung_chi cc JOIN ghi_danh gd ON gd.id = cc.ghi_danh_id WHERE gd.lop_hoc_id = ? LIMIT 1 FOR UPDATE', [classId],
  )
  assertExamUnlocked(String(classes[0].status), certificates.length > 0)
}

async function ensureFutureDeadline(connection: PoolConnection, deadline: string | null): Promise<void> {
  if (!deadline) return
  const [rows] = await connection.query<DataRow[]>('SELECT ? <= NOW() AS expired', [deadline])
  if (Number(rows[0]?.expired)) throw new HttpError(400, 'Hạn sửa điểm mới phải ở tương lai')
}

adminAcademicRouter.get('/classes/:id/academic', async (request, response) => {
  const data = await loadClassAcademic(academicId(request.params.id, 'Lớp học'))
  response.json({ success: true, data })
})

adminAcademicRouter.get('/classes/:id/academic/export', async (request, response) => {
  const classId = academicId(request.params.id, 'Lớp học')
  const section = request.query.section === undefined ? 'all' : String(request.query.section)
  const data = await loadClassAcademic(classId)
  const buffer = await classAcademicWorkbook(data, section)
  response.set({ 'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'Content-Disposition': `attachment; filename="hoc-vu-lop-${classId}-${section}.xlsx"` })
  response.send(buffer)
})

adminAcademicRouter.get('/exams', async (request, response) => {
  const classId = request.query.classId === undefined ? null : academicId(request.query.classId, 'Lớp học')
  const [rows] = await database.query<DataRow[]>(`${academicExamSelect} WHERE (? IS NULL OR kt.lop_hoc_id = ?) ORDER BY kt.id DESC`, [classId, classId])
  response.json({ success: true, data: rows.map(asAcademicExam) })
})

adminAcademicRouter.post('/exams', async (request, response) => {
  const classId = academicId(request.body.classId, 'Lớp học')
  const details = examDetails(request.body)
  const reason = examReason(request.body.reason)
  const connection = await database.getConnection()
  try {
    await connection.beginTransaction()
    await lockExamClass(connection, classId)
    await ensureFutureDeadline(connection, details.deadline)
    const [result] = await connection.execute<ResultSetHeader>(
      'INSERT INTO ky_thi (lop_hoc_id, ten_ky_thi, ngay_thi, han_sua_diem) VALUES (?, ?, ?, ?)',
      [classId, details.name, details.examDate, details.deadline],
    )
    await connection.execute(
      'INSERT INTO lich_su_ky_thi (ky_thi_id, nguoi_thay_doi_id, hanh_dong, ly_do, du_lieu_truoc, du_lieu_sau) VALUES (?, ?, ?, ?, NULL, ?)',
      [result.insertId, request.auth!.userId, 'tao', reason, JSON.stringify({ classId, ...details })],
    )
    const [rows] = await connection.query<DataRow[]>(`${academicExamSelect} WHERE kt.id = ?`, [result.insertId])
    await connection.commit()
    response.status(201).json({ success: true, data: asAcademicExam(rows[0]) })
  } catch (error) { await connection.rollback(); throw error }
  finally { connection.release() }
})

adminAcademicRouter.patch('/exams/:id', async (request, response) => {
  const examId = academicId(request.params.id, 'Kỳ thi')
  const reason = examReason(request.body.reason)
  if (!['name', 'examDate', 'deadline'].some((field) => request.body[field] !== undefined)) {
    throw new HttpError(400, 'Cần có thông tin kỳ thi hoặc hạn sửa điểm để cập nhật')
  }
  const connection = await database.getConnection()
  try {
    await connection.beginTransaction()
    const [lookup] = await connection.query<DataRow[]>('SELECT lop_hoc_id AS classId FROM ky_thi WHERE id = ?', [examId])
    if (!lookup[0]) throw new HttpError(404, 'Không tìm thấy kỳ thi')
    const classId = Number(lookup[0].classId)
    if (request.body.classId !== undefined && academicId(request.body.classId, 'Lớp học') !== classId) {
      throw new HttpError(400, 'Không được chuyển kỳ thi sang lớp khác')
    }
    await lockExamClass(connection, classId)
    const [rows] = await connection.query<DataRow[]>(
      'SELECT ten_ky_thi AS name, ngay_thi AS examDate, han_sua_diem AS deadline FROM ky_thi WHERE id = ? FOR UPDATE', [examId],
    )
    const current: ExamDetails = { name: String(rows[0].name), examDate: rows[0].examDate === null ? null : String(rows[0].examDate),
      deadline: rows[0].deadline === null ? null : String(rows[0].deadline) }
    const details = examDetails(request.body, current)
    if (JSON.stringify(details) === JSON.stringify(current)) throw new HttpError(400, 'Thông tin kỳ thi không có thay đổi')
    if (details.deadline !== current.deadline) await ensureFutureDeadline(connection, details.deadline)
    const action = details.deadline && (!current.deadline || details.deadline > current.deadline) ? 'gia_han' : 'cap_nhat'
    await connection.execute('UPDATE ky_thi SET ten_ky_thi = ?, ngay_thi = ?, han_sua_diem = ? WHERE id = ?',
      [details.name, details.examDate, details.deadline, examId])
    await connection.execute(
      'INSERT INTO lich_su_ky_thi (ky_thi_id, nguoi_thay_doi_id, hanh_dong, ly_do, du_lieu_truoc, du_lieu_sau) VALUES (?, ?, ?, ?, ?, ?)',
      [examId, request.auth!.userId, action, reason, JSON.stringify({ classId, ...current }), JSON.stringify({ classId, ...details })],
    )
    await connection.execute(
      `INSERT INTO thong_bao (nguoi_dung_id, tieu_de, noi_dung)
       SELECT giao_vien_id, 'Cập nhật kỳ thi', ? FROM lop_hoc WHERE id = ? AND giao_vien_id IS NOT NULL`,
      [`Kỳ thi ${details.name} đã được cập nhật${details.deadline ? `; hạn sửa điểm: ${details.deadline}` : ''}. Lý do: ${reason}`, classId],
    )
    const [updated] = await connection.query<DataRow[]>(`${academicExamSelect} WHERE kt.id = ?`, [examId])
    await connection.commit()
    response.json({ success: true, data: asAcademicExam(updated[0]) })
  } catch (error) { await connection.rollback(); throw error }
  finally { connection.release() }
})

adminAcademicRouter.get('/exams/:id/history', async (request, response) => {
  const examId = academicId(request.params.id, 'Kỳ thi')
  const [exams] = await database.query<DataRow[]>('SELECT id FROM ky_thi WHERE id = ?', [examId])
  if (!exams[0]) throw new HttpError(404, 'Không tìm thấy kỳ thi')
  const [rows] = await database.query<RowDataPacket[]>(
    `SELECT ls.id, ls.hanh_dong AS action, ls.ly_do AS reason, ls.du_lieu_truoc AS beforeData,
      ls.du_lieu_sau AS afterData, ls.ngay_thay_doi AS changedAt, nd.ho_ten AS actorName
     FROM lich_su_ky_thi ls JOIN nguoi_dung nd ON nd.id = ls.nguoi_thay_doi_id
     WHERE ls.ky_thi_id = ? ORDER BY ls.id DESC`, [examId],
  )
  const parse = (value: unknown) => typeof value === 'string' ? JSON.parse(value) : value
  response.json({ success: true, data: rows.map((row) => ({ id: row.id, action: row.action, reason: row.reason,
    before: parse(row.beforeData), after: parse(row.afterData), changedAt: row.changedAt, actorName: row.actorName })) })
})
