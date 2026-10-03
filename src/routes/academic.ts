import { randomInt } from 'node:crypto'
import { Router } from 'express'
import type { PoolConnection, ResultSetHeader, RowDataPacket } from 'mysql2/promise'
import { database } from '../config/database'
import { requireAuth, requireRole } from '../middlewares/auth'
import { canChangeEnrollmentStatus, type EnrollmentStatus } from '../utils/enrollment'
import { HttpError } from '../utils/http-error'
import { canChangeClassPlan, generateSessionDates, roomCanHostClass, shouldSyncTeacherAssignment, type WeeklySlot } from '../utils/schedule'

type ClassStatus = 'sap_khai_giang' | 'dang_hoc' | 'da_ket_thuc' | 'da_huy'
type ClassRow = RowDataPacket & {
  id: number
  code: string
  name: string
  courseId: number
  courseName: string
  language: string
  teacherId: number | null
  teacherName: string | null
  startDate: string
  sessions: number
  capacity: number
  status: ClassStatus
  enrolled: number
  generatedSessions: number
  completedSessions: number
}
type ScheduleRow = RowDataPacket & {
  id: number
  classId: number
  className: string
  teacherId: number
  teacherName: string
  roomId: number
  roomCode: string
  dayOfWeek: number
  startTime: string
  endTime: string
}
type ScheduleSlotRow = RowDataPacket & {
  id: number
  roomId: number
  dayOfWeek: number
  startTime: string
  endTime: string
}
type EnrollmentRow = RowDataPacket & {
  id: number
  studentId: number
  studentCode: string
  studentName: string
  courseId: number
  courseName: string
  classId: number | null
  className: string | null
  enrolledAt: string
  status: EnrollmentStatus
  attendance: number
}
type SimpleRow = RowDataPacket & Record<string, string | number | null>
type QueryConnection = PoolConnection | typeof database

export const academicRouter = Router()
academicRouter.use(['/rooms', '/classes', '/enrollments', '/schedules'], requireAuth, requireRole('quan_tri'))

const classSelect = `SELECT l.id, l.ma_lop AS code, l.ten_lop AS name,
  l.khoa_hoc_id AS courseId, k.ten_khoa_hoc AS courseName, k.ngoai_ngu AS language,
  l.giao_vien_id AS teacherId, gv.ho_ten AS teacherName,
  l.ngay_khai_giang AS startDate, l.so_buoi AS sessions,
  l.si_so_toi_da AS capacity, l.trang_thai AS status,
  COUNT(DISTINCT CASE WHEN gd.trang_thai <> 'da_huy' THEN gd.id END) AS enrolled,
  COUNT(DISTINCT bh.id) AS generatedSessions,
  COUNT(DISTINCT CASE WHEN bh.trang_thai = 'da_hoc' THEN bh.id END) AS completedSessions
  FROM lop_hoc l JOIN khoa_hoc k ON k.id = l.khoa_hoc_id
  LEFT JOIN nguoi_dung gv ON gv.id = l.giao_vien_id
  LEFT JOIN ghi_danh gd ON gd.lop_hoc_id = l.id
  LEFT JOIN buoi_hoc bh ON bh.lop_hoc_id = l.id`

const enrollmentSelect = `SELECT gd.id, gd.hoc_vien_id AS studentId,
  hv.ma_nguoi_dung AS studentCode, hv.ho_ten AS studentName,
  gd.khoa_hoc_id AS courseId, k.ten_khoa_hoc AS courseName,
  gd.lop_hoc_id AS classId, l.ten_lop AS className,
  gd.ngay_ghi_danh AS enrolledAt, gd.trang_thai AS status,
  COALESCE((SELECT ROUND(100 * SUM(dd.trang_thai IN ('co_mat', 'di_muon')) /
    NULLIF(COUNT(*), 0), 0) FROM diem_danh dd WHERE dd.ghi_danh_id = gd.id), 0) AS attendance
  FROM ghi_danh gd JOIN nguoi_dung hv ON hv.id = gd.hoc_vien_id
  JOIN khoa_hoc k ON k.id = gd.khoa_hoc_id
  LEFT JOIN lop_hoc l ON l.id = gd.lop_hoc_id`

const scheduleSelect = `SELECT lh.id, lh.lop_hoc_id AS classId, l.ten_lop AS className,
  l.giao_vien_id AS teacherId, gv.ho_ten AS teacherName,
  lh.phong_hoc_id AS roomId, p.ma_phong AS roomCode,
  lh.thu_trong_tuan AS dayOfWeek, lh.gio_bat_dau AS startTime,
  lh.gio_ket_thuc AS endTime
  FROM lich_hang_tuan lh JOIN lop_hoc l ON l.id = lh.lop_hoc_id
  JOIN nguoi_dung gv ON gv.id = l.giao_vien_id
  JOIN phong_hoc p ON p.id = lh.phong_hoc_id`

function text(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new HttpError(400, `${label} là bắt buộc`)
  return value.trim()
}

function positiveInt(value: unknown, label: string): number {
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < 1) throw new HttpError(400, `${label} phải là số nguyên dương`)
  return parsed
}

