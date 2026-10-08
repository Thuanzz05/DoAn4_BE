import ExcelJS from 'exceljs'
import type { PoolConnection, RowDataPacket } from 'mysql2/promise'
import { database } from '../config/database'
import { attendanceCountColumns, attendanceRateSql, attendanceStatsJoin } from '../utils/attendance'
import { scoreAverage, summarizeExamScores, type ExamScore } from '../utils/academic'
import { HttpError } from '../utils/http-error'
import { canMarkAttendance } from '../utils/schedule'

type DataRow = RowDataPacket & Record<string, string | number | null>
export type AcademicStudent = {
  enrollmentId: number; studentId: number; studentCode: string; studentName: string; email: string
  enrollmentStatus: string; status: string; certificateId: number | null; paid: boolean; eligible: boolean
  eligibilityReason: string | null; expectedAttendance: number; recordedAttendance: number; presentAttendance: number
  onTimeAttendance: number; lateAttendance: number; absentAttendance: number; missingAttendance: number; attendanceRate: number
  requiredExams: number; completedExams: number; average: number | null
  examResults: Array<ExamScore & { average: number | null }>
}
export type AcademicClass = {
  id: number; code: string; name: string; courseName: string; language: string; startDate: string
  sessions: number; capacity: number; status: string; teacherName: string | null; enrolled: number; certificateLocked: boolean
}
export type AcademicExam = {
  id: number; classId: number; classCode: string; className: string; name: string; examDate: string | null
  deadline: string | null; deadlinePassed: boolean; certificateLocked: boolean; resultsCount: number; completedResults: number
  canceled: boolean; status: 'dang_hoat_dong' | 'da_huy'
}
export type MissingAttendance = {
  sessionId: number; startsAt: string; endsAt: string; teacherName: string; roomCode: string
  enrollmentId: number; studentCode: string; studentName: string; canMarkAttendance: boolean
}
export type AcademicSession = {
  id: number; startsAt: string; endsAt: string; status: string; teacherName: string; roomCode: string
  hasStarted: boolean; canMarkAttendance: boolean; expectedAttendance: number; recordedAttendance: number; missingAttendance: number
  missingStudents: Array<{ enrollmentId: number; studentCode: string; studentName: string }>
}
export type ClassAcademic = { class: AcademicClass; exams: AcademicExam[]; students: AcademicStudent[]; sessions: AcademicSession[]; missingAttendance: MissingAttendance[] }

export const academicExamSelect = `SELECT kt.id, kt.lop_hoc_id AS classId, l.ma_lop AS classCode,
  l.ten_lop AS className, kt.ten_ky_thi AS name, kt.ngay_thi AS examDate, kt.han_sua_diem AS deadline,
  kt.da_huy AS canceled,
  kt.han_sua_diem IS NOT NULL AND kt.han_sua_diem <= NOW() AS deadlinePassed,
  EXISTS(SELECT 1 FROM chung_chi cc JOIN ghi_danh gd ON gd.id = cc.ghi_danh_id WHERE gd.lop_hoc_id = l.id) AS certificateLocked,
  (SELECT COUNT(*) FROM ket_qua_thi kq WHERE kq.ky_thi_id = kt.id) AS resultsCount,
  (SELECT COUNT(*) FROM ket_qua_thi kq JOIN ghi_danh gd ON gd.id = kq.ghi_danh_id
    WHERE kq.ky_thi_id = kt.id AND gd.lop_hoc_id = l.id AND gd.trang_thai IN ('dang_hoc', 'hoan_thanh')
      AND kq.nghe IS NOT NULL AND kq.noi IS NOT NULL AND kq.doc IS NOT NULL AND kq.viet IS NOT NULL) AS completedResults
  FROM ky_thi kt JOIN lop_hoc l ON l.id = kt.lop_hoc_id`

