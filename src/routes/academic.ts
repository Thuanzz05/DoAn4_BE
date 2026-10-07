import { randomInt } from 'node:crypto'
import { Router } from 'express'
import type { PoolConnection, ResultSetHeader, RowDataPacket } from 'mysql2/promise'
import { database } from '../config/database'
import { requireAuth, requireRole } from '../middlewares/auth'
import { canChangeEnrollmentStatus, ensureEnrollmentClass, type EnrollmentStatus } from '../utils/enrollment'
import { attendanceRateSql, attendanceStatsJoin } from '../utils/attendance'
import { parseTuitionAmount } from '../utils/operations'
import { HttpError } from '../utils/http-error'
import { canCancelSession, canChangeClassPlan, canEditSession, generateSessionDates, roomCanHostClass, shouldSyncTeacherAssignment, type WeeklySlot } from '../utils/schedule'

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
  effectiveSessions: number
  completedSessions: number
  hasStarted: number
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
type SessionRow = RowDataPacket & {
  id: number
  classId: number
  teacherId: number
  teacherName: string
  roomId: number
  roomCode: string
  startsAt: string
  endsAt: string
  status: 'da_len_lich' | 'da_hoc' | 'da_huy'
  attendanceCount: number
  hasStarted: number
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
  canChangeClass: number
}
type SimpleRow = RowDataPacket & Record<string, string | number | null>
type QueryConnection = PoolConnection | typeof database

export const academicRouter = Router()
academicRouter.use(['/rooms', '/classes', '/enrollments', '/schedules', '/sessions'], requireAuth, requireRole('quan_tri'))

const classSelect = `SELECT l.id, l.ma_lop AS code, l.ten_lop AS name,
  l.khoa_hoc_id AS courseId, k.ten_khoa_hoc AS courseName, k.ngoai_ngu AS language,
  l.giao_vien_id AS teacherId, gv.ho_ten AS teacherName,
  l.ngay_khai_giang AS startDate, l.so_buoi AS sessions,
  l.si_so_toi_da AS capacity, l.trang_thai AS status,
  COUNT(DISTINCT CASE WHEN gd.trang_thai IN ('dang_hoc', 'hoan_thanh') THEN gd.id END) AS enrolled,
  COUNT(DISTINCT bh.id) AS generatedSessions,
  COUNT(DISTINCT CASE WHEN bh.trang_thai <> 'da_huy' THEN bh.id END) AS effectiveSessions,
  COUNT(DISTINCT CASE WHEN bh.trang_thai = 'da_hoc' THEN bh.id END) AS completedSessions,
  MAX(CASE WHEN bh.trang_thai <> 'da_huy' AND bh.bat_dau <= NOW() THEN 1 ELSE 0 END) AS hasStarted
  FROM lop_hoc l JOIN khoa_hoc k ON k.id = l.khoa_hoc_id
  LEFT JOIN nguoi_dung gv ON gv.id = l.giao_vien_id
  LEFT JOIN ghi_danh gd ON gd.lop_hoc_id = l.id
  LEFT JOIN buoi_hoc bh ON bh.lop_hoc_id = l.id`

const enrollmentSelect = `SELECT gd.id, gd.hoc_vien_id AS studentId,
  hv.ma_nguoi_dung AS studentCode, hv.ho_ten AS studentName,
  gd.khoa_hoc_id AS courseId, k.ten_khoa_hoc AS courseName,
  gd.lop_hoc_id AS classId, l.ten_lop AS className,
  gd.ngay_ghi_danh AS enrolledAt, gd.trang_thai AS status,
  ${attendanceRateSql} AS attendance,
  NOT (EXISTS(SELECT 1 FROM diem_danh WHERE ghi_danh_id = gd.id)
    OR EXISTS(SELECT 1 FROM ket_qua_thi WHERE ghi_danh_id = gd.id)
    OR EXISTS(SELECT 1 FROM chung_chi WHERE ghi_danh_id = gd.id)
    OR EXISTS(SELECT 1 FROM buoi_hoc WHERE lop_hoc_id = gd.lop_hoc_id AND trang_thai <> 'da_huy' AND bat_dau <= NOW())) AS canChangeClass
  FROM ghi_danh gd JOIN nguoi_dung hv ON hv.id = gd.hoc_vien_id
  JOIN khoa_hoc k ON k.id = gd.khoa_hoc_id
  LEFT JOIN lop_hoc l ON l.id = gd.lop_hoc_id
  ${attendanceStatsJoin}`

const scheduleSelect = `SELECT lh.id, lh.lop_hoc_id AS classId, l.ten_lop AS className,
  l.giao_vien_id AS teacherId, gv.ho_ten AS teacherName,
  lh.phong_hoc_id AS roomId, p.ma_phong AS roomCode,
  lh.thu_trong_tuan AS dayOfWeek, lh.gio_bat_dau AS startTime,
  lh.gio_ket_thuc AS endTime
  FROM lich_hang_tuan lh JOIN lop_hoc l ON l.id = lh.lop_hoc_id
  JOIN nguoi_dung gv ON gv.id = l.giao_vien_id
  JOIN phong_hoc p ON p.id = lh.phong_hoc_id`