function date(value: unknown, label: string): string {
  const parsed = text(value, label)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(parsed)) throw new HttpError(400, `${label} phải có định dạng YYYY-MM-DD`)
  return parsed
}

function time(value: unknown, label: string): string {
  const parsed = text(value, label)
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/.test(parsed)) throw new HttpError(400, `${label} không hợp lệ`)
  return parsed.length === 5 ? `${parsed}:00` : parsed
}

async function ensureTeacher(teacherId: number | null): Promise<void> {
  if (teacherId === null) return
  const [rows] = await database.query<SimpleRow[]>(
    `SELECT id FROM nguoi_dung WHERE id = ? AND vai_tro = 'giao_vien' AND dang_hoat_dong = TRUE`,
    [teacherId],
  )
  if (!rows[0]) throw new HttpError(400, 'Giáo viên không tồn tại hoặc đã bị khóa')
}

async function ensureNoScheduleConflict(
  classId: number,
  roomId: number,
  dayOfWeek: number,
  startTime: string,
  endTime: string,
  ignoreId = 0,
  assignedTeacherId?: number,
): Promise<void> {
  let teacherId = assignedTeacherId
  if (teacherId === undefined) {
    const [classRows] = await database.query<SimpleRow[]>(
      `SELECT giao_vien_id AS teacherId FROM lop_hoc WHERE id = ? AND trang_thai <> 'da_huy'`,
      [classId],
    )
    teacherId = Number(classRows[0]?.teacherId)
  }
  if (!teacherId) throw new HttpError(409, 'Hãy phân công giáo viên cho lớp trước khi xếp lịch')
  const [conflicts] = await database.query<SimpleRow[]>(
    `SELECT l.ten_lop AS className, p.ma_phong AS roomCode, gv.ho_ten AS teacherName
     FROM lich_hang_tuan lh JOIN lop_hoc l ON l.id = lh.lop_hoc_id
     JOIN phong_hoc p ON p.id = lh.phong_hoc_id
     LEFT JOIN nguoi_dung gv ON gv.id = l.giao_vien_id
     WHERE lh.id <> ? AND lh.thu_trong_tuan = ?
       AND lh.gio_bat_dau < ? AND lh.gio_ket_thuc > ?
       AND (lh.phong_hoc_id = ? OR l.giao_vien_id = ?)
       AND l.trang_thai <> 'da_huy' LIMIT 1`,
    [ignoreId, dayOfWeek, endTime, startTime, roomId, teacherId],
  )
  if (conflicts[0]) {
    throw new HttpError(409, `Trùng lịch với lớp ${conflicts[0].className}`)
  }
}

async function ensureRoomCapacity(classId: number, roomId: number): Promise<void> {
  const [rows] = await database.query<SimpleRow[]>(
    `SELECT l.si_so_toi_da AS classCapacity, p.suc_chua AS roomCapacity, p.ma_phong AS roomCode
     FROM lop_hoc l JOIN phong_hoc p ON p.id = ?
     WHERE l.id = ? AND l.trang_thai <> 'da_huy'`,
    [roomId, classId],
  )
  const item = rows[0]
  if (!item) throw new HttpError(400, 'Lớp học hoặc phòng học không hợp lệ')
  if (!roomCanHostClass(Number(item.roomCapacity), Number(item.classCapacity))) {
    throw new HttpError(409, `Phòng ${item.roomCode} chỉ có ${item.roomCapacity} chỗ, lớp cần ${item.classCapacity} chỗ`)
  }
}

async function notifyScheduleChange(connection: QueryConnection, classId: number, content: string): Promise<void> {
  await connection.execute(
    `INSERT INTO thong_bao (nguoi_dung_id, tieu_de, noi_dung)
     SELECT recipient.id, 'Lịch học thay đổi', ?
     FROM (
       SELECT giao_vien_id AS id FROM lop_hoc WHERE id = ?
       UNION SELECT hoc_vien_id FROM ghi_danh WHERE lop_hoc_id = ? AND trang_thai <> 'da_huy'
     ) recipient WHERE recipient.id IS NOT NULL`,
    [content, classId, classId],
  )
}

academicRouter.get('/rooms', async (_request, response) => {
  const [rows] = await database.query('SELECT id, ma_phong AS code, suc_chua AS capacity FROM phong_hoc ORDER BY ma_phong')
  response.json({ success: true, data: rows })
})

academicRouter.post('/rooms', async (request, response) => {
  const code = text(request.body.code, 'Mã phòng').toUpperCase()
  const capacity = positiveInt(request.body.capacity, 'Sức chứa')
  try {
    const [result] = await database.execute<ResultSetHeader>('INSERT INTO phong_hoc (ma_phong, suc_chua) VALUES (?, ?)', [code, capacity])
    response.status(201).json({ success: true, data: { id: result.insertId, code, capacity } })
  } catch (error) {
    if ((error as { code?: string }).code === 'ER_DUP_ENTRY') throw new HttpError(409, 'Mã phòng đã tồn tại')
    throw error
  }
})

