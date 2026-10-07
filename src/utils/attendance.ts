// A full-course enrollment keeps one class; canceled sessions never count as attendance obligations.
export const attendanceStatsJoin = `LEFT JOIN (
  SELECT enrollment.id AS enrollmentId, COUNT(session.id) AS expectedAttendance,
    COUNT(mark.id) AS recordedAttendance,
    SUM(CASE WHEN mark.trang_thai IN ('co_mat', 'di_muon') THEN 1 ELSE 0 END) AS presentAttendance
  FROM ghi_danh enrollment
  JOIN buoi_hoc session ON session.lop_hoc_id = enrollment.lop_hoc_id
    AND session.bat_dau <= NOW() AND session.trang_thai <> 'da_huy'
  LEFT JOIN diem_danh mark ON mark.buoi_hoc_id = session.id AND mark.ghi_danh_id = enrollment.id
  GROUP BY enrollment.id
) attendance_stats ON attendance_stats.enrollmentId = gd.id`

export const attendanceCountColumns = `COALESCE(attendance_stats.expectedAttendance, 0) AS expectedAttendance,
  COALESCE(attendance_stats.recordedAttendance, 0) AS recordedAttendance,
  COALESCE(attendance_stats.presentAttendance, 0) AS presentAttendance`

export const attendanceRateSql = `COALESCE(100 * attendance_stats.presentAttendance /
  NULLIF(attendance_stats.expectedAttendance, 0), 0)`
