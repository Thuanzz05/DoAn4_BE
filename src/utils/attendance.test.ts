import assert from 'node:assert/strict'
import test from 'node:test'
import { attendanceCountColumns, attendanceRateSql, attendanceStatsJoin } from './attendance'

test('chuyên cần tính theo buổi đã diễn ra kể cả thiếu điểm danh, không làm tròn ngưỡng duyệt', () => {
  assert.match(attendanceStatsJoin, /COUNT\(session.id\) AS expectedAttendance/)
  assert.match(attendanceStatsJoin, /LEFT JOIN diem_danh/)
  assert.match(attendanceStatsJoin, /session.bat_dau <= NOW\(\)/)
  assert.match(attendanceStatsJoin, /session.trang_thai <> 'da_huy'/)
  assert.match(attendanceStatsJoin, /mark.ghi_danh_id = enrollment.id/)
  assert.match(attendanceCountColumns, /recordedAttendance/)
  assert.match(attendanceRateSql, /NULLIF\(attendance_stats.expectedAttendance, 0\)/)
  assert.doesNotMatch(attendanceRateSql, /ROUND/)
  assert.ok(100 * 35 / 44 < 80)
})