const sessionSelect = `SELECT bh.id, bh.lop_hoc_id AS classId,
  bh.giao_vien_id AS teacherId, gv.ho_ten AS teacherName,
  bh.phong_hoc_id AS roomId, p.ma_phong AS roomCode,
  bh.bat_dau AS startsAt, bh.ket_thuc AS endsAt, bh.trang_thai AS status,
  (SELECT COUNT(*) FROM diem_danh dd WHERE dd.buoi_hoc_id = bh.id) AS attendanceCount,
  (bh.bat_dau <= NOW()) AS hasStarted
  FROM buoi_hoc bh JOIN nguoi_dung gv ON gv.id = bh.giao_vien_id
  JOIN phong_hoc p ON p.id = bh.phong_hoc_id`

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
  const calendar = new Date(`${parsed}T00:00:00Z`)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(parsed) || Number.isNaN(calendar.getTime()) || calendar.toISOString().slice(0, 10) !== parsed) throw new HttpError(400, `${label} không hợp lệ (YYYY-MM-DD)`)
  return parsed
}

function time(value: unknown, label: string): string {
  const parsed = text(value, label)
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/.test(parsed)) throw new HttpError(400, `${label} không hợp lệ`)
  return parsed.length === 5 ? `${parsed}:00` : parsed
}

async function ensureTeacher(teacherId: number | null, connection: QueryConnection = database): Promise<void> {
  if (teacherId === null) return
  const [rows] = await connection.query<SimpleRow[]>(
    `SELECT id FROM nguoi_dung WHERE id = ? AND vai_tro = 'giao_vien' AND dang_hoat_dong = TRUE`,
    [teacherId],
  )
  if (!rows[0]) throw new HttpError(400, 'Giáo viên không tồn tại hoặc đã bị khóa')
}

async function lockScheduling(connection: PoolConnection): Promise<void> {
  // ponytail: tuần tự hóa thao tác xếp lịch cho một trung tâm; chuyển sang khóa từng tài nguyên khi lưu lượng lớn.
  await connection.query('SELECT id FROM lop_hoc ORDER BY id FOR UPDATE')
}

async function ensureNoScheduleConflict(
  classId: number,
  roomId: number,
  dayOfWeek: number,
  startTime: string,
  endTime: string,
  ignoreId = 0,
  assignedTeacherId?: number,
  connection: QueryConnection = database,
): Promise<void> {
  let teacherId = assignedTeacherId
  if (teacherId === undefined) {
    const [classRows] = await connection.query<SimpleRow[]>(
      `SELECT giao_vien_id AS teacherId FROM lop_hoc WHERE id = ? AND trang_thai IN ('sap_khai_giang', 'dang_hoc')`,
      [classId],
    )
    teacherId = Number(classRows[0]?.teacherId)
  }
  if (!teacherId) throw new HttpError(409, 'Hãy phân công giáo viên cho lớp trước khi xếp lịch')
  const [conflicts] = await connection.query<SimpleRow[]>(
    `SELECT l.ten_lop AS className, p.ma_phong AS roomCode, gv.ho_ten AS teacherName
     FROM lich_hang_tuan lh JOIN lop_hoc l ON l.id = lh.lop_hoc_id
     JOIN phong_hoc p ON p.id = lh.phong_hoc_id
     LEFT JOIN nguoi_dung gv ON gv.id = l.giao_vien_id
     WHERE lh.id <> ? AND lh.thu_trong_tuan = ?
       AND lh.gio_bat_dau < ? AND lh.gio_ket_thuc > ?
       AND (lh.phong_hoc_id = ? OR l.giao_vien_id = ? OR l.id = ? OR EXISTS(
         SELECT 1 FROM ghi_danh ours JOIN ghi_danh theirs ON theirs.hoc_vien_id = ours.hoc_vien_id
         WHERE ours.lop_hoc_id = ? AND theirs.lop_hoc_id = l.id AND ours.trang_thai = 'dang_hoc' AND theirs.trang_thai = 'dang_hoc'))
       AND l.trang_thai IN ('sap_khai_giang', 'dang_hoc') LIMIT 1`,
    [ignoreId, dayOfWeek, endTime, startTime, roomId, teacherId, classId, classId],
  )
  if (conflicts[0]) {
    throw new HttpError(409, `Trùng lịch với lớp ${conflicts[0].className}`)
  }
  const [actualConflicts] = await connection.query<SimpleRow[]>(
    `SELECT l.ten_lop AS className FROM buoi_hoc bh JOIN lop_hoc l ON l.id = bh.lop_hoc_id
     WHERE bh.lop_hoc_id <> ? AND bh.trang_thai <> 'da_huy' AND bh.bat_dau > NOW()
       AND DAYOFWEEK(bh.bat_dau) = ? AND TIME(bh.bat_dau) < ? AND TIME(bh.ket_thuc) > ?
       AND (bh.phong_hoc_id = ? OR bh.giao_vien_id = ? OR EXISTS(
         SELECT 1 FROM ghi_danh ours JOIN ghi_danh theirs ON theirs.hoc_vien_id = ours.hoc_vien_id
         WHERE ours.lop_hoc_id = ? AND theirs.lop_hoc_id = bh.lop_hoc_id AND ours.trang_thai = 'dang_hoc' AND theirs.trang_thai = 'dang_hoc')) LIMIT 1`,
    [classId, dayOfWeek, endTime, startTime, roomId, teacherId, classId],
  )
  if (actualConflicts[0]) throw new HttpError(409, `Khung giờ trùng với buổi thực tế/học bù của lớp ${actualConflicts[0].className}`)
}

