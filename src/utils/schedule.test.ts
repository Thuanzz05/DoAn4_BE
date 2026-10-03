import assert from 'node:assert/strict'
import test from 'node:test'
import { canChangeClassPlan, canMarkAttendance, generateSessionDates, roomCanHostClass, shouldSyncTeacherAssignment } from './schedule'

test('sinh đủ buổi theo lịch thứ hai và thứ tư', () => {
  const sessions = generateSessionDates('2026-09-28', 3, [
    { dayOfWeek: 2, startTime: '18:00:00', endTime: '19:30:00', roomId: 1 },
    { dayOfWeek: 4, startTime: '18:00:00', endTime: '19:30:00', roomId: 1 },
  ])
  assert.deepEqual(sessions.map((item) => item.startsAt), [
    '2026-09-28 18:00:00',
    '2026-09-30 18:00:00',
    '2026-10-05 18:00:00',
  ])
})

test('phòng học phải đủ sức chứa tối đa của lớp', () => {
  assert.equal(roomCanHostClass(30, 30), true)
  assert.equal(roomCanHostClass(29, 30), false)
})

test('chỉ điểm danh buổi đã bắt đầu và chưa bị hủy', () => {
  assert.equal(canMarkAttendance('da_len_lich', true), true)
  assert.equal(canMarkAttendance('da_hoc', true), true)
  assert.equal(canMarkAttendance('da_len_lich', false), false)
  assert.equal(canMarkAttendance('da_huy', true), false)
})

test('đổi giáo viên phải đồng bộ các buổi học đã sinh', () => {
  assert.equal(shouldSyncTeacherAssignment(1, 2, 12), true)
  assert.equal(shouldSyncTeacherAssignment(1, 1, 12), false)
  assert.equal(shouldSyncTeacherAssignment(1, 2, 0), false)
  assert.equal(shouldSyncTeacherAssignment(1, null, 12), false)
})

test('không đổi ngày khai giảng hoặc số buổi sau khi đã sinh lịch', () => {
  assert.equal(canChangeClassPlan(0, '2026-10-01', 24, '2026-10-08', 30), true)
  assert.equal(canChangeClassPlan(24, '2026-10-01', 24, '2026-10-01', 24), true)
  assert.equal(canChangeClassPlan(24, '2026-10-01', 24, '2026-10-08', 24), false)
  assert.equal(canChangeClassPlan(24, '2026-10-01', 24, '2026-10-01', 30), false)
})
