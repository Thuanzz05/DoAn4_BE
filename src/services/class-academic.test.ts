import assert from 'node:assert/strict'
import test from 'node:test'
import ExcelJS from 'exceljs'
import type { PoolConnection } from 'mysql2/promise'
import { database } from '../config/database'
import { classAcademicWorkbook, loadClassAcademic, type ClassAcademic } from './class-academic'

test('Excel học vụ giữ số 0, điểm trống, dấu phẩy/xuống dòng và thiếu điểm danh riêng', async () => {
  const data: ClassAcademic = {
    class: { id: 1, code: 'A1', name: 'Lớp A1', courseName: 'Tiếng Anh', language: 'Tiếng Anh', startDate: '2026-01-01',
      sessions: 2, capacity: 30, status: 'dang_hoc', teacherName: 'Giáo viên', enrolled: 1, certificateLocked: false },
    exams: [{ id: 1, classId: 1, classCode: 'A1', className: 'Lớp A1', name: 'Thi 1', examDate: null, deadline: null,
      deadlinePassed: false, certificateLocked: false, resultsCount: 1, completedResults: 0, canceled: false, status: 'dang_hoat_dong' }],
    students: [{ enrollmentId: 1, studentId: 1, studentCode: 'HV01', studentName: 'Nguyễn, "An"\nBình', email: 'test@example.test',
      enrollmentStatus: 'dang_hoc', status: 'dang_hoc', certificateId: null, paid: false, eligible: false, eligibilityReason: 'Chưa hoàn tất học phí',
      expectedAttendance: 2, recordedAttendance: 1, presentAttendance: 1, onTimeAttendance: 0, lateAttendance: 1,
      absentAttendance: 0, missingAttendance: 1, attendanceRate: 50, requiredExams: 1, completedExams: 0, average: null,
      examResults: [{ examId: 1, listening: 0, speaking: 0, reading: 0, writing: null, average: null }] }],
    sessions: [], missingAttendance: [{ sessionId: 2, startsAt: '2026-01-02 18:00:00', endsAt: '2026-01-02 19:00:00',
      teacherName: 'Giáo viên', roomCode: 'P1', enrollmentId: 1, studentCode: 'HV01', studentName: 'Nguyễn, "An"\nBình', canMarkAttendance: true }],
  }
  const buffer = await classAcademicWorkbook(data, 'all')
  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.load(buffer)
  assert.equal(workbook.worksheets.length, 5)
  assert.equal(workbook.getWorksheet('Chuyên cần')!.getCell('B2').value, data.students[0].studentName)
  assert.equal(workbook.getWorksheet('Chuyên cần')!.getCell('H2').value, 1)
  assert.equal(workbook.getWorksheet('Chuyên cần')!.getCell('I2').value, 50)
  assert.equal(workbook.getWorksheet('Điểm toàn khóa')!.getCell('E2').value, null)
  assert.equal(workbook.getWorksheet('Điểm toàn khóa')!.getCell('F2').value, 'Chưa đủ điểm')
  assert.equal(workbook.getWorksheet('Chi tiết kỳ thi')!.getCell('E2').value, 0)
  assert.equal(workbook.getWorksheet('Chi tiết kỳ thi')!.getCell('H2').value, null)
  await assert.rejects(() => classAcademicWorkbook(data, 'invalid'))
})

test('liên kết điểm danh chỉ mở buổi đã bắt đầu thuộc giáo viên; giáo vụ vẫn giữ quyền hiện có', async (t) => {
  let classStatus = 'dang_hoc'
  t.mock.method(database, 'getConnection', async () => {
    const own = { id: 1, sessionId: 1, teacherId: 10, startsAt: '2026-01-01 18:00:00', endsAt: '2026-01-01 20:00:00',
      teacherName: 'Giáo viên hiện tại', roomCode: 'P1', hasStarted: 1, status: 'da_len_lich' }
    const previous = { ...own, id: 2, sessionId: 2, teacherId: 20, teacherName: 'Giáo viên trước' }
    const rows = [[{ id: 7, status: classStatus }], [], [], [], [own, previous],
      [own, previous, { ...own, id: 3, hasStarted: 0 }, { ...own, id: 4, status: 'da_huy' }]]
    return { beginTransaction: async () => {}, commit: async () => {}, rollback: async () => {}, release() {},
      query: async () => [rows.shift(), []] } as unknown as PoolConnection
  })
  const teacher = await loadClassAcademic(7, 10)
  assert.deepEqual(teacher.missingAttendance.map((row) => row.canMarkAttendance), [true, false])
  assert.deepEqual(teacher.sessions.map((row) => row.canMarkAttendance), [true, false, false, false])
  const admin = await loadClassAcademic(7)
  assert.deepEqual(admin.missingAttendance.map((row) => row.canMarkAttendance), [true, true])
  assert.deepEqual(admin.sessions.map((row) => row.canMarkAttendance), [true, true, false, false])
  classStatus = 'da_huy'
  assert.equal((await loadClassAcademic(7)).sessions.some((row) => row.canMarkAttendance), false)
})