async function ensureRoomCapacity(classId: number, roomId: number, connection: QueryConnection = database): Promise<void> {
  const [rows] = await connection.query<SimpleRow[]>(
    `SELECT l.si_so_toi_da AS classCapacity, p.suc_chua AS roomCapacity, p.ma_phong AS roomCode
     FROM lop_hoc l JOIN phong_hoc p ON p.id = ?
     WHERE l.id = ? AND l.trang_thai IN ('sap_khai_giang', 'dang_hoc')`,
    [roomId, classId],
  )
  const item = rows[0]
  if (!item) throw new HttpError(400, 'Lớp học hoặc phòng học không hợp lệ')
  if (!roomCanHostClass(Number(item.roomCapacity), Number(item.classCapacity))) {
    throw new HttpError(409, `Phòng ${item.roomCode} chỉ có ${item.roomCapacity} chỗ, lớp cần ${item.classCapacity} chỗ`)
  }
}

async function notifyScheduleChange(connection: QueryConnection, classId: number, content: string, teacherIds: number[] = []): Promise<void> {
  await connection.execute(
    `INSERT INTO thong_bao (nguoi_dung_id, tieu_de, noi_dung)
     SELECT recipient.id, 'Lịch học thay đổi', ?
     FROM (
       SELECT giao_vien_id AS id FROM lop_hoc WHERE id = ?
       UNION SELECT hoc_vien_id FROM ghi_danh WHERE lop_hoc_id = ? AND trang_thai <> 'da_huy'
       UNION SELECT giao_vien_id FROM buoi_hoc WHERE lop_hoc_id = ? AND trang_thai = 'da_len_lich' AND bat_dau > NOW()
       ${teacherIds.map(() => 'UNION SELECT ?').join(' ')}
     ) recipient WHERE recipient.id IS NOT NULL`,
    [content, classId, classId, classId, ...teacherIds],
  )
}

async function ensureNoSessionConflict(
  sessionId: number,
  teacherId: number,
  roomId: number,
  startsAt: string,
  endsAt: string,
  classId: number,
  connection: QueryConnection,
): Promise<void> {
  const [conflicts] = await connection.query<SimpleRow[]>(
    `SELECT l.ten_lop AS className FROM buoi_hoc bh
     JOIN lop_hoc l ON l.id = bh.lop_hoc_id
     WHERE bh.id <> ? AND bh.trang_thai <> 'da_huy'
       AND bh.bat_dau < ? AND bh.ket_thuc > ?
       AND (bh.giao_vien_id = ? OR bh.phong_hoc_id = ? OR bh.lop_hoc_id = ? OR EXISTS(
         SELECT 1 FROM ghi_danh ours JOIN ghi_danh theirs ON theirs.hoc_vien_id = ours.hoc_vien_id
         WHERE ours.lop_hoc_id = ? AND theirs.lop_hoc_id = bh.lop_hoc_id AND ours.trang_thai = 'dang_hoc' AND theirs.trang_thai = 'dang_hoc'))
     LIMIT 1`,
    [sessionId, endsAt, startsAt, teacherId, roomId, classId, classId],
  )
  if (conflicts[0]) throw new HttpError(409, `Trùng buổi học với lớp ${conflicts[0].className}`)
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
  const connection = await database.getConnection()
  try {
    await connection.beginTransaction()
    await lockScheduling(connection)
    const [rows] = await connection.query<SimpleRow[]>('SELECT ma_phong AS code, suc_chua AS capacity FROM phong_hoc WHERE id = ? FOR UPDATE', [request.params.id])
    if (!rows[0]) throw new HttpError(404, 'Không tìm thấy phòng học')
    const code = request.body.code === undefined ? String(rows[0].code) : text(request.body.code, 'Mã phòng').toUpperCase()
    const capacity = request.body.capacity === undefined ? Number(rows[0].capacity) : positiveInt(request.body.capacity, 'Sức chứa')
    const [scheduled] = await connection.query<SimpleRow[]>(
      `SELECT MAX(l.si_so_toi_da) AS requiredCapacity FROM lop_hoc l
     WHERE l.trang_thai IN ('sap_khai_giang', 'dang_hoc') AND (
       EXISTS(SELECT 1 FROM lich_hang_tuan WHERE phong_hoc_id = ? AND lop_hoc_id = l.id)
       OR EXISTS(SELECT 1 FROM buoi_hoc WHERE phong_hoc_id = ? AND lop_hoc_id = l.id AND trang_thai = 'da_len_lich' AND bat_dau > NOW()))`,
      [request.params.id, request.params.id],
    )
    if (Number(scheduled[0].requiredCapacity ?? 0) > capacity) {
      throw new HttpError(409, `Phòng đang được xếp cho lớp cần ít nhất ${scheduled[0].requiredCapacity} chỗ`)
    }
    await connection.execute('UPDATE phong_hoc SET ma_phong = ?, suc_chua = ? WHERE id = ?', [code, capacity, request.params.id])
    await connection.commit()
    response.json({ success: true, data: { id: Number(request.params.id), code, capacity } })
  } catch (error) { await connection.rollback(); throw error }
  finally { connection.release() }
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
  const connection = await database.getConnection()
  try {
    await connection.beginTransaction()
    await lockScheduling(connection)
    const [rows] = await connection.query<ClassRow[]>(`${classSelect} WHERE l.id = ? GROUP BY l.id`, [request.params.id])
    const current = rows[0]
    if (!current) throw new HttpError(404, 'Không tìm thấy lớp học')
    if (['da_ket_thuc', 'da_huy'].includes(current.status)) throw new HttpError(409, 'Không được sửa lớp đã kết thúc hoặc đã hủy')
    const courseId = request.body.courseId === undefined ? current.courseId : positiveInt(request.body.courseId, 'Khóa học')
    if ((current.enrolled > 0 || current.generatedSessions > 0) && courseId !== current.courseId) throw new HttpError(409, 'Lớp đã có học viên hoặc buổi học, không thể đổi khóa học')
    const teacherId = request.body.teacherId === undefined ? current.teacherId : request.body.teacherId === null ? null : positiveInt(request.body.teacherId, 'Giáo viên')
    await ensureTeacher(teacherId, connection)
    const teacherChanged = teacherId !== current.teacherId
    const weeklySchedules = teacherChanged
      ? (await connection.query<ScheduleSlotRow[]>(
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
          current.id, slot.roomId, slot.dayOfWeek, slot.startTime, slot.endTime, slot.id, teacherId, connection,
        )
      }
    }
    const capacity = request.body.capacity === undefined ? current.capacity : positiveInt(request.body.capacity, 'Sĩ số tối đa')
    if (capacity < current.enrolled) throw new HttpError(400, `Lớp đang có ${current.enrolled} học viên`)
    const [smallRooms] = await connection.query<SimpleRow[]>(
      `SELECT p.ma_phong AS roomCode, p.suc_chua AS roomCapacity FROM phong_hoc p
     WHERE p.suc_chua < ? AND (EXISTS(SELECT 1 FROM lich_hang_tuan WHERE lop_hoc_id = ? AND phong_hoc_id = p.id)
       OR EXISTS(SELECT 1 FROM buoi_hoc WHERE lop_hoc_id = ? AND phong_hoc_id = p.id AND trang_thai = 'da_len_lich' AND bat_dau > NOW())) LIMIT 1`,
      [capacity, current.id, current.id],
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
      const [futureSessions] = await connection.query<SessionRow[]>(
        `${sessionSelect} WHERE bh.lop_hoc_id = ? AND bh.giao_vien_id = ? AND bh.trang_thai = 'da_len_lich' AND bh.bat_dau > NOW()`,
        [current.id, current.teacherId],
      )
      for (const session of futureSessions) await ensureNoSessionConflict(session.id, teacherId!, session.roomId, session.startsAt, session.endsAt, current.id, connection)
      await connection.execute(
        `UPDATE buoi_hoc SET giao_vien_id = ?
         WHERE lop_hoc_id = ? AND giao_vien_id = ? AND trang_thai = 'da_len_lich' AND bat_dau > NOW()`,
        [teacherId, current.id, current.teacherId],
      )
      await notifyScheduleChange(connection, current.id, 'Giáo viên phụ trách lớp và các buổi tương lai đã được cập nhật; các buổi dạy thay giữ nguyên.', [Number(current.teacherId), Number(teacherId)].filter(Boolean))
    }
    await connection.commit()
    const [updated] = await database.query<ClassRow[]>(`${classSelect} WHERE l.id = ? GROUP BY l.id`, [current.id])
    response.json({ success: true, data: updated[0] })
  } catch (error) {
    await connection.rollback()
    throw error
  } finally {
    connection.release()
  }
})

