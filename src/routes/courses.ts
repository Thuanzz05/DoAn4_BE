import { Router } from 'express'
import type { ResultSetHeader, RowDataPacket } from 'mysql2'
import { database } from '../config/database'
import { requireAuth, requireRole } from '../middlewares/auth'
import { HttpError } from '../utils/http-error'

type CourseRow = RowDataPacket & {
  id: number
  code: string
  name: string
  language: string
  level: string
  sessions: number
  tuition: number
  description: string | null
  status: 'dang_mo' | 'tam_an'
  linkedClasses: number
}
type CourseInput = {
  code: string
  name: string
  language: string
  level: string
  sessions: number
  tuition: number
  description: string | null
  status: 'dang_mo' | 'tam_an'
}

export const coursesRouter = Router()
const selectCourses = `SELECT id, ma_khoa_hoc AS code, ten_khoa_hoc AS name,
  ngoai_ngu AS language, trinh_do AS level, so_buoi AS sessions,
  hoc_phi AS tuition, mo_ta AS description, trang_thai AS status,
  (SELECT COUNT(*) FROM lop_hoc WHERE khoa_hoc_id = khoa_hoc.id) AS linkedClasses
  FROM khoa_hoc`

function parseCourse(body: Record<string, unknown>, current?: CourseRow): CourseInput {
  const text = (key: keyof CourseInput, label: string): string => {
    const value = body[key] ?? current?.[key]
    if (typeof value !== 'string' || !value.trim()) throw new HttpError(400, `${label} là bắt buộc`)
    return value.trim()
  }
  const number = (key: 'sessions' | 'tuition', label: string): number => {
    const value = Number(body[key] ?? current?.[key])
    if (!Number.isFinite(value) || value <= 0) throw new HttpError(400, `${label} phải lớn hơn 0`)
    return value
  }
  const status = body.status ?? current?.status ?? 'dang_mo'
  if (status !== 'dang_mo' && status !== 'tam_an') throw new HttpError(400, 'Trạng thái khóa học không hợp lệ')
  const descriptionValue = body.description ?? current?.description ?? null
  return {
    code: text('code', 'Mã khóa học').toUpperCase(),
    name: text('name', 'Tên khóa học'),
    language: text('language', 'Ngoại ngữ'),
    level: text('level', 'Trình độ'),
    sessions: Math.trunc(number('sessions', 'Số buổi')),
    tuition: Math.trunc(number('tuition', 'Học phí')),
    description: typeof descriptionValue === 'string' && descriptionValue.trim() ? descriptionValue.trim() : null,
    status,
  }
}

coursesRouter.get('/', async (_request, response) => {
  const [rows] = await database.query<CourseRow[]>(`${selectCourses} WHERE trang_thai = 'dang_mo' ORDER BY id DESC`)
  response.json({ success: true, data: rows })
})

coursesRouter.get('/all', requireAuth, requireRole('quan_tri'), async (_request, response) => {
  const [rows] = await database.query<CourseRow[]>(`${selectCourses} ORDER BY id DESC`)
  response.json({ success: true, data: rows })
})

coursesRouter.get('/:id', async (request, response) => {
  const [rows] = await database.query<CourseRow[]>(`${selectCourses} WHERE id = ? LIMIT 1`, [request.params.id])
  if (!rows[0]) throw new HttpError(404, 'Không tìm thấy khóa học')
  response.json({ success: true, data: rows[0] })
})

coursesRouter.post('/', requireAuth, requireRole('quan_tri'), async (request, response) => {
  const course = parseCourse(request.body)
  try {
    const [result] = await database.execute<ResultSetHeader>(
      `INSERT INTO khoa_hoc
        (ma_khoa_hoc, ten_khoa_hoc, ngoai_ngu, trinh_do, so_buoi, hoc_phi, mo_ta, trang_thai)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [course.code, course.name, course.language, course.level, course.sessions, course.tuition, course.description, course.status],
    )
    const [rows] = await database.query<CourseRow[]>(`${selectCourses} WHERE id = ?`, [result.insertId])
    response.status(201).json({ success: true, data: rows[0] })
  } catch (error) {
    if ((error as { code?: string }).code === 'ER_DUP_ENTRY') throw new HttpError(409, 'Mã khóa học đã tồn tại')
    throw error
  }
})

coursesRouter.patch('/:id', requireAuth, requireRole('quan_tri'), async (request, response) => {
  const [rows] = await database.query<CourseRow[]>(`${selectCourses} WHERE id = ? LIMIT 1`, [request.params.id])
  if (!rows[0]) throw new HttpError(404, 'Không tìm thấy khóa học')
  const course = parseCourse(request.body, rows[0])
  try {
    await database.execute(
      `UPDATE khoa_hoc SET ma_khoa_hoc = ?, ten_khoa_hoc = ?, ngoai_ngu = ?, trinh_do = ?,
       so_buoi = ?, hoc_phi = ?, mo_ta = ?, trang_thai = ? WHERE id = ?`,
      [course.code, course.name, course.language, course.level, course.sessions, course.tuition, course.description, course.status, request.params.id],
    )
  } catch (error) {
    if ((error as { code?: string }).code === 'ER_DUP_ENTRY') throw new HttpError(409, 'Mã khóa học đã tồn tại')
    throw error
  }
  const [updated] = await database.query<CourseRow[]>(`${selectCourses} WHERE id = ?`, [request.params.id])
  response.json({ success: true, data: updated[0] })
})

coursesRouter.delete('/:id', requireAuth, requireRole('quan_tri'), async (request, response) => {
  try {
    const [result] = await database.execute<ResultSetHeader>('DELETE FROM khoa_hoc WHERE id = ?', [request.params.id])
    if (!result.affectedRows) throw new HttpError(404, 'Không tìm thấy khóa học')
    response.status(204).send()
  } catch (error) {
    if ((error as { code?: string }).code === 'ER_ROW_IS_REFERENCED_2') {
      throw new HttpError(409, 'Không thể xóa khóa học đang có lớp hoặc học viên liên kết')
    }
    throw error
  }
})
