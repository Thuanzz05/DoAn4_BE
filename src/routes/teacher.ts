import { Router } from 'express'
import type { PoolConnection, ResultSetHeader, RowDataPacket } from 'mysql2/promise'
import { database } from '../config/database'
import { requireAuth, requireRole } from '../middlewares/auth'
import { normalizeLocalDateTime } from '../utils/date-time'
import { isValidDraftScore } from '../utils/grades'
import { attendanceCountColumns, attendanceRateSql, attendanceStatsJoin } from '../utils/attendance'
import { HttpError } from '../utils/http-error'
import { canMarkAttendance } from '../utils/schedule'
import { academicId, examDetails } from '../utils/academic'
import { classAcademicWorkbook, loadClassAcademic } from '../services/class-academic'

type SimpleRow = RowDataPacket & Record<string, string | number | null>
type AttendanceStatus = 'co_mat' | 'di_muon' | 'vang'

export const teacherRouter = Router()
teacherRouter.use(requireAuth, requireRole('giao_vien'))

function positiveInt(value: unknown, label: string): number {
  const parsed = Number(value)
  if ((typeof value !== 'string' && typeof value !== 'number') || !Number.isSafeInteger(parsed) || parsed < 1) {
    throw new HttpError(400, `${label} phải là số nguyên dương`)
  }
  return parsed
}

function optionalDate(value: unknown, label: string): string | null {
  if (value === undefined || value === null || value === '') return null
  if (typeof value !== 'string' || !normalizeLocalDateTime(`${value}T00:00`)) {
    throw new HttpError(400, `${label} phải có định dạng YYYY-MM-DD`)
  }
  return value
}

async function ensureOwnedClass(teacherId: number, classId: number, connection: PoolConnection | typeof database = database): Promise<void> {
  const [rows] = await connection.query<SimpleRow[]>(
    `SELECT id FROM lop_hoc WHERE id = ? AND giao_vien_id = ? AND trang_thai <> 'da_huy'
      ${connection === database ? '' : 'FOR UPDATE'}`,
    [classId, teacherId],
  )
  if (!rows[0]) throw new HttpError(404, 'Không tìm thấy lớp được phân công')
}

async function ownedSession(teacherId: number, sessionId: number, connection: PoolConnection | typeof database = database): Promise<SimpleRow> {
  const [rows] = await connection.query<SimpleRow[]>(
    `SELECT id, lop_hoc_id AS classId, trang_thai AS status,
      bat_dau <= NOW() AS hasStarted
     FROM buoi_hoc WHERE id = ? AND giao_vien_id = ? ${connection === database ? '' : 'FOR UPDATE'}`,
    [sessionId, teacherId],
  )
  if (!rows[0]) throw new HttpError(404, 'Không tìm thấy buổi học được phân công')
  return rows[0]
}

async function ownedExam(teacherId: number, examId: number, connection: PoolConnection | typeof database = database): Promise<SimpleRow> {
  const [rows] = await connection.query<SimpleRow[]>(
    `SELECT kt.id, kt.lop_hoc_id AS classId, kt.han_sua_diem AS deadline,
      kt.han_sua_diem IS NOT NULL AND kt.han_sua_diem <= NOW() AS deadlinePassed,
      l.trang_thai = 'da_huy' AS locked
     FROM ky_thi kt JOIN lop_hoc l ON l.id = kt.lop_hoc_id
     WHERE kt.id = ? AND l.giao_vien_id = ?`,
    [examId, teacherId],
  )
  if (!rows[0]) throw new HttpError(404, 'Không tìm thấy kỳ thi của lớp được phân công')
  return rows[0]
}