academicRouter.post('/classes/:id/cancel', async (request, response) => {
  const connection = await database.getConnection()
  try {
    await connection.beginTransaction()
    await lockScheduling(connection)
    const [rows] = await connection.query<ClassRow[]>(`${classSelect} WHERE l.id = ? GROUP BY l.id`, [request.params.id])
    const classItem = rows[0]
    if (!classItem) throw new HttpError(404, 'Không tìm thấy lớp học')
    if (classItem.enrolled > 0) throw new HttpError(409, 'Hãy chuyển lớp hoặc hủy ghi danh của học viên trước')
    if (!['sap_khai_giang', 'dang_hoc'].includes(classItem.status) || Number(classItem.hasStarted)) throw new HttpError(409, 'Chỉ được hủy lớp chưa diễn ra')
    await connection.execute("UPDATE lop_hoc SET trang_thai = 'da_huy' WHERE id = ?", [classItem.id])
    await connection.execute("UPDATE buoi_hoc SET trang_thai = 'da_huy' WHERE lop_hoc_id = ? AND trang_thai = 'da_len_lich' AND bat_dau > NOW()", [classItem.id])
    await notifyScheduleChange(connection, classItem.id, `Lớp ${classItem.name} đã hủy; các buổi học tương lai đã được hủy.`)
    await connection.commit()
    response.json({ success: true, message: 'Đã hủy lớp học' })
  } catch (error) { await connection.rollback(); throw error }
  finally { connection.release() }
})