academicRouter.patch('/rooms/:id', async (request, response) => {
  const [rows] = await database.query<SimpleRow[]>('SELECT ma_phong AS code, suc_chua AS capacity FROM phong_hoc WHERE id = ?', [request.params.id])
  if (!rows[0]) throw new HttpError(404, 'Không tìm thấy phòng học')
  const code = request.body.code === undefined ? String(rows[0].code) : text(request.body.code, 'Mã phòng').toUpperCase()
  const capacity = request.body.capacity === undefined ? Number(rows[0].capacity) : positiveInt(request.body.capacity, 'Sức chứa')
  const [scheduled] = await database.query<SimpleRow[]>(
    `SELECT MAX(l.si_so_toi_da) AS requiredCapacity FROM lich_hang_tuan lh
     JOIN lop_hoc l ON l.id = lh.lop_hoc_id
     WHERE lh.phong_hoc_id = ? AND l.trang_thai <> 'da_huy'`,
    [request.params.id],
  )
  if (Number(scheduled[0].requiredCapacity ?? 0) > capacity) {
    throw new HttpError(409, `Phòng đang được xếp cho lớp cần ít nhất ${scheduled[0].requiredCapacity} chỗ`)
  }
  await database.execute('UPDATE phong_hoc SET ma_phong = ?, suc_chua = ? WHERE id = ?', [code, capacity, request.params.id])
  response.json({ success: true, data: { id: Number(request.params.id), code, capacity } })
})

academicRouter.delete('/rooms/:id', async (request, response) => {
  try {
    const [result] = await database.execute<ResultSetHeader>('DELETE FROM phong_hoc WHERE id = ?', [request.params.id])
    if (!result.affectedRows) throw new HttpError(404, 'Không tìm thấy phòng học')
    response.status(204).send()
  } catch (error) {
    if ((error as { code?: string }).code === 'ER_ROW_IS_REFERENCED_2') throw new HttpError(409, 'Phòng đang có lịch học, không thể xóa')
    throw error
  }
})

academicRouter.get('/classes', async (_request, response) => {
  const [rows] = await database.query<ClassRow[]>(`${classSelect} GROUP BY l.id ORDER BY l.id DESC`)
  response.json({ success: true, data: rows })
})