teacherRouter.get('/dashboard', async (request, response) => {
  const teacherId = request.auth!.userId
  const [summary] = await database.query<SimpleRow[]>(
    `SELECT
      (SELECT COUNT(*) FROM lop_hoc WHERE giao_vien_id = ? AND trang_thai <> 'da_huy') AS classes,
      (SELECT COUNT(*) FROM ghi_danh gd JOIN lop_hoc l ON l.id = gd.lop_hoc_id
        WHERE l.giao_vien_id = ? AND l.trang_thai <> 'da_huy'
          AND gd.trang_thai IN ('dang_hoc', 'hoan_thanh')) AS students,
      (SELECT COUNT(*) FROM buoi_hoc WHERE giao_vien_id = ? AND trang_thai <> 'da_huy'
        AND YEARWEEK(bat_dau, 1) = YEARWEEK(CURDATE(), 1)) AS sessionsThisWeek,
      (SELECT COUNT(*) FROM buoi_hoc WHERE giao_vien_id = ? AND trang_thai = 'da_len_lich'
        AND bat_dau <= NOW()) AS attendanceDue`,
    [teacherId, teacherId, teacherId, teacherId],
  )
  const [todaySessions] = await database.query<SimpleRow[]>(
    `SELECT bh.id, l.ma_lop AS classCode, l.ten_lop AS className,
      bh.bat_dau AS startsAt, bh.ket_thuc AS endsAt, p.ma_phong AS roomCode,
      bh.trang_thai AS status
     FROM buoi_hoc bh JOIN lop_hoc l ON l.id = bh.lop_hoc_id
     JOIN phong_hoc p ON p.id = bh.phong_hoc_id
     WHERE bh.giao_vien_id = ? AND DATE(bh.bat_dau) = CURDATE()
     ORDER BY bh.bat_dau`,
    [teacherId],
  )
  response.json({ success: true, data: { ...summary[0], todaySessions } })
})

teacherRouter.get('/classes', async (request, response) => {
  const [rows] = await database.query(
    `SELECT l.id, l.ma_lop AS code, l.ten_lop AS name, k.ten_khoa_hoc AS courseName,
      l.ngay_khai_giang AS startDate, l.so_buoi AS sessions, l.trang_thai AS status,
      COUNT(DISTINCT gd.id) AS students,
      COALESCE(100 * COUNT(DISTINCT CASE WHEN dd.trang_thai IN ('co_mat', 'di_muon') THEN dd.id END) /
        NULLIF(COUNT(DISTINCT gd.id) * COUNT(DISTINCT bh.id), 0), 0) AS attendanceRate,
      COUNT(DISTINCT gd.id) * COUNT(DISTINCT bh.id) AS expectedAttendance,
      COUNT(DISTINCT dd.id) AS recordedAttendance,
      COUNT(DISTINCT CASE WHEN bh.giao_vien_id = ? AND bh.trang_thai = 'da_len_lich' THEN bh.id END) AS pendingAttendance,
      EXISTS(SELECT 1 FROM chung_chi cc JOIN ghi_danh enrolled ON enrolled.id = cc.ghi_danh_id
        WHERE enrolled.lop_hoc_id = l.id) AS examLocked,
      GROUP_CONCAT(DISTINCT CONCAT(lh.thu_trong_tuan, '|', TIME_FORMAT(lh.gio_bat_dau, '%H:%i'), '|', TIME_FORMAT(lh.gio_ket_thuc, '%H:%i'))
        ORDER BY lh.thu_trong_tuan, lh.gio_bat_dau SEPARATOR ',') AS weeklySchedule
     FROM lop_hoc l JOIN khoa_hoc k ON k.id = l.khoa_hoc_id
     LEFT JOIN ghi_danh gd ON gd.lop_hoc_id = l.id AND gd.trang_thai IN ('dang_hoc', 'hoan_thanh')
     LEFT JOIN lich_hang_tuan lh ON lh.lop_hoc_id = l.id
     LEFT JOIN buoi_hoc bh ON bh.lop_hoc_id = l.id AND bh.bat_dau <= NOW() AND bh.trang_thai <> 'da_huy'
     LEFT JOIN diem_danh dd ON dd.buoi_hoc_id = bh.id AND dd.ghi_danh_id = gd.id
     WHERE l.giao_vien_id = ? AND l.trang_thai <> 'da_huy'
     GROUP BY l.id ORDER BY l.id DESC`,
    [request.auth!.userId, request.auth!.userId],
  )
  response.json({ success: true, data: rows })
})

