import type { Pool, PoolConnection, RowDataPacket } from 'mysql2/promise'
import { HttpError } from './http-error'

export type EnrollmentStatus = 'cho_xep_lop' | 'dang_hoc' | 'bao_luu' | 'hoan_thanh' | 'da_huy'

const transitions: Record<EnrollmentStatus, EnrollmentStatus[]> = {
  cho_xep_lop: ['dang_hoc', 'bao_luu', 'da_huy'],
  dang_hoc: ['bao_luu', 'da_huy'],
  bao_luu: ['cho_xep_lop', 'dang_hoc', 'da_huy'],
  hoan_thanh: [],
  da_huy: [],
}

export const canChangeEnrollmentStatus = (current: EnrollmentStatus, next: EnrollmentStatus) => current === next || transitions[current].includes(next)

export const canJoinClass = (status: string, hasStarted: boolean, resumeExistingClass = false) => ['sap_khai_giang', 'dang_hoc'].includes(status)
  && (!hasStarted || resumeExistingClass && status === 'dang_hoc')

export async function ensureEnrollmentClass(
  connection: Pool | PoolConnection,
  classId: number,
  courseId: number,
  seats = 1,
  ignoreEnrollmentId = 0,
  lock = true,
  resumeExistingClass = false,
  studentId = 0,
): Promise<void> {
  const [classes] = await connection.query<RowDataPacket[]>(
    `SELECT khoa_hoc_id AS courseId, si_so_toi_da AS capacity, trang_thai AS status
     FROM lop_hoc WHERE id = ?${lock ? ' FOR UPDATE' : ''}`, [classId],
  )
  const item = classes[0]
  if (!item || Number(item.courseId) !== courseId) throw new HttpError(400, 'Lớp không thuộc khóa học đã chọn')
  const [state] = await connection.query<RowDataPacket[]>(
    `SELECT EXISTS(SELECT 1 FROM buoi_hoc WHERE lop_hoc_id = ? AND trang_thai <> 'da_huy' AND bat_dau <= NOW()) AS hasStarted,
       (SELECT COUNT(*) FROM ghi_danh WHERE lop_hoc_id = ? AND trang_thai IN ('dang_hoc', 'hoan_thanh') AND id <> ?) AS enrolled`,
    [classId, classId, ignoreEnrollmentId],
  )
  if (!canJoinClass(String(item.status), Boolean(Number(state[0].hasStarted)), resumeExistingClass)) {
    throw new HttpError(409, 'Chỉ được xếp lớp trước khi buổi học đầu tiên bắt đầu')
  }
  const available = Number(item.capacity) - Number(state[0].enrolled)
  if (seats > available) throw new HttpError(409, `Lớp chỉ còn ${available} chỗ trống`)
  if (studentId) {
    const [conflicts] = await connection.query<RowDataPacket[]>(
      `SELECT other.ten_lop AS className FROM ghi_danh gd JOIN lop_hoc other ON other.id = gd.lop_hoc_id
       WHERE gd.hoc_vien_id = ? AND gd.id <> ? AND gd.lop_hoc_id <> ? AND gd.trang_thai = 'dang_hoc'
         AND other.trang_thai IN ('sap_khai_giang', 'dang_hoc') AND (
         EXISTS(SELECT 1 FROM buoi_hoc target JOIN buoi_hoc busy
           ON target.bat_dau < busy.ket_thuc AND target.ket_thuc > busy.bat_dau
           WHERE target.lop_hoc_id = ? AND busy.lop_hoc_id = other.id
             AND target.trang_thai <> 'da_huy' AND busy.trang_thai <> 'da_huy' AND target.bat_dau > NOW())
         OR EXISTS(SELECT 1 FROM lich_hang_tuan target JOIN lich_hang_tuan busy
           ON target.thu_trong_tuan = busy.thu_trong_tuan AND target.gio_bat_dau < busy.gio_ket_thuc AND target.gio_ket_thuc > busy.gio_bat_dau
           WHERE target.lop_hoc_id = ? AND busy.lop_hoc_id = other.id)) LIMIT 1`,
      [studentId, ignoreEnrollmentId, classId, classId, classId],
    )
    if (conflicts[0]) throw new HttpError(409, `Học viên bị trùng lịch với lớp ${conflicts[0].className}`)
  }
}