academicRouter.post('/classes', async (request, response) => {
  const code = text(request.body.code, 'Mã lớp').toUpperCase()
  const name = text(request.body.name, 'Tên lớp')
  const courseId = positiveInt(request.body.courseId, 'Khóa học')
  const teacherId = request.body.teacherId ? positiveInt(request.body.teacherId, 'Giáo viên') : null
  await ensureTeacher(teacherId)
  const [courses] = await database.query<SimpleRow[]>('SELECT so_buoi AS sessions FROM khoa_hoc WHERE id = ?', [courseId])
  if (!courses[0]) throw new HttpError(400, 'Khóa học không tồn tại')
  const sessions = request.body.sessions === undefined ? Number(courses[0].sessions) : positiveInt(request.body.sessions, 'Số buổi')
  const capacity = positiveInt(request.body.capacity, 'Sĩ số tối đa')
  const startDate = date(request.body.startDate, 'Ngày khai giảng')
  try {
    const [result] = await database.execute<ResultSetHeader>(
      `INSERT INTO lop_hoc
       (ma_lop, ten_lop, khoa_hoc_id, giao_vien_id, ngay_khai_giang, so_buoi, si_so_toi_da)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [code, name, courseId, teacherId, startDate, sessions, capacity],
    )
    const [rows] = await database.query<ClassRow[]>(`${classSelect} WHERE l.id = ? GROUP BY l.id`, [result.insertId])
    response.status(201).json({ success: true, data: rows[0] })
  } catch (error) {
    if ((error as { code?: string }).code === 'ER_DUP_ENTRY') throw new HttpError(409, 'Mã lớp đã tồn tại')
    throw error
  }
})

academicRouter.patch('/classes/:id', async (request, response) => {
  const [rows] = await database.query<ClassRow[]>(`${classSelect} WHERE l.id = ? GROUP BY l.id`, [request.params.id])
  const current = rows[0]
  if (!current) throw new HttpError(404, 'Không tìm thấy lớp học')
  const courseId = request.body.courseId === undefined ? current.courseId : positiveInt(request.body.courseId, 'Khóa học')
  if (current.enrolled > 0 && courseId !== current.courseId) throw new HttpError(409, 'Lớp đã có học viên, không thể đổi khóa học')
  const teacherId = request.body.teacherId === undefined ? current.teacherId : request.body.teacherId === null ? null : positiveInt(request.body.teacherId, 'Giáo viên')
  await ensureTeacher(teacherId)
  const teacherChanged = teacherId !== current.teacherId
  const weeklySchedules = teacherChanged
    ? (await database.query<ScheduleSlotRow[]>(
        `SELECT id, phong_hoc_id AS roomId, thu_trong_tuan AS dayOfWeek,
         gio_bat_dau AS startTime, gio_ket_thuc AS endTime
         FROM lich_hang_tuan WHERE lop_hoc_id = ?`,
        [current.id],
      ))[0]
    : []
  if (teacherChanged && teacherId === null && (weeklySchedules.length || current.generatedSessions > 0)) {
    throw new HttpError(409, 'Lớp đã có lịch học; hãy phân công giáo viên khác thay vì bỏ trống')
  }
  if (teacherChanged && teacherId !== null) {
    for (const slot of weeklySchedules) {
      await ensureNoScheduleConflict(
        current.id, slot.roomId, slot.dayOfWeek, slot.startTime, slot.endTime, slot.id, teacherId,
      )
    }
  }
  const capacity = request.body.capacity === undefined ? current.capacity : positiveInt(request.body.capacity, 'Sĩ số tối đa')
  if (capacity < current.enrolled) throw new HttpError(400, `Lớp đang có ${current.enrolled} học viên`)
  const [smallRooms] = await database.query<SimpleRow[]>(
    `SELECT p.ma_phong AS roomCode, p.suc_chua AS roomCapacity FROM lich_hang_tuan lh
     JOIN phong_hoc p ON p.id = lh.phong_hoc_id
     WHERE lh.lop_hoc_id = ? AND p.suc_chua < ? LIMIT 1`,
    [current.id, capacity],
  )
  if (smallRooms[0]) throw new HttpError(409, `Phòng ${smallRooms[0].roomCode} chỉ có ${smallRooms[0].roomCapacity} chỗ`)
  if (request.body.status !== undefined) {
    throw new HttpError(400, 'Hãy dùng chức năng bắt đầu, kết thúc hoặc hủy lớp để đổi trạng thái')
  }
  const startDate = request.body.startDate === undefined ? current.startDate : date(request.body.startDate, 'Ngày khai giảng')
  const sessions = request.body.sessions === undefined ? current.sessions : positiveInt(request.body.sessions, 'Số buổi')
  if (!canChangeClassPlan(current.generatedSessions, current.startDate, current.sessions, startDate, sessions)) {
    throw new HttpError(409, 'Không thể đổi ngày khai giảng hoặc số buổi sau khi đã sinh buổi học')
  }
  const connection = await database.getConnection()
  try {
    await connection.beginTransaction()
    await connection.execute(
      `UPDATE lop_hoc SET ma_lop = ?, ten_lop = ?, khoa_hoc_id = ?, giao_vien_id = ?,
       ngay_khai_giang = ?, so_buoi = ?, si_so_toi_da = ? WHERE id = ?`,
      [
        request.body.code === undefined ? current.code : text(request.body.code, 'Mã lớp').toUpperCase(),
        request.body.name === undefined ? current.name : text(request.body.name, 'Tên lớp'),
        courseId, teacherId,
        startDate, sessions, capacity, current.id,
      ],
    )
    if (shouldSyncTeacherAssignment(current.teacherId, teacherId, current.generatedSessions)) {
      await connection.execute(
        `UPDATE buoi_hoc SET giao_vien_id = ?
         WHERE lop_hoc_id = ? AND trang_thai = 'da_len_lich' AND bat_dau >= NOW()`,
        [teacherId, current.id],
      )
    }
    await connection.commit()
  } catch (error) {
    await connection.rollback()
    throw error
  } finally {
    connection.release()
  }
  const [updated] = await database.query<ClassRow[]>(`${classSelect} WHERE l.id = ? GROUP BY l.id`, [current.id])
  response.json({ success: true, data: updated[0] })
})

academicRouter.post('/classes/:id/cancel', async (request, response) => {
  const [rows] = await database.query<ClassRow[]>(`${classSelect} WHERE l.id = ? GROUP BY l.id`, [request.params.id])
  const classItem = rows[0]
  if (!classItem) throw new HttpError(404, 'Không tìm thấy lớp học')
  if (classItem.enrolled > 0) throw new HttpError(409, 'Hãy chuyển lớp hoặc hủy ghi danh của học viên trước')
  await database.execute("UPDATE lop_hoc SET trang_thai = 'da_huy' WHERE id = ?", [classItem.id])
  response.json({ success: true, message: 'Đã hủy lớp học' })
})

academicRouter.post('/classes/:id/start', async (request, response) => {
  const classId = positiveInt(request.params.id, 'Lớp học')
  const connection = await database.getConnection()
  try {
    await connection.beginTransaction()
    const [rows] = await connection.query<SimpleRow[]>(
      `SELECT id, ten_lop AS name, trang_thai AS status, giao_vien_id AS teacherId,
        so_buoi AS sessions FROM lop_hoc WHERE id = ? FOR UPDATE`,
      [classId],
    )
    const classItem = rows[0]
    if (!classItem) throw new HttpError(404, 'Không tìm thấy lớp học')
    if (classItem.status !== 'sap_khai_giang') throw new HttpError(409, 'Chỉ lớp sắp khai giảng mới được bắt đầu')
    if (!classItem.teacherId) throw new HttpError(409, 'Lớp chưa được phân công giáo viên')
    const [sessionCounts] = await connection.query<SimpleRow[]>(
      'SELECT COUNT(*) AS generatedSessions FROM buoi_hoc WHERE lop_hoc_id = ?',
      [classId],
    )
    if (Number(sessionCounts[0].generatedSessions) !== Number(classItem.sessions)) {
      throw new HttpError(409, `Cần tạo đủ ${classItem.sessions} buổi học trước khi bắt đầu lớp`)
    }
    await connection.execute("UPDATE lop_hoc SET trang_thai = 'dang_hoc' WHERE id = ?", [classId])
    await connection.execute(
      `INSERT INTO thong_bao (nguoi_dung_id, tieu_de, noi_dung)
       SELECT recipient.id, 'Lớp học đã bắt đầu', ?
       FROM (
         SELECT giao_vien_id AS id FROM lop_hoc WHERE id = ?
         UNION SELECT hoc_vien_id FROM ghi_danh WHERE lop_hoc_id = ? AND trang_thai <> 'da_huy'
       ) recipient WHERE recipient.id IS NOT NULL`,
      [`Lớp ${classItem.name} đã chuyển sang trạng thái đang học.`, classId, classId],
    )
    await connection.commit()
    response.json({ success: true, message: 'Đã bắt đầu lớp học' })
  } catch (error) {
    await connection.rollback()
    throw error
  } finally {
    connection.release()
  }
})

academicRouter.post('/classes/:id/complete', async (request, response) => {
  const classId = positiveInt(request.params.id, 'Lớp học')
  const connection = await database.getConnection()
  try {
    await connection.beginTransaction()
    const [rows] = await connection.query<SimpleRow[]>(
      `SELECT id, ten_lop AS name, trang_thai AS status, so_buoi AS sessions
       FROM lop_hoc WHERE id = ? FOR UPDATE`,
      [classId],
    )
    const classItem = rows[0]
    if (!classItem) throw new HttpError(404, 'Không tìm thấy lớp học')
    if (classItem.status !== 'dang_hoc') throw new HttpError(409, 'Chỉ lớp đang học mới được kết thúc')
    const [sessionCounts] = await connection.query<SimpleRow[]>(
      `SELECT COUNT(*) AS generatedSessions,
        SUM(trang_thai = 'da_hoc') AS completedSessions
       FROM buoi_hoc WHERE lop_hoc_id = ?`,
      [classId],
    )
    if (Number(sessionCounts[0].generatedSessions) !== Number(classItem.sessions)
      || Number(sessionCounts[0].completedSessions) !== Number(classItem.sessions)) {
      throw new HttpError(409, `Cần hoàn tất điểm danh đủ ${classItem.sessions} buổi học trước khi kết thúc lớp`)
    }
    await connection.execute("UPDATE lop_hoc SET trang_thai = 'da_ket_thuc' WHERE id = ?", [classId])
    const [enrollments] = await connection.execute<ResultSetHeader>(
      "UPDATE ghi_danh SET trang_thai = 'hoan_thanh' WHERE lop_hoc_id = ? AND trang_thai = 'dang_hoc'",
      [classId],
    )
    await connection.execute(
      `INSERT INTO thong_bao (nguoi_dung_id, tieu_de, noi_dung)
       SELECT hoc_vien_id, 'Lớp học đã kết thúc', ? FROM ghi_danh
       WHERE lop_hoc_id = ? AND trang_thai = 'hoan_thanh'`,
      [`Lớp ${classItem.name} đã hoàn thành. Bạn có thể kiểm tra kết quả và điều kiện chứng chỉ.`, classId],
    )
    await connection.commit()
    response.json({ success: true, data: { completedEnrollments: enrollments.affectedRows } })
  } catch (error) {
    await connection.rollback()
    throw error
  } finally {
    connection.release()
  }
})

academicRouter.get('/enrollments', async (_request, response) => {
  const [rows] = await database.query<EnrollmentRow[]>(`${enrollmentSelect} ORDER BY gd.id DESC`)
  response.json({ success: true, data: rows })
})

academicRouter.post('/enrollments', async (request, response) => {
  const studentId = positiveInt(request.body.studentId, 'Học viên')
  const courseId = positiveInt(request.body.courseId, 'Khóa học')
  const classId = request.body.classId ? positiveInt(request.body.classId, 'Lớp học') : null
  const enrolledAt = request.body.enrolledAt ? date(request.body.enrolledAt, 'Ngày ghi danh') : null
  const connection = await database.getConnection()
  try {
    await connection.beginTransaction()
    const [students] = await connection.query<SimpleRow[]>(
      `SELECT id FROM nguoi_dung WHERE id = ? AND vai_tro = 'hoc_vien' AND dang_hoat_dong = TRUE FOR UPDATE`,
      [studentId],
    )
    if (!students[0]) throw new HttpError(400, 'Học viên không tồn tại hoặc đã bị khóa')
    const [courses] = await connection.query<SimpleRow[]>(
      "SELECT ten_khoa_hoc AS courseName, hoc_phi AS tuition FROM khoa_hoc WHERE id = ? AND trang_thai = 'dang_mo' FOR UPDATE",
      [courseId],
    )
    if (!courses[0]) throw new HttpError(400, 'Khóa học không tồn tại hoặc đã tạm ẩn')
    const [duplicates] = await connection.query<SimpleRow[]>(
      `SELECT id FROM ghi_danh WHERE hoc_vien_id = ? AND khoa_hoc_id = ?
       AND trang_thai <> 'da_huy' LIMIT 1`,
      [studentId, courseId],
    )
    if (duplicates[0]) throw new HttpError(409, 'Học viên đã có ghi danh còn hiệu lực cho khóa học này')
    if (classId) await ensureClassCapacity(connection, classId, courseId)
    const status: EnrollmentStatus = classId ? 'dang_hoc' : 'cho_xep_lop'
    const [result] = await connection.execute<ResultSetHeader>(
      `INSERT INTO ghi_danh (hoc_vien_id, khoa_hoc_id, lop_hoc_id, ngay_ghi_danh, trang_thai)
       VALUES (?, ?, ?, COALESCE(?, CURDATE()), ?)`,
      [studentId, courseId, classId, enrolledAt, status],
    )
    const invoiceCode = `HD-${new Date().getFullYear()}-${randomInt(100000, 1000000)}`
    await connection.execute(
      `INSERT INTO hoa_don
       (ma_hoa_don, ghi_danh_id, so_tien, ngay_lap, han_thanh_toan)
       VALUES (?, ?, ?, CURDATE(), DATE_ADD(CURDATE(), INTERVAL 14 DAY))`,
      [invoiceCode, result.insertId, courses[0].tuition],
    )
    await connection.execute(
      `INSERT INTO thong_bao (nguoi_dung_id, tieu_de, noi_dung)
       VALUES (?, 'Ghi danh khóa học mới', ?)`,
      [studentId, `Bạn đã được ghi danh khóa ${courses[0].courseName}. Hóa đơn ${invoiceCode} đã được tạo.`],
    )
    await connection.commit()
    response.status(201).json({ success: true, data: { id: result.insertId, status, invoiceCode } })
  } catch (error) {
    await connection.rollback()
    throw error
  } finally {
    connection.release()
  }
})

async function ensureClassCapacity(connection: PoolConnection, classId: number, courseId: number, ignoreEnrollmentId = 0): Promise<void> {
  const [classes] = await connection.query<SimpleRow[]>(
    `SELECT l.khoa_hoc_id AS courseId, l.si_so_toi_da AS capacity,
      (SELECT COUNT(*) FROM ghi_danh gd WHERE gd.lop_hoc_id = l.id AND gd.trang_thai <> 'da_huy' AND gd.id <> ?) AS enrolled
     FROM lop_hoc l WHERE l.id = ? AND l.trang_thai IN ('sap_khai_giang', 'dang_hoc') FOR UPDATE`,
    [ignoreEnrollmentId, classId],
  )
  const classItem = classes[0]
  if (!classItem || Number(classItem.courseId) !== courseId) throw new HttpError(400, 'Lớp không còn nhận học viên hoặc không thuộc khóa học đã chọn')
  if (Number(classItem.enrolled) >= Number(classItem.capacity)) throw new HttpError(409, 'Lớp học đã đủ sĩ số')
}

academicRouter.patch('/enrollments/:id', async (request, response) => {
  const enrollmentId = positiveInt(request.params.id, 'Ghi danh')
  const connection = await database.getConnection()
  try {
    await connection.beginTransaction()
    const [rows] = await connection.query<EnrollmentRow[]>(`${enrollmentSelect} WHERE gd.id = ? FOR UPDATE`, [enrollmentId])
    const current = rows[0]
    if (!current) throw new HttpError(404, 'Không tìm thấy ghi danh')
    const requestedStatus = (request.body.status ?? current.status) as EnrollmentStatus
    if (!['cho_xep_lop', 'dang_hoc', 'bao_luu', 'hoan_thanh', 'da_huy'].includes(requestedStatus)) throw new HttpError(400, 'Trạng thái ghi danh không hợp lệ')
    const classId = request.body.classId === undefined ? current.classId : request.body.classId === null ? null : positiveInt(request.body.classId, 'Lớp học')
    const status = classId && requestedStatus === 'cho_xep_lop' ? 'dang_hoc' : requestedStatus
    if (!canChangeEnrollmentStatus(current.status, status)) throw new HttpError(409, 'Không thể chuyển sang trạng thái ghi danh đã chọn')
    if (status === 'dang_hoc' && !classId) throw new HttpError(400, 'Hãy xếp lớp trước khi chuyển sang đang học')
    if (classId !== current.classId && status !== 'dang_hoc') throw new HttpError(400, 'Chỉ được đổi lớp khi chuyển ghi danh sang đang học')
    if (classId !== current.classId) {
      const [history] = await connection.query<SimpleRow[]>(
        `SELECT (EXISTS(SELECT 1 FROM diem_danh WHERE ghi_danh_id = ?) OR
          EXISTS(SELECT 1 FROM ket_qua_thi WHERE ghi_danh_id = ?)) AS hasLearningHistory`,
        [current.id, current.id],
      )
      if (Boolean(Number(history[0]?.hasLearningHistory))) {
        throw new HttpError(409, 'Không thể chuyển lớp sau khi học viên đã có điểm danh hoặc điểm thi')
      }
    }
    if (classId && (classId !== current.classId || (status === 'dang_hoc' && current.status !== 'dang_hoc'))) {
      await ensureClassCapacity(connection, classId, current.courseId, current.id)
    }
    if (status === 'da_huy') {
      const [invoices] = await connection.query<SimpleRow[]>(
        'SELECT id, trang_thai AS status FROM hoa_don WHERE ghi_danh_id = ? FOR UPDATE',
        [current.id],
      )
      if (invoices.some((invoice) => invoice.status === 'da_thanh_toan')) throw new HttpError(409, 'Ghi danh đã thanh toán chỉ có thể chuyển lớp, không thể hủy')
      await connection.execute(
        "UPDATE hoa_don SET trang_thai = 'da_huy', ly_do_huy = 'Hủy theo ghi danh' WHERE ghi_danh_id = ? AND trang_thai = 'chua_thanh_toan'",
        [current.id],
      )
    }
    await connection.execute(
      'UPDATE ghi_danh SET lop_hoc_id = ?, trang_thai = ? WHERE id = ?',
      [classId, status, current.id],
    )
    if (status !== current.status || classId !== current.classId) {
      const message = status === 'bao_luu' ? 'Ghi danh của bạn đã được bảo lưu.'
        : status === 'da_huy' ? 'Ghi danh của bạn đã được hủy.'
          : status === 'dang_hoc' && current.status === 'bao_luu' ? 'Ghi danh của bạn đã được tiếp tục.'
            : 'Thông tin lớp học của bạn đã được cập nhật.'
      await connection.execute(
        "INSERT INTO thong_bao (nguoi_dung_id, tieu_de, noi_dung) VALUES (?, 'Trạng thái ghi danh', ?)",
        [current.studentId, `${message} Khóa học: ${current.courseName}.`],
      )
    }
    await connection.commit()
    const [updated] = await database.query<EnrollmentRow[]>(`${enrollmentSelect} WHERE gd.id = ?`, [current.id])
    response.json({ success: true, data: updated[0] })
  } catch (error) {
    await connection.rollback()
    throw error
  } finally {
    connection.release()
  }
})

academicRouter.get('/schedules', async (_request, response) => {
  const [rows] = await database.query<ScheduleRow[]>(`${scheduleSelect} ORDER BY lh.thu_trong_tuan, lh.gio_bat_dau`)
  response.json({ success: true, data: rows })
})

academicRouter.post('/schedules', async (request, response) => {
  const classId = positiveInt(request.body.classId, 'Lớp học')
  const roomId = positiveInt(request.body.roomId, 'Phòng học')
  const dayOfWeek = positiveInt(request.body.dayOfWeek, 'Thứ trong tuần')
  if (dayOfWeek > 7) throw new HttpError(400, 'Thứ trong tuần phải từ 1 đến 7')
  const startTime = time(request.body.startTime, 'Giờ bắt đầu')
  const endTime = time(request.body.endTime, 'Giờ kết thúc')
  if (endTime <= startTime) throw new HttpError(400, 'Giờ kết thúc phải sau giờ bắt đầu')
  const [sessions] = await database.query<SimpleRow[]>('SELECT COUNT(*) AS total FROM buoi_hoc WHERE lop_hoc_id = ?', [classId])
  if (Number(sessions[0].total) > 0) throw new HttpError(409, 'Lớp đã sinh buổi học; hãy chỉnh sửa lịch hiện có')
  await ensureRoomCapacity(classId, roomId)
  await ensureNoScheduleConflict(classId, roomId, dayOfWeek, startTime, endTime)
  const [result] = await database.execute<ResultSetHeader>(
    `INSERT INTO lich_hang_tuan
     (lop_hoc_id, phong_hoc_id, thu_trong_tuan, gio_bat_dau, gio_ket_thuc)
     VALUES (?, ?, ?, ?, ?)`,
    [classId, roomId, dayOfWeek, startTime, endTime],
  )
  await notifyScheduleChange(database, classId, `Lịch học đã được xếp vào Thứ ${dayOfWeek}, ${startTime.slice(0, 5)}-${endTime.slice(0, 5)}.`)
  const [rows] = await database.query<ScheduleRow[]>(`${scheduleSelect} WHERE lh.id = ?`, [result.insertId])
  response.status(201).json({ success: true, data: rows[0] })
})

academicRouter.patch('/schedules/:id', async (request, response) => {
  const [rows] = await database.query<ScheduleRow[]>(`${scheduleSelect} WHERE lh.id = ?`, [request.params.id])
  const current = rows[0]
  if (!current) throw new HttpError(404, 'Không tìm thấy lịch học')
  const classId = request.body.classId === undefined ? current.classId : positiveInt(request.body.classId, 'Lớp học')
  const roomId = request.body.roomId === undefined ? current.roomId : positiveInt(request.body.roomId, 'Phòng học')
  const dayOfWeek = request.body.dayOfWeek === undefined ? current.dayOfWeek : positiveInt(request.body.dayOfWeek, 'Thứ trong tuần')
  const startTime = request.body.startTime === undefined ? current.startTime : time(request.body.startTime, 'Giờ bắt đầu')
  const endTime = request.body.endTime === undefined ? current.endTime : time(request.body.endTime, 'Giờ kết thúc')
  if (dayOfWeek > 7 || endTime <= startTime) throw new HttpError(400, 'Ngày hoặc khung giờ không hợp lệ')
  const [sessions] = await database.query<SimpleRow[]>('SELECT COUNT(*) AS total FROM buoi_hoc WHERE lop_hoc_id = ?', [current.classId])
  const hasSessions = Number(sessions[0].total) > 0
  if (hasSessions && (classId !== current.classId || dayOfWeek !== current.dayOfWeek)) {
    throw new HttpError(409, 'Lớp đã sinh buổi học; chỉ được đổi phòng hoặc khung giờ trong cùng ngày')
  }
  await ensureRoomCapacity(classId, roomId)
  await ensureNoScheduleConflict(classId, roomId, dayOfWeek, startTime, endTime, current.id)
  const connection = await database.getConnection()
  try {
    await connection.beginTransaction()
    await connection.execute(
      `UPDATE lich_hang_tuan SET lop_hoc_id = ?, phong_hoc_id = ?, thu_trong_tuan = ?,
       gio_bat_dau = ?, gio_ket_thuc = ? WHERE id = ?`,
      [classId, roomId, dayOfWeek, startTime, endTime, current.id],
    )
    if (hasSessions) {
      await connection.execute(
        `UPDATE buoi_hoc SET phong_hoc_id = ?,
          bat_dau = TIMESTAMP(DATE(bat_dau), ?), ket_thuc = TIMESTAMP(DATE(ket_thuc), ?)
         WHERE lop_hoc_id = ? AND phong_hoc_id = ? AND DAYOFWEEK(bat_dau) = ?
           AND TIME(bat_dau) = ? AND TIME(ket_thuc) = ?
           AND trang_thai = 'da_len_lich' AND bat_dau >= NOW()`,
        [roomId, startTime, endTime, current.classId, current.roomId, current.dayOfWeek, current.startTime, current.endTime],
      )
    }
    await notifyScheduleChange(
      connection,
      classId,
      `Lịch học đã đổi sang Thứ ${dayOfWeek}, ${startTime.slice(0, 5)}-${endTime.slice(0, 5)}; phòng học đã được cập nhật.`,
    )
    await connection.commit()
  } catch (error) {
    await connection.rollback()
    throw error
  } finally {
    connection.release()
  }
  const [updated] = await database.query<ScheduleRow[]>(`${scheduleSelect} WHERE lh.id = ?`, [current.id])
  response.json({ success: true, data: updated[0] })
})

academicRouter.delete('/schedules/:id', async (request, response) => {
  const [rows] = await database.query<ScheduleRow[]>(`${scheduleSelect} WHERE lh.id = ?`, [request.params.id])
  const current = rows[0]
  if (!current) throw new HttpError(404, 'Không tìm thấy lịch học')
  const [sessions] = await database.query<SimpleRow[]>('SELECT COUNT(*) AS total FROM buoi_hoc WHERE lop_hoc_id = ?', [current.classId])
  if (Number(sessions[0].total) > 0) throw new HttpError(409, 'Không thể xóa lịch sau khi đã sinh buổi học; hãy chỉnh sửa phòng hoặc giờ học')
  const [result] = await database.execute<ResultSetHeader>('DELETE FROM lich_hang_tuan WHERE id = ?', [request.params.id])
  if (!result.affectedRows) throw new HttpError(404, 'Không tìm thấy lịch học')
  await notifyScheduleChange(database, current.classId, `Đã xóa lịch Thứ ${current.dayOfWeek}, ${current.startTime.slice(0, 5)}-${current.endTime.slice(0, 5)}.`)
  response.status(204).send()
})

academicRouter.post('/classes/:id/generate-sessions', async (request, response) => {
  const [classRows] = await database.query<ClassRow[]>(`${classSelect} WHERE l.id = ? GROUP BY l.id`, [request.params.id])
  const classItem = classRows[0]
  if (!classItem) throw new HttpError(404, 'Không tìm thấy lớp học')
  if (!classItem.teacherId) throw new HttpError(409, 'Lớp chưa được phân công giáo viên')
  const [existing] = await database.query<SimpleRow[]>('SELECT COUNT(*) AS total FROM buoi_hoc WHERE lop_hoc_id = ?', [classItem.id])
  if (Number(existing[0].total) > 0) throw new HttpError(409, 'Lớp đã có buổi học, không sinh lại để tránh trùng dữ liệu')
  const [scheduleRows] = await database.query<ScheduleRow[]>(`${scheduleSelect} WHERE lh.lop_hoc_id = ?`, [classItem.id])
  const slots: WeeklySlot[] = scheduleRows.map((item) => ({
    dayOfWeek: item.dayOfWeek,
    startTime: item.startTime,
    endTime: item.endTime,
    roomId: item.roomId,
  }))
  const sessions = generateSessionDates(classItem.startDate, classItem.sessions, slots)
  if (sessions.length !== classItem.sessions) throw new HttpError(409, 'Chưa có lịch hàng tuần hợp lệ để sinh đủ buổi học')
  const connection = await database.getConnection()
  try {
    await connection.beginTransaction()
    for (const session of sessions) {
      await connection.execute(
        `INSERT INTO buoi_hoc
         (lop_hoc_id, giao_vien_id, phong_hoc_id, bat_dau, ket_thuc)
         VALUES (?, ?, ?, ?, ?)`,
        [classItem.id, classItem.teacherId, session.roomId, session.startsAt, session.endsAt],
      )
    }
    await connection.commit()
  } catch (error) {
    await connection.rollback()
    throw error
  } finally {
    connection.release()
  }
  response.status(201).json({ success: true, data: { created: sessions.length, sessions } })
})