teacherRouter.get('/sessions', async (request, response) => {
  const from = optionalDate(request.query.from, 'Ngày bắt đầu')
  const to = optionalDate(request.query.to, 'Ngày kết thúc')
  if (from && to && to < from) throw new HttpError(400, 'Ngày kết thúc phải từ ngày bắt đầu trở đi')
  const [rows] = await database.query(
    `SELECT bh.id, bh.lop_hoc_id AS classId, l.ma_lop AS classCode, l.ten_lop AS className,
      bh.bat_dau AS startsAt, bh.ket_thuc AS endsAt, bh.trang_thai AS status,
      p.id AS roomId, p.ma_phong AS roomCode,
      COUNT(DISTINCT CASE WHEN gd.trang_thai IN ('dang_hoc', 'hoan_thanh') THEN gd.id END) AS students,
      COUNT(DISTINCT dd.id) AS attendanceMarked
     FROM buoi_hoc bh JOIN lop_hoc l ON l.id = bh.lop_hoc_id
     JOIN phong_hoc p ON p.id = bh.phong_hoc_id
     LEFT JOIN ghi_danh gd ON gd.lop_hoc_id = l.id
     LEFT JOIN diem_danh dd ON dd.buoi_hoc_id = bh.id
     WHERE bh.giao_vien_id = ?
       AND (? IS NULL OR DATE(bh.bat_dau) >= ?)
       AND (? IS NULL OR DATE(bh.bat_dau) <= ?)
     GROUP BY bh.id ORDER BY bh.bat_dau`,
    [request.auth!.userId, from, from, to, to],
  )
  response.json({ success: true, data: rows })
})

teacherRouter.get('/sessions/:id/attendance', async (request, response) => {
  const sessionId = positiveInt(request.params.id, 'Buổi học')
  const session = await ownedSession(request.auth!.userId, sessionId)
  const [rows] = await database.query(
    `SELECT gd.id AS enrollmentId, hv.ma_nguoi_dung AS studentCode, hv.ho_ten AS studentName,
      dd.trang_thai AS status, dd.ghi_chu AS note, cc.id AS certificateId,
      ${attendanceRateSql} AS attendanceRate, ${attendanceCountColumns}
     FROM ghi_danh gd JOIN nguoi_dung hv ON hv.id = gd.hoc_vien_id
     LEFT JOIN diem_danh dd ON dd.ghi_danh_id = gd.id AND dd.buoi_hoc_id = ?
     LEFT JOIN chung_chi cc ON cc.ghi_danh_id = gd.id
     ${attendanceStatsJoin}
     WHERE gd.lop_hoc_id = ? AND gd.trang_thai IN ('dang_hoc', 'hoan_thanh')
     ORDER BY hv.ho_ten`,
    [sessionId, session.classId],
  )
  response.json({ success: true, data: { sessionId, students: rows } })
})

