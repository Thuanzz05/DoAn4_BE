import assert from 'node:assert/strict'
import test from 'node:test'
import ExcelJS from 'exceljs'
import { classAcademicWorkbook, type ClassAcademic } from './class-academic'

test('Excel học vụ giữ số 0, điểm trống, dấu phẩy/xuống dòng và thiếu điểm danh riêng', async () => {
  const data: ClassAcademic = {
    class: { id: 1, code: 'A1', name: 'Lớp A1', courseName: 'Tiếng Anh', language: 'Tiếng Anh', startDate: '2026-01-01',
      sessions: 2, capacity: 30, status: 'dang_hoc', teacherName: 'Giáo viên', enrolled: 1, certificateLocked: false },
    exams: [{ id: 1, classId: 1, classCode: 'A1', className: 'Lớp A1', name: 'Thi 1', examDate: null, deadline: null,
      deadlinePassed: false, certificateLocked: false, resultsCount: 1, completedResults: 0 }],
    students: [{ enrollmentId: 1, studentId: 1, studentCode: 'HV01', studentName: 'Nguyễn, "An"\nBình', email: 'test@example.test',
      enrollmentStatus: 'dang_hoc', status: 'dang_hoc', certificateId: null, paid: false, eligible: false, eligibilityReason: 'Chưa hoàn tất học phí',
      expectedAttendance: 2, recordedAttendance: 1, presentAttendance: 1, onTimeAttendance: 0, lateAttendance: 1,
      absentAttendance: 0, missingAttendance: 1, attendanceRate: 50, requiredExams: 1, completedExams: 0, average: null,
      examResults: [{ examId: 1, listening: 0, speaking: 0, reading: 0, writing: null, average: null }] }],
    sessions: [], missingAttendance: [{ sessionId: 2, startsAt: '2026-01-02 18:00:00', endsAt: '2026-01-02 19:00:00',
      teacherName: 'Giáo viên', roomCode: 'P1', enrollmentId: 1, studentCode: 'HV01', studentName: 'Nguyễn, "An"\nBình' }],
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