export function asAcademicExam(row: DataRow): AcademicExam {
  return { id: Number(row.id), classId: Number(row.classId), classCode: String(row.classCode), className: String(row.className),
    name: String(row.name), examDate: row.examDate === null ? null : String(row.examDate), deadline: row.deadline === null ? null : String(row.deadline),
    deadlinePassed: Boolean(Number(row.deadlinePassed)), certificateLocked: Boolean(Number(row.certificateLocked)),
    resultsCount: Number(row.resultsCount), completedResults: Number(row.completedResults),
    canceled: Boolean(Number(row.canceled)), status: Number(row.canceled) ? 'da_huy' : 'dang_hoat_dong' }
}

export async function loadClassAcademic(classId: number, teacherId?: number): Promise<ClassAcademic> {
  const connection = await database.getConnection()
  try {
    await connection.beginTransaction()
    const result = await readClassAcademic(connection, classId, teacherId)
    await connection.commit()
    return result
  } catch (error) { await connection.rollback(); throw error }
  finally { connection.release() }
}

async function readClassAcademic(connection: PoolConnection, classId: number, teacherId?: number): Promise<ClassAcademic> {
  const [classes] = await connection.query<DataRow[]>(
    `SELECT l.id, l.ma_lop AS code, l.ten_lop AS name, k.ten_khoa_hoc AS courseName, k.ngoai_ngu AS language,
      l.ngay_khai_giang AS startDate, l.so_buoi AS sessions, l.si_so_toi_da AS capacity, l.trang_thai AS status,
      gv.ho_ten AS teacherName,
      EXISTS(SELECT 1 FROM chung_chi cc JOIN ghi_danh gd ON gd.id = cc.ghi_danh_id WHERE gd.lop_hoc_id = l.id) AS certificateLocked
     FROM lop_hoc l JOIN khoa_hoc k ON k.id = l.khoa_hoc_id LEFT JOIN nguoi_dung gv ON gv.id = l.giao_vien_id
     WHERE l.id = ? ${teacherId === undefined ? '' : "AND l.giao_vien_id = ? AND l.trang_thai <> 'da_huy'"}`,
    teacherId === undefined ? [classId] : [classId, teacherId],
  )
  if (!classes[0]) throw new HttpError(404, teacherId === undefined ? 'Không tìm thấy lớp học' : 'Không tìm thấy lớp được phân công')
  const [examRows] = await connection.query<DataRow[]>(`${academicExamSelect} WHERE kt.lop_hoc_id = ? AND kt.da_huy = FALSE ORDER BY kt.id`, [classId])
  const exams = examRows.map(asAcademicExam)
  const [roster] = await connection.query<DataRow[]>(
    `SELECT gd.id AS enrollmentId, hv.id AS studentId, hv.ma_nguoi_dung AS studentCode, hv.ho_ten AS studentName,
      hv.email, gd.trang_thai AS enrollmentStatus, cc.id AS certificateId,
      EXISTS(SELECT 1 FROM hoa_don hd WHERE hd.ghi_danh_id = gd.id AND hd.trang_thai = 'da_thanh_toan')
        AND NOT EXISTS(SELECT 1 FROM hoa_don hd WHERE hd.ghi_danh_id = gd.id AND hd.trang_thai = 'chua_thanh_toan') AS paid,
      ${attendanceCountColumns}, ${attendanceRateSql} AS attendanceRate,
      (SELECT COUNT(*) FROM diem_danh dd JOIN buoi_hoc bh ON bh.id = dd.buoi_hoc_id
        WHERE dd.ghi_danh_id = gd.id AND bh.lop_hoc_id = gd.lop_hoc_id AND bh.bat_dau <= NOW()
          AND bh.trang_thai <> 'da_huy' AND dd.trang_thai = 'co_mat') AS onTimeAttendance,
      (SELECT COUNT(*) FROM diem_danh dd JOIN buoi_hoc bh ON bh.id = dd.buoi_hoc_id
        WHERE dd.ghi_danh_id = gd.id AND bh.lop_hoc_id = gd.lop_hoc_id AND bh.bat_dau <= NOW()
          AND bh.trang_thai <> 'da_huy' AND dd.trang_thai = 'di_muon') AS lateAttendance,
      (SELECT COUNT(*) FROM diem_danh dd JOIN buoi_hoc bh ON bh.id = dd.buoi_hoc_id
        WHERE dd.ghi_danh_id = gd.id AND bh.lop_hoc_id = gd.lop_hoc_id AND bh.bat_dau <= NOW()
          AND bh.trang_thai <> 'da_huy' AND dd.trang_thai = 'vang') AS absentAttendance
     FROM ghi_danh gd JOIN nguoi_dung hv ON hv.id = gd.hoc_vien_id
     LEFT JOIN chung_chi cc ON cc.ghi_danh_id = gd.id ${attendanceStatsJoin}
     WHERE gd.lop_hoc_id = ? AND gd.trang_thai IN ('dang_hoc', 'hoan_thanh') ORDER BY hv.ho_ten, gd.id`, [classId],
  )
  const [scoreRows] = await connection.query<DataRow[]>(
    `SELECT kq.ghi_danh_id AS enrollmentId, kq.ky_thi_id AS examId, kq.nghe AS listening, kq.noi AS speaking,
      kq.doc AS reading, kq.viet AS writing FROM ket_qua_thi kq JOIN ky_thi kt ON kt.id = kq.ky_thi_id
      JOIN ghi_danh gd ON gd.id = kq.ghi_danh_id
      WHERE kt.lop_hoc_id = ? AND kt.da_huy = FALSE AND gd.lop_hoc_id = kt.lop_hoc_id AND gd.trang_thai IN ('dang_hoc', 'hoan_thanh')`, [classId],
  )
  const scores = new Map<number, ExamScore[]>()
  for (const row of scoreRows) {
    const score: ExamScore = { examId: Number(row.examId), listening: row.listening === null ? null : Number(row.listening),
      speaking: row.speaking === null ? null : Number(row.speaking), reading: row.reading === null ? null : Number(row.reading),
      writing: row.writing === null ? null : Number(row.writing) }
    const enrollmentId = Number(row.enrollmentId)
    scores.set(enrollmentId, [...(scores.get(enrollmentId) ?? []), score])
  }
  const students: AcademicStudent[] = roster.map((row) => {
    const examResults = (scores.get(Number(row.enrollmentId)) ?? []).map((score) => ({ ...score, average: scoreAverage(score) }))
    const paid = Boolean(Number(row.paid))
    return { enrollmentId: Number(row.enrollmentId), studentId: Number(row.studentId), studentCode: String(row.studentCode),
      studentName: String(row.studentName), email: String(row.email), enrollmentStatus: String(row.enrollmentStatus), status: String(row.enrollmentStatus),
      certificateId: row.certificateId === null ? null : Number(row.certificateId), paid, eligible: paid,
      eligibilityReason: paid ? null : 'Chưa hoàn tất học phí', expectedAttendance: Number(row.expectedAttendance),
      recordedAttendance: Number(row.recordedAttendance), presentAttendance: Number(row.presentAttendance),
      onTimeAttendance: Number(row.onTimeAttendance), lateAttendance: Number(row.lateAttendance), absentAttendance: Number(row.absentAttendance),
      missingAttendance: Number(row.expectedAttendance) - Number(row.recordedAttendance), attendanceRate: Number(row.attendanceRate),
      ...summarizeExamScores(exams.map((exam) => exam.id), examResults), examResults }
  })
  const [missingRows] = await connection.query<DataRow[]>(
    `SELECT bh.id AS sessionId, bh.bat_dau AS startsAt, bh.ket_thuc AS endsAt, bh.giao_vien_id AS teacherId, gv.ho_ten AS teacherName,
      p.ma_phong AS roomCode, gd.id AS enrollmentId, hv.ma_nguoi_dung AS studentCode, hv.ho_ten AS studentName
     FROM buoi_hoc bh JOIN ghi_danh gd ON gd.lop_hoc_id = bh.lop_hoc_id AND gd.trang_thai IN ('dang_hoc', 'hoan_thanh')
     JOIN nguoi_dung hv ON hv.id = gd.hoc_vien_id JOIN nguoi_dung gv ON gv.id = bh.giao_vien_id
     JOIN phong_hoc p ON p.id = bh.phong_hoc_id
     LEFT JOIN diem_danh dd ON dd.buoi_hoc_id = bh.id AND dd.ghi_danh_id = gd.id
     WHERE bh.lop_hoc_id = ? AND bh.bat_dau <= NOW() AND bh.trang_thai <> 'da_huy' AND dd.id IS NULL
     ORDER BY bh.bat_dau, hv.ho_ten`, [classId],
  )
  const missingAttendance: MissingAttendance[] = missingRows.map((row) => ({ sessionId: Number(row.sessionId), startsAt: String(row.startsAt),
    endsAt: String(row.endsAt), teacherName: String(row.teacherName), roomCode: String(row.roomCode), enrollmentId: Number(row.enrollmentId),
    studentCode: String(row.studentCode), studentName: String(row.studentName),
    canMarkAttendance: classes[0].status !== 'da_huy' && (teacherId === undefined || Number(row.teacherId) === teacherId) }))
  const [sessionRows] = await connection.query<DataRow[]>(
    `SELECT bh.id, bh.bat_dau AS startsAt, bh.ket_thuc AS endsAt, bh.trang_thai AS status, bh.giao_vien_id AS teacherId,
      gv.ho_ten AS teacherName, p.ma_phong AS roomCode, bh.bat_dau <= NOW() AS hasStarted
     FROM buoi_hoc bh JOIN nguoi_dung gv ON gv.id = bh.giao_vien_id JOIN phong_hoc p ON p.id = bh.phong_hoc_id
     WHERE bh.lop_hoc_id = ? ORDER BY bh.bat_dau, bh.id`, [classId],
  )
  const missingBySession = new Map<number, MissingAttendance[]>()
  for (const row of missingAttendance) missingBySession.set(row.sessionId, [...(missingBySession.get(row.sessionId) ?? []), row])
  const sessions: AcademicSession[] = sessionRows.map((row) => {
    const missing = missingBySession.get(Number(row.id)) ?? []
    const expected = Number(row.hasStarted) && row.status !== 'da_huy' ? students.length : 0
    return { id: Number(row.id), startsAt: String(row.startsAt), endsAt: String(row.endsAt), status: String(row.status),
      teacherName: String(row.teacherName), roomCode: String(row.roomCode), hasStarted: Boolean(Number(row.hasStarted)),
      canMarkAttendance: classes[0].status !== 'da_huy' && canMarkAttendance(String(row.status), Boolean(Number(row.hasStarted)))
        && (teacherId === undefined || Number(row.teacherId) === teacherId),
      expectedAttendance: expected, recordedAttendance: expected - missing.length, missingAttendance: missing.length,
      missingStudents: missing.map(({ enrollmentId, studentCode, studentName }) => ({ enrollmentId, studentCode, studentName })) }
  })
  const row = classes[0]
  return { class: { id: Number(row.id), code: String(row.code), name: String(row.name), courseName: String(row.courseName),
    language: String(row.language), startDate: String(row.startDate), sessions: Number(row.sessions), capacity: Number(row.capacity),
    status: String(row.status), teacherName: row.teacherName === null ? null : String(row.teacherName), enrolled: students.length,
    certificateLocked: Boolean(Number(row.certificateLocked)) }, exams, students, sessions, missingAttendance }
}