academicRouter.post('/classes/:id/start', async (request, response) => {
  const classId = positiveInt(request.params.id, 'Lớp học')
  const connection = await database.getConnection()
  try {
    await connection.beginTransaction()
    await lockScheduling(connection)
    const [rows] = await connection.query<SimpleRow[]>(
      `SELECT id, ten_lop AS name, trang_thai AS status, giao_vien_id AS teacherId,
        so_buoi AS sessions FROM lop_hoc WHERE id = ? FOR UPDATE`,
      [classId],
    )
    const classItem = rows[0]
    if (!classItem) throw new HttpError(404, 'Không tìm thấy lớp học')
    if (classItem.status !== 'sap_khai_giang') throw new HttpError(409, 'Chỉ lớp sắp khai giảng mới được bắt đầu')
    if (!classItem.teacherId) throw new HttpError(409, 'Lớp chưa được phân công giáo viên')
    await ensureTeacher(Number(classItem.teacherId), connection)
    const [sessionCounts] = await connection.query<SimpleRow[]>(
      "SELECT COUNT(*) AS generatedSessions FROM buoi_hoc WHERE lop_hoc_id = ? AND trang_thai <> 'da_huy'",
      [classId],
    )
    if (Number(sessionCounts[0].generatedSessions) !== Number(classItem.sessions)) {
      throw new HttpError(409, `Cần tạo đủ ${classItem.sessions} buổi học trước khi bắt đầu lớp`)
    }
    const [roster] = await connection.query<SimpleRow[]>("SELECT COUNT(*) AS total FROM ghi_danh WHERE lop_hoc_id = ? AND trang_thai = 'dang_hoc'", [classId])
    if (!Number(roster[0].total)) throw new HttpError(409, 'Cần có ít nhất một học viên đã xếp lớp trước khi bắt đầu')
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
    await lockScheduling(connection)
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
        SUM(trang_thai = 'da_hoc' AND ket_thuc <= NOW()) AS completedSessions
       FROM buoi_hoc WHERE lop_hoc_id = ?`,
      [classId],
    )
    if (Number(sessionCounts[0].generatedSessions) !== Number(classItem.sessions)
      || Number(sessionCounts[0].completedSessions) !== Number(classItem.sessions)) {
      throw new HttpError(409, `Cần hoàn tất điểm danh đủ ${classItem.sessions} buổi học trước khi kết thúc lớp`)
    }
    const [incomplete] = await connection.query<SimpleRow[]>(
      `SELECT gd.id FROM ghi_danh gd WHERE gd.lop_hoc_id = ? AND gd.trang_thai IN ('dang_hoc', 'hoan_thanh')
       AND EXISTS(SELECT 1 FROM buoi_hoc bh WHERE bh.lop_hoc_id = ? AND bh.trang_thai <> 'da_huy'
         AND NOT EXISTS(SELECT 1 FROM diem_danh dd WHERE dd.buoi_hoc_id = bh.id AND dd.ghi_danh_id = gd.id)) LIMIT 1`,
      [classId, classId],
    )
    if (incomplete[0]) throw new HttpError(409, 'Danh sách điểm danh chưa đầy đủ cho tất cả học viên và buổi học')
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
    await lockScheduling(connection)
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
    if (parseTuitionAmount(courses[0].tuition) === null) throw new HttpError(409, 'Khóa học phải có học phí nguyên dương hợp lệ trước khi ghi danh')
    const [duplicates] = await connection.query<SimpleRow[]>(
      `SELECT id FROM ghi_danh WHERE hoc_vien_id = ? AND khoa_hoc_id = ?
       AND trang_thai IN ('cho_xep_lop', 'dang_hoc', 'bao_luu') LIMIT 1`,
      [studentId, courseId],
    )
    if (duplicates[0]) throw new HttpError(409, 'Học viên đã có ghi danh còn hiệu lực cho khóa học này')
    if (classId) await ensureEnrollmentClass(connection, classId, courseId, 1, 0, true, false, studentId)
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

academicRouter.patch('/enrollments/:id', async (request, response) => {
  const enrollmentId = positiveInt(request.params.id, 'Ghi danh')
  const connection = await database.getConnection()
  try {
    await connection.beginTransaction()
    await lockScheduling(connection)
    const [rows] = await connection.query<EnrollmentRow[]>(`${enrollmentSelect} WHERE gd.id = ? FOR UPDATE`, [enrollmentId])
    const current = rows[0]
    if (!current) throw new HttpError(404, 'Không tìm thấy ghi danh')
    const requestedStatus = (request.body.status ?? current.status) as EnrollmentStatus
    if (!['cho_xep_lop', 'dang_hoc', 'bao_luu', 'hoan_thanh', 'da_huy'].includes(requestedStatus)) throw new HttpError(400, 'Trạng thái ghi danh không hợp lệ')
    const classId = requestedStatus === 'bao_luu' ? null : request.body.classId === undefined ? current.classId : request.body.classId === null ? null : positiveInt(request.body.classId, 'Lớp học')
    const status = classId && requestedStatus === 'cho_xep_lop' ? 'dang_hoc' : requestedStatus
    if (!canChangeEnrollmentStatus(current.status, status)) throw new HttpError(409, 'Không thể chuyển sang trạng thái ghi danh đã chọn')
    if (status === 'dang_hoc' && !classId) throw new HttpError(400, 'Hãy xếp lớp trước khi chuyển sang đang học')
    if (classId !== current.classId && !['dang_hoc', 'bao_luu', 'cho_xep_lop'].includes(status)) throw new HttpError(400, 'Không thể đổi lớp với trạng thái ghi danh đã chọn')
    if ((classId !== current.classId || ['bao_luu', 'da_huy'].includes(status) && status !== current.status) && !Number(current.canChangeClass)) {
      throw new HttpError(409, 'Không được chuyển lớp, bảo lưu hoặc hủy sau khi lớp đã bắt đầu học hay đã có điểm/chứng chỉ; lịch sử học tập được giữ nguyên')
    }
    if (classId && (classId !== current.classId || (status === 'dang_hoc' && current.status !== 'dang_hoc'))) {
      const resumeExistingClass = current.status === 'bao_luu' && status === 'dang_hoc' && classId === current.classId
      await ensureEnrollmentClass(connection, classId, current.courseId, 1, current.id, true, resumeExistingClass, current.studentId)
    }
    if (status === 'da_huy') {
      const [invoices] = await connection.query<SimpleRow[]>(
        'SELECT id, trang_thai AS status FROM hoa_don WHERE ghi_danh_id = ? FOR UPDATE',
        [current.id],
      )
      if (invoices.some((invoice) => invoice.status === 'da_thanh_toan')) throw new HttpError(409, 'Ghi danh đã thanh toán không thể hủy; chỉ chuyển lớp hoặc bảo lưu trước khi học. Hệ thống chưa hỗ trợ hoàn tiền')
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
      const message = status === 'bao_luu' ? 'Ghi danh đã được bảo lưu trước khi học; chỗ trong lớp cũ được giải phóng và học phí đã nộp được giữ nguyên. Khi tiếp tục, trung tâm sẽ xếp lớp chưa bắt đầu.'
        : status === 'da_huy' ? 'Ghi danh của bạn đã được hủy.'
          : status === 'dang_hoc' && current.status === 'bao_luu' ? `Ghi danh đã tiếp tục${classId === current.classId ? ' tại lớp cũ; toàn bộ lịch sử trước đó giữ nguyên' : ' tại lớp mới chưa bắt đầu'}.`
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
  const connection = await database.getConnection()
  try {
    await connection.beginTransaction()
    await lockScheduling(connection)
    const [sessions] = await connection.query<SimpleRow[]>('SELECT COUNT(*) AS total FROM buoi_hoc WHERE lop_hoc_id = ?', [classId])
    if (Number(sessions[0].total) > 0) throw new HttpError(409, 'Lớp đã sinh buổi học; hãy chỉnh sửa lịch hiện có')
    await ensureRoomCapacity(classId, roomId, connection)
    await ensureNoScheduleConflict(classId, roomId, dayOfWeek, startTime, endTime, 0, undefined, connection)
    const [result] = await connection.execute<ResultSetHeader>(
      `INSERT INTO lich_hang_tuan
     (lop_hoc_id, phong_hoc_id, thu_trong_tuan, gio_bat_dau, gio_ket_thuc)
     VALUES (?, ?, ?, ?, ?)`,
      [classId, roomId, dayOfWeek, startTime, endTime],
    )
    await notifyScheduleChange(connection, classId, `Lịch học đã được xếp vào ${dayOfWeek === 1 ? 'Chủ nhật' : `Thứ ${dayOfWeek}`}, ${startTime.slice(0, 5)}-${endTime.slice(0, 5)}.`)
    await connection.commit()
    const [rows] = await database.query<ScheduleRow[]>(`${scheduleSelect} WHERE lh.id = ?`, [result.insertId])
    response.status(201).json({ success: true, data: rows[0] })
  } catch (error) { await connection.rollback(); throw error }
  finally { connection.release() }
})

academicRouter.patch('/schedules/:id', async (request, response) => {
  const connection = await database.getConnection()
  try {
    await connection.beginTransaction()
    await lockScheduling(connection)
    const [rows] = await connection.query<ScheduleRow[]>(`${scheduleSelect} WHERE lh.id = ? FOR UPDATE`, [request.params.id])
    const current = rows[0]
    if (!current) throw new HttpError(404, 'Không tìm thấy lịch học')
    const classId = request.body.classId === undefined ? current.classId : positiveInt(request.body.classId, 'Lớp học')
    const roomId = request.body.roomId === undefined ? current.roomId : positiveInt(request.body.roomId, 'Phòng học')
    const dayOfWeek = request.body.dayOfWeek === undefined ? current.dayOfWeek : positiveInt(request.body.dayOfWeek, 'Thứ trong tuần')
    const startTime = request.body.startTime === undefined ? current.startTime : time(request.body.startTime, 'Giờ bắt đầu')
    const endTime = request.body.endTime === undefined ? current.endTime : time(request.body.endTime, 'Giờ kết thúc')
    if (dayOfWeek > 7 || endTime <= startTime) throw new HttpError(400, 'Ngày hoặc khung giờ không hợp lệ')
    const [sessions] = await connection.query<SimpleRow[]>('SELECT COUNT(*) AS total FROM buoi_hoc WHERE lop_hoc_id IN (?, ?)', [current.classId, classId])
    const hasSessions = Number(sessions[0].total) > 0
    if (hasSessions && (classId !== current.classId || dayOfWeek !== current.dayOfWeek)) {
      throw new HttpError(409, 'Lớp đã sinh buổi học; chỉ được đổi phòng hoặc khung giờ trong cùng ngày')
    }
    await ensureRoomCapacity(classId, roomId, connection)
    await ensureNoScheduleConflict(classId, roomId, dayOfWeek, startTime, endTime, current.id, undefined, connection)
    await connection.execute(
      `UPDATE lich_hang_tuan SET lop_hoc_id = ?, phong_hoc_id = ?, thu_trong_tuan = ?,
       gio_bat_dau = ?, gio_ket_thuc = ? WHERE id = ?`,
      [classId, roomId, dayOfWeek, startTime, endTime, current.id],
    )
    if (hasSessions) {
      const [futureSessions] = await connection.query<SessionRow[]>(
        `${sessionSelect} WHERE bh.lop_hoc_id = ? AND bh.phong_hoc_id = ? AND DAYOFWEEK(bh.bat_dau) = ?
           AND TIME(bh.bat_dau) = ? AND TIME(bh.ket_thuc) = ? AND bh.trang_thai = 'da_len_lich' AND bh.bat_dau > NOW()`,
        [current.classId, current.roomId, current.dayOfWeek, current.startTime, current.endTime],
      )
      // Xóa khỏi tập xung đột trong giao dịch để kiểm tra toàn bộ thời gian mới, kể cả các buổi cùng thay đổi.
      if (futureSessions.length) await connection.query("UPDATE buoi_hoc SET trang_thai = 'da_huy' WHERE id IN (?)", [futureSessions.map((item) => item.id)])
      for (const session of futureSessions) {
        const startsAt = `${session.startsAt.slice(0, 10)} ${startTime}`
        const endsAt = `${session.endsAt.slice(0, 10)} ${endTime}`
        const [future] = await connection.query<SimpleRow[]>('SELECT (? > NOW()) AS valid', [startsAt])
        if (!Number(future[0].valid)) throw new HttpError(409, 'Khung giờ mới không được đẩy buổi học về quá khứ')
        await ensureNoSessionConflict(session.id, session.teacherId, roomId, startsAt, endsAt, classId, connection)
        await connection.execute("UPDATE buoi_hoc SET phong_hoc_id = ?, bat_dau = ?, ket_thuc = ?, trang_thai = 'da_len_lich' WHERE id = ?", [roomId, startsAt, endsAt, session.id])
      }
    }
    await notifyScheduleChange(
      connection,
      classId,
      `Lịch học đã đổi sang ${dayOfWeek === 1 ? 'Chủ nhật' : `Thứ ${dayOfWeek}`}, ${startTime.slice(0, 5)}-${endTime.slice(0, 5)}; phòng học đã được cập nhật.`,
    )
    await connection.commit()
    const [updated] = await database.query<ScheduleRow[]>(`${scheduleSelect} WHERE lh.id = ?`, [current.id])
    response.json({ success: true, data: updated[0] })
  } catch (error) {
    await connection.rollback()
    throw error
  } finally {
    connection.release()
  }
})

academicRouter.delete('/schedules/:id', async (request, response) => {
  const connection = await database.getConnection()
  try {
    await connection.beginTransaction()
    await lockScheduling(connection)
    const [rows] = await connection.query<ScheduleRow[]>(`${scheduleSelect} WHERE lh.id = ? FOR UPDATE`, [request.params.id])
    const current = rows[0]
    if (!current) throw new HttpError(404, 'Không tìm thấy lịch học')
    const [sessions] = await connection.query<SimpleRow[]>('SELECT COUNT(*) AS total FROM buoi_hoc WHERE lop_hoc_id = ?', [current.classId])
    if (Number(sessions[0].total) > 0) throw new HttpError(409, 'Không thể xóa lịch sau khi đã sinh buổi học; hãy chỉnh sửa phòng hoặc giờ học')
    const [result] = await connection.execute<ResultSetHeader>('DELETE FROM lich_hang_tuan WHERE id = ?', [request.params.id])
    if (!result.affectedRows) throw new HttpError(404, 'Không tìm thấy lịch học')
    await notifyScheduleChange(connection, current.classId, `Đã xóa lịch ${current.dayOfWeek === 1 ? 'Chủ nhật' : `Thứ ${current.dayOfWeek}`}, ${current.startTime.slice(0, 5)}-${current.endTime.slice(0, 5)}.`)
    await connection.commit()
    response.status(204).send()
  } catch (error) { await connection.rollback(); throw error }
  finally { connection.release() }
})

academicRouter.post('/classes/:id/generate-sessions', async (request, response) => {
  const connection = await database.getConnection()
  try {
    await connection.beginTransaction()
    await lockScheduling(connection)
    const [classRows] = await connection.query<ClassRow[]>(`${classSelect} WHERE l.id = ? GROUP BY l.id`, [request.params.id])
    const classItem = classRows[0]
    if (!classItem) throw new HttpError(404, 'Không tìm thấy lớp học')
    if (classItem.status !== 'sap_khai_giang') throw new HttpError(409, 'Chỉ được sinh buổi học cho lớp sắp khai giảng')
    if (!classItem.teacherId) throw new HttpError(409, 'Lớp chưa được phân công giáo viên')
    await ensureTeacher(classItem.teacherId, connection)
    const [existing] = await connection.query<SimpleRow[]>('SELECT COUNT(*) AS total FROM buoi_hoc WHERE lop_hoc_id = ?', [classItem.id])
    if (Number(existing[0].total) > 0) throw new HttpError(409, 'Lớp đã có buổi học, không sinh lại để tránh trùng dữ liệu')
    const [scheduleRows] = await connection.query<ScheduleRow[]>(`${scheduleSelect} WHERE lh.lop_hoc_id = ?`, [classItem.id])
    const slots: WeeklySlot[] = scheduleRows.map((item) => ({
      dayOfWeek: item.dayOfWeek,
      startTime: item.startTime,
      endTime: item.endTime,
      roomId: item.roomId,
    }))
    const sessions = generateSessionDates(classItem.startDate, classItem.sessions, slots)
    if (sessions.length !== classItem.sessions) throw new HttpError(409, 'Chưa có lịch hàng tuần hợp lệ để sinh đủ buổi học')
    for (const session of sessions) {
      const [future] = await connection.query<SimpleRow[]>('SELECT (? > NOW()) AS valid', [session.startsAt])
      if (!Number(future[0].valid)) throw new HttpError(409, 'Lịch sinh buổi phải bắt đầu trong tương lai; hãy điều chỉnh ngày khai giảng trước khi tạo buổi')
      await ensureRoomCapacity(classItem.id, session.roomId, connection)
      await ensureNoSessionConflict(0, classItem.teacherId, session.roomId, session.startsAt, session.endsAt, classItem.id, connection)
      await connection.execute(
        `INSERT INTO buoi_hoc
         (lop_hoc_id, giao_vien_id, phong_hoc_id, bat_dau, ket_thuc)
         VALUES (?, ?, ?, ?, ?)`,
        [classItem.id, classItem.teacherId, session.roomId, session.startsAt, session.endsAt],
      )
    }
    await notifyScheduleChange(connection, classItem.id, `Đã tạo ${sessions.length} buổi học. Kiểm tra lịch thực tế trong tài khoản của bạn.`)
    await connection.commit()
    response.status(201).json({ success: true, data: { created: sessions.length, sessions } })
  } catch (error) {
    await connection.rollback()
    throw error
  } finally {
    connection.release()
  }
})

academicRouter.get('/classes/:id/sessions', async (request, response) => {
  const classId = positiveInt(request.params.id, 'Lớp học')
  const [classes] = await database.query<SimpleRow[]>('SELECT id FROM lop_hoc WHERE id = ?', [classId])
  if (!classes[0]) throw new HttpError(404, 'Không tìm thấy lớp học')
  const [rows] = await database.query<SessionRow[]>(
    `${sessionSelect} WHERE bh.lop_hoc_id = ? ORDER BY bh.bat_dau`,
    [classId],
  )
  response.json({ success: true, data: rows })
})

academicRouter.patch('/sessions/:id', async (request, response) => {
  const sessionId = positiveInt(request.params.id, 'Buổi học')
  const connection = await database.getConnection()
  try {
    await connection.beginTransaction()
    await lockScheduling(connection)
    const [rows] = await connection.query<SessionRow[]>(`${sessionSelect} WHERE bh.id = ? FOR UPDATE`, [sessionId])
    const current = rows[0]
    if (!current) throw new HttpError(404, 'Không tìm thấy buổi học')
    if (!canEditSession(current.status, Boolean(Number(current.hasStarted)))) {
      throw new HttpError(409, 'Chỉ được sửa buổi chưa diễn ra hoặc xếp lịch bù cho buổi đã hủy')
    }
    if (Number(current.attendanceCount)) throw new HttpError(409, 'Buổi học đã có điểm danh; không được thay đổi lịch sử')
    const sessionDate = date(request.body.date, 'Ngày học')
    const startTime = time(request.body.startTime, 'Giờ bắt đầu')
    const endTime = time(request.body.endTime, 'Giờ kết thúc')
    if (endTime <= startTime) throw new HttpError(400, 'Giờ kết thúc phải sau giờ bắt đầu')
    const teacherId = positiveInt(request.body.teacherId, 'Giáo viên')
    const roomId = positiveInt(request.body.roomId, 'Phòng học')
    const startsAt = `${sessionDate} ${startTime}`
    const endsAt = `${sessionDate} ${endTime}`
    const [future] = await connection.query<SimpleRow[]>('SELECT (? > NOW()) AS valid', [startsAt])
    if (!Number(future[0].valid)) throw new HttpError(400, 'Buổi học phải được xếp vào thời gian tương lai')
    await ensureTeacher(teacherId, connection)
    await ensureRoomCapacity(current.classId, roomId, connection)
    await ensureNoSessionConflict(sessionId, teacherId, roomId, startsAt, endsAt, current.classId, connection)
    await connection.execute(
      `UPDATE buoi_hoc SET giao_vien_id = ?, phong_hoc_id = ?, bat_dau = ?, ket_thuc = ?,
       trang_thai = 'da_len_lich' WHERE id = ?`,
      [teacherId, roomId, startsAt, endsAt, sessionId],
    )
    await notifyScheduleChange(connection, current.classId, `Buổi học ${current.startsAt.slice(0, 16)} đã ${current.status === 'da_huy' ? 'xếp học bù' : 'dời'} sang ${sessionDate}, ${startTime.slice(0, 5)}-${endTime.slice(0, 5)}.`, [current.teacherId, teacherId])
    await connection.commit()
    const [updated] = await database.query<SessionRow[]>(`${sessionSelect} WHERE bh.id = ?`, [sessionId])
    response.json({ success: true, data: updated[0] })
  } catch (error) {
    await connection.rollback()
    throw error
  } finally {
    connection.release()
  }
})

academicRouter.post('/sessions/:id/cancel', async (request, response) => {
  const sessionId = positiveInt(request.params.id, 'Buổi học')
  const connection = await database.getConnection()
  try {
    await connection.beginTransaction()
    await lockScheduling(connection)
    const [rows] = await connection.query<SessionRow[]>(`${sessionSelect} WHERE bh.id = ? FOR UPDATE`, [sessionId])
    const current = rows[0]
    if (!current) throw new HttpError(404, 'Không tìm thấy buổi học')
    if (!canCancelSession(current.status, Boolean(Number(current.hasStarted)))) {
      throw new HttpError(409, 'Chỉ được hủy buổi học chưa diễn ra')
    }
    await ensureRoomCapacity(current.classId, current.roomId, connection)
    if (Number(current.attendanceCount)) throw new HttpError(409, 'Buổi học đã có điểm danh; không được hủy')
    await connection.execute("UPDATE buoi_hoc SET trang_thai = 'da_huy' WHERE id = ?", [sessionId])
    await notifyScheduleChange(connection, current.classId, `Buổi học ngày ${current.startsAt.slice(0, 10)} đã bị hủy. Trung tâm sẽ cập nhật lịch học bù sau.`, [current.teacherId])
    await connection.commit()
  } catch (error) {
    await connection.rollback()
    throw error
  } finally {
    connection.release()
  }
  response.json({ success: true })
})