teacherRouter.put('/sessions/:id/attendance', async (request, response) => {
  const sessionId = positiveInt(request.params.id, 'Buổi học')
  const items = request.body.items
  if (!Array.isArray(items) || !items.length) throw new HttpError(400, 'Danh sách điểm danh là bắt buộc')
  const connection = await database.getConnection()
  try {
    await connection.beginTransaction()
    const [classes] = await connection.query<SimpleRow[]>(
      `SELECT l.id FROM lop_hoc l WHERE EXISTS
        (SELECT 1 FROM buoi_hoc bh WHERE bh.lop_hoc_id = l.id AND bh.id = ? AND bh.giao_vien_id = ?)
        AND l.trang_thai <> 'da_huy' FOR UPDATE`,
      [sessionId, request.auth!.userId],
    )
    if (!classes[0]) throw new HttpError(404, 'Không tìm thấy buổi học được phân công')
    const session = await ownedSession(request.auth!.userId, sessionId, connection)
    if (!canMarkAttendance(String(session.status), Boolean(Number(session.hasStarted)))) {
      throw new HttpError(409, session.status === 'da_huy'
        ? 'Không thể điểm danh buổi học đã hủy'
        : 'Chỉ được điểm danh sau khi buổi học bắt đầu')
    }
    const [enrollments] = await connection.query<SimpleRow[]>(
      `SELECT gd.id, cc.id AS certificateId, dd.trang_thai AS currentStatus, dd.ghi_chu AS currentNote
       FROM ghi_danh gd
       LEFT JOIN chung_chi cc ON cc.ghi_danh_id = gd.id
       LEFT JOIN diem_danh dd ON dd.ghi_danh_id = gd.id AND dd.buoi_hoc_id = ?
       WHERE gd.lop_hoc_id = ? AND gd.trang_thai IN ('dang_hoc', 'hoan_thanh') FOR UPDATE`,
      [sessionId, session.classId],
    )
    const enrollmentById = new Map(enrollments.map((item) => [Number(item.id), item]))
    const receivedIds = new Set<number>()
    for (const item of items as Record<string, unknown>[]) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) throw new HttpError(400, 'Dữ liệu điểm danh không hợp lệ')
      const enrollmentId = positiveInt(item.enrollmentId, 'Ghi danh')
      const status = item.status as AttendanceStatus
      const enrollment = enrollmentById.get(enrollmentId)
      if (!enrollment) throw new HttpError(400, 'Học viên không thuộc lớp này')
      if (receivedIds.has(enrollmentId)) throw new HttpError(400, 'Danh sách điểm danh bị trùng học viên')
      if (!['co_mat', 'di_muon', 'vang'].includes(status)) throw new HttpError(400, 'Trạng thái điểm danh không hợp lệ')
      receivedIds.add(enrollmentId)
      const note = typeof item.note === 'string' && item.note.trim() ? item.note.trim().slice(0, 255) : null
      const currentNote = enrollment.currentNote === null ? null : String(enrollment.currentNote)
      if (enrollment.certificateId !== null) {
        if (enrollment.currentStatus !== status || currentNote !== note) {
          throw new HttpError(409, 'Học viên đã được duyệt chứng chỉ, không thể sửa điểm danh')
        }
        continue
      }
      await connection.execute(
        `INSERT INTO diem_danh (buoi_hoc_id, ghi_danh_id, trang_thai, ghi_chu)
         VALUES (?, ?, ?, ?) AS incoming
         ON DUPLICATE KEY UPDATE trang_thai = incoming.trang_thai,
          ghi_chu = incoming.ghi_chu, thoi_gian_diem_danh = CURRENT_TIMESTAMP`,
        [sessionId, enrollmentId, status, note],
      )
    }
    if (receivedIds.size !== enrollmentById.size) throw new HttpError(400, 'Cần điểm danh đủ tất cả học viên trong lớp')
    await connection.execute("UPDATE buoi_hoc SET trang_thai = 'da_hoc' WHERE id = ?", [sessionId])
    await connection.commit()
    response.json({ success: true, message: 'Đã lưu điểm danh', data: { saved: receivedIds.size } })
  } catch (error) {
    await connection.rollback()
    throw error
  } finally {
    connection.release()
  }
})

teacherRouter.get('/classes/:id/exams', async (request, response) => {
  const classId = positiveInt(request.params.id, 'Lớp học')
  await ensureOwnedClass(request.auth!.userId, classId)
  const [rows] = await database.query(
    `SELECT id, lop_hoc_id AS classId, ten_ky_thi AS name, ngay_thi AS examDate,
      han_sua_diem AS deadline FROM ky_thi WHERE lop_hoc_id = ? ORDER BY id DESC`,
    [classId],
  )
  response.json({ success: true, data: rows })
})

teacherRouter.get('/classes/:id/academic', async (request, response) => {
  const classId = academicId(request.params.id, 'Lớp học')
  response.json({ success: true, data: await loadClassAcademic(classId, request.auth!.userId) })
})