export async function classAcademicWorkbook(data: ClassAcademic, section: string): Promise<Buffer> {
  if (!['attendance', 'grades', 'all'].includes(section)) throw new HttpError(400, 'Phần xuất phải là attendance, grades hoặc all')
  const workbook = new ExcelJS.Workbook()
  workbook.creator = 'Trung tâm ngoại ngữ'
  function sheet(name: string, columns: Array<{ header: string; key: string; width?: number }>, rows: Record<string, unknown>[]) {
    const worksheet = workbook.addWorksheet(name)
    worksheet.columns = columns.map((column) => ({ width: 20, ...column }))
    for (const row of rows) worksheet.addRow(row)
    worksheet.getRow(1).font = { bold: true }
    worksheet.views = [{ state: 'frozen', ySplit: 1 }]
    worksheet.autoFilter = { from: 'A1', to: { row: 1, column: columns.length } }
    return worksheet
  }
  const identity = [{ header: 'Mã học viên', key: 'studentCode' }, { header: 'Họ tên', key: 'studentName', width: 30 }]
  if (section === 'all') sheet('Lớp học', [{ header: 'Mã lớp', key: 'code' }, { header: 'Tên lớp', key: 'name', width: 30 },
    { header: 'Khóa học', key: 'courseName', width: 30 }, { header: 'Ngoại ngữ', key: 'language' }, { header: 'Khai giảng', key: 'startDate' },
    { header: 'Số buổi kế hoạch', key: 'sessions' }, { header: 'Học viên', key: 'enrolled' }], [data.class])
  if (section === 'attendance' || section === 'all') {
    const attendance = sheet('Chuyên cần', [...identity, { header: 'Buổi đã diễn ra', key: 'expectedAttendance' },
      { header: 'Đã điểm danh', key: 'recordedAttendance' }, { header: 'Có mặt', key: 'onTimeAttendance' },
      { header: 'Đi muộn', key: 'lateAttendance' }, { header: 'Vắng', key: 'absentAttendance' },
      { header: 'Chưa điểm danh', key: 'missingAttendance' }, { header: 'Chuyên cần (%)', key: 'attendanceRate' }], data.students)
    attendance.getColumn('attendanceRate').numFmt = '0.00"%"'
    sheet('Điểm danh còn thiếu', [...identity, { header: 'Buổi học', key: 'sessionId' }, { header: 'Bắt đầu', key: 'startsAt', width: 23 },
      { header: 'Kết thúc', key: 'endsAt', width: 23 }, { header: 'Giáo viên', key: 'teacherName', width: 30 }, { header: 'Phòng', key: 'roomCode' }], data.missingAttendance)
  }
  if (section === 'grades' || section === 'all') {
    sheet('Điểm toàn khóa', [...identity, { header: 'Kỳ thi bắt buộc', key: 'requiredExams' }, { header: 'Kỳ thi đủ điểm', key: 'completedExams' },
      { header: 'Điểm trung bình', key: 'average' }, { header: 'Kết quả', key: 'result' }, { header: 'Học phí', key: 'tuition' }],
    data.students.map((student) => ({ ...student, result: student.requiredExams === 0 ? 'Chưa có kỳ thi' : student.average === null
      ? 'Chưa đủ điểm' : student.average >= 5 ? 'Đạt' : 'Không đạt', tuition: student.paid ? 'Đã hoàn tất' : 'Chưa hoàn tất' })))
    sheet('Chi tiết kỳ thi', [...identity, { header: 'Kỳ thi', key: 'examName', width: 30 }, { header: 'Ngày thi', key: 'examDate' },
      { header: 'Nghe', key: 'listening' }, { header: 'Nói', key: 'speaking' }, { header: 'Đọc', key: 'reading' },
      { header: 'Viết', key: 'writing' }, { header: 'Trung bình', key: 'average' }], data.students.flatMap((student) => data.exams.map((exam) => {
        const result = student.examResults.find((item) => item.examId === exam.id)
        return { studentCode: student.studentCode, studentName: student.studentName, examName: exam.name, examDate: exam.examDate,
          listening: result?.listening ?? null, speaking: result?.speaking ?? null, reading: result?.reading ?? null,
          writing: result?.writing ?? null, average: result?.average ?? null }
      })))
  }
  return Buffer.from(await workbook.xlsx.writeBuffer())
}