teacherRouter.get('/classes/:id/academic/export', async (request, response) => {
  const classId = academicId(request.params.id, 'Lớp học')
  const section = request.query.section === undefined ? 'all' : String(request.query.section)
  const data = await loadClassAcademic(classId, request.auth!.userId)
  const buffer = await classAcademicWorkbook(data, section)
  response.set({ 'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'Content-Disposition': `attachment; filename="hoc-vu-lop-${classId}-${section}.xlsx"` })
  response.send(buffer)
})

teacherRouter.post('/classes/:id/exams', async (request, response) => {
  const classId = positiveInt(request.params.id, 'Lớp học')
  const { name, examDate, deadline } = examDetails(request.body)
  const connection = await database.getConnection()
  try {
    await connection.beginTransaction()
    await ensureOwnedClass(request.auth!.userId, classId, connection)
    const [certificates] = await connection.query<SimpleRow[]>(
      `SELECT cc.id FROM chung_chi cc JOIN ghi_danh gd ON gd.id = cc.ghi_danh_id
        WHERE gd.lop_hoc_id = ? LIMIT 1`, [classId],
    )
    if (certificates.length) throw new HttpError(409, 'Lớp đã chốt hồ sơ chứng chỉ, không thể bổ sung kỳ thi')
    if (deadline) {
      const [dates] = await connection.query<SimpleRow[]>('SELECT ? <= NOW() AS expired', [deadline])
      if (Number(dates[0]?.expired)) throw new HttpError(400, 'Hạn sửa điểm phải ở tương lai')
    }
    const [result] = await connection.execute<ResultSetHeader>(
      'INSERT INTO ky_thi (lop_hoc_id, ten_ky_thi, ngay_thi, han_sua_diem) VALUES (?, ?, ?, ?)',
      [classId, name, examDate, deadline],
    )
    await connection.execute(
      'INSERT INTO lich_su_ky_thi (ky_thi_id, nguoi_thay_doi_id, hanh_dong, ly_do, du_lieu_truoc, du_lieu_sau) VALUES (?, ?, ?, ?, NULL, ?)',
      [result.insertId, request.auth!.userId, 'tao', 'Giáo viên tạo kỳ thi', JSON.stringify({ classId, name, examDate, deadline })],
    )
    await connection.commit()
    response.status(201).json({ success: true, data: { id: result.insertId, classId, name, examDate, deadline } })
  } catch (error) {
    await connection.rollback()
    throw error
  } finally {
    connection.release()
  }
})

teacherRouter.get('/exams/:id/results', async (request, response) => {
  const examId = positiveInt(request.params.id, 'Kỳ thi')
  const exam = await ownedExam(request.auth!.userId, examId)
  const [rows] = await database.query<SimpleRow[]>(
    `SELECT gd.id AS enrollmentId, hv.ma_nguoi_dung AS studentCode, hv.ho_ten AS studentName,
      kq.nghe AS listening, kq.noi AS speaking, kq.doc AS reading, kq.viet AS writing,
      cc.id AS certificateId,
      EXISTS(SELECT 1 FROM hoa_don hd WHERE hd.ghi_danh_id = gd.id AND hd.trang_thai = 'da_thanh_toan')
        AND NOT EXISTS(SELECT 1 FROM hoa_don hd WHERE hd.ghi_danh_id = gd.id AND hd.trang_thai = 'chua_thanh_toan') AS eligible,
      CASE WHEN kq.nghe IS NULL OR kq.noi IS NULL OR kq.doc IS NULL OR kq.viet IS NULL THEN NULL
        ELSE (kq.nghe + kq.noi + kq.doc + kq.viet) / 4 END AS average
     FROM ghi_danh gd JOIN nguoi_dung hv ON hv.id = gd.hoc_vien_id
     LEFT JOIN ket_qua_thi kq ON kq.ghi_danh_id = gd.id AND kq.ky_thi_id = ?
     LEFT JOIN chung_chi cc ON cc.ghi_danh_id = gd.id
     WHERE gd.lop_hoc_id = ? AND gd.trang_thai IN ('dang_hoc', 'hoan_thanh')
     ORDER BY hv.ho_ten`,
    [examId, exam.classId],
  )
  response.json({ success: true, data: { exam, students: rows.map((row) => ({ ...row,
    eligible: Boolean(Number(row.eligible)), paid: Boolean(Number(row.eligible)),
    eligibilityReason: Number(row.eligible) ? null : 'Chưa hoàn tất học phí',
  })) } })
})

teacherRouter.put('/exams/:id/results', async (request, response) => {
  const examId = positiveInt(request.params.id, 'Kỳ thi')
  const items = request.body.items
  if (!Array.isArray(items) || !items.length) throw new HttpError(400, 'Bảng điểm là bắt buộc')
  const connection = await database.getConnection()
  try {
    await connection.beginTransaction()
    const [classes] = await connection.query<SimpleRow[]>(
      `SELECT l.id FROM lop_hoc l WHERE l.giao_vien_id = ? AND l.trang_thai <> 'da_huy'
        AND EXISTS (SELECT 1 FROM ky_thi kt WHERE kt.lop_hoc_id = l.id AND kt.id = ?) FOR UPDATE`,
      [request.auth!.userId, examId],
    )
    if (!classes[0]) throw new HttpError(404, 'Không tìm thấy kỳ thi của lớp được phân công')
    const exam = await ownedExam(request.auth!.userId, examId, connection)
    if (Boolean(Number(exam.deadlinePassed))) {
      throw new HttpError(409, 'Đã hết hạn sửa điểm')
    }
    const [enrollments] = await connection.query<SimpleRow[]>(
      `SELECT gd.id, cc.id AS certificateId, kq.id AS resultId,
        kq.nghe AS listening, kq.noi AS speaking, kq.doc AS reading, kq.viet AS writing
       FROM ghi_danh gd
       LEFT JOIN chung_chi cc ON cc.ghi_danh_id = gd.id
       LEFT JOIN ket_qua_thi kq ON kq.ghi_danh_id = gd.id AND kq.ky_thi_id = ?
       WHERE gd.lop_hoc_id = ? AND gd.trang_thai IN ('dang_hoc', 'hoan_thanh')
         AND EXISTS (SELECT 1 FROM hoa_don hd
           WHERE hd.ghi_danh_id = gd.id AND hd.trang_thai = 'da_thanh_toan')
         AND NOT EXISTS (SELECT 1 FROM hoa_don hd
           WHERE hd.ghi_danh_id = gd.id AND hd.trang_thai = 'chua_thanh_toan')
       FOR UPDATE`,
      [examId, exam.classId],
    )
    const enrollmentById = new Map(enrollments.map((item) => [Number(item.id), item]))
    const receivedIds = new Set<number>()
    let saved = 0
    for (const item of items as Record<string, unknown>[]) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) throw new HttpError(400, 'Dữ liệu bảng điểm không hợp lệ')
      const enrollmentId = positiveInt(item.enrollmentId, 'Ghi danh')
      const enrollment = enrollmentById.get(enrollmentId)
      if (!enrollment) throw new HttpError(400, 'Học viên không thuộc lớp hoặc chưa hoàn tất học phí')
      if (receivedIds.has(enrollmentId)) throw new HttpError(400, 'Bảng điểm bị trùng học viên')
      const scores = [item.listening, item.speaking, item.reading, item.writing]
      if (!scores.every(isValidDraftScore)) throw new HttpError(400, 'Điểm phải là null (chưa nhập) hoặc từ 0 đến 10')
      const normalizedScores = scores.map((score) => score === null ? null : Number(score))
      const currentScores = [enrollment.listening, enrollment.speaking, enrollment.reading, enrollment.writing]
        .map((score) => score === null ? null : Number(score))
      if (enrollment.certificateId !== null) {
        if (currentScores.some((score, index) => score !== normalizedScores[index])) {
          throw new HttpError(409, 'Học viên đã được duyệt chứng chỉ, không thể sửa điểm thi')
        }
        receivedIds.add(enrollmentId)
        continue
      }
      receivedIds.add(enrollmentId)
      if (enrollment.resultId === null && normalizedScores.every((score) => score === null)) continue
      await connection.execute(
        `INSERT INTO ket_qua_thi (ky_thi_id, ghi_danh_id, nghe, noi, doc, viet)
         VALUES (?, ?, ?, ?, ?, ?) AS incoming
         ON DUPLICATE KEY UPDATE nghe = incoming.nghe, noi = incoming.noi,
          doc = incoming.doc, viet = incoming.viet`,
        [examId, enrollmentId, ...normalizedScores],
      )
      saved += 1
    }
    await connection.commit()
    response.json({ success: true, message: 'Đã lưu bảng điểm', data: { saved } })
  } catch (error) {
    await connection.rollback()
    throw error
  } finally {
    connection.release()
  }
})
