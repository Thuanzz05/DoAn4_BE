import { randomInt } from 'node:crypto'
import bcrypt from 'bcryptjs'
import { Router } from 'express'
import type { ResultSetHeader, RowDataPacket } from 'mysql2'
import { database } from '../config/database'
import { env } from '../config/env'
import { requireAuth, requireRole } from '../middlewares/auth'
import { deliverAccountInformation, sendTemporaryPassword } from '../services/mailer'
import { generateTemporaryPassword, isValidBirthDate, isValidPassword } from '../utils/account'
import { HttpError } from '../utils/http-error'

type VaiTro = 'quan_tri' | 'giao_vien' | 'hoc_vien'
type UserRow = RowDataPacket & {
  id: number
  code: string
  fullName: string
  email: string
  phone: string | null
  role: VaiTro
  active: number
  birthDate: string | null
  teachingLanguage: string | null
  specialty: string | null
  createdAt: string
  activeClasses: number
}

export const usersRouter = Router()
usersRouter.use(requireAuth, requireRole('quan_tri'))

const selectUsers = `SELECT n.id, n.ma_nguoi_dung AS code, n.ho_ten AS fullName,
  n.email, n.so_dien_thoai AS phone, n.vai_tro AS role,
  n.dang_hoat_dong AS active, n.ngay_sinh AS birthDate,
  n.ngon_ngu_giang_day AS teachingLanguage, n.chuyen_mon AS specialty,
  n.ngay_tao AS createdAt,
  COUNT(DISTINCT CASE WHEN l.trang_thai IN ('sap_khai_giang', 'dang_hoc') THEN l.id END) AS activeClasses
  FROM nguoi_dung n LEFT JOIN lop_hoc l ON l.giao_vien_id = n.id
    OR EXISTS (SELECT 1 FROM buoi_hoc bh WHERE bh.lop_hoc_id = l.id AND bh.giao_vien_id = n.id
      AND bh.trang_thai = 'da_len_lich' AND bh.bat_dau > NOW())`

function text(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new HttpError(400, `${label} là bắt buộc`)
  return value.trim()
}

function newCode(role: 'giao_vien' | 'hoc_vien'): string {
  return `${role === 'giao_vien' ? 'GV' : 'HV'}-${randomInt(10_000_000, 100_000_000)}`
}

function positiveInt(value: unknown, label: string): number {
  const parsed = Number(value)
  if (!['string', 'number'].includes(typeof value) || !Number.isSafeInteger(parsed) || parsed < 1) throw new HttpError(400, `${label} phải là số nguyên dương`)
  return parsed
}

function birthDate(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null
  if (!isValidBirthDate(value)) throw new HttpError(400, 'Ngày sinh không hợp lệ')
  return value
}

usersRouter.get('/', async (request, response) => {
  const role = request.query.role
  if (role && !['quan_tri', 'giao_vien', 'hoc_vien'].includes(String(role))) {
    throw new HttpError(400, 'Vai trò không hợp lệ')
  }
  const where = role ? ' WHERE n.vai_tro = ?' : ''
  const [rows] = await database.query<UserRow[]>(
    `${selectUsers}${where} GROUP BY n.id ORDER BY n.id DESC`,
    role ? [role] : [],
  )
  response.json({ success: true, data: rows })
})

usersRouter.post('/', async (request, response) => {
  const fullName = text(request.body.fullName, 'Họ tên')
  const email = text(request.body.email, 'Email').toLowerCase()
  const phone = text(request.body.phone, 'Số điện thoại').replace(/\s/g, '')
  const password = request.body.password === undefined || request.body.password === ''
    ? generateTemporaryPassword() : request.body.password
  const role = request.body.role as 'giao_vien' | 'hoc_vien'
  if (!['giao_vien', 'hoc_vien'].includes(role)) throw new HttpError(400, 'Chỉ được tạo giáo viên hoặc học viên')
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new HttpError(400, 'Email không hợp lệ')
  if (!/^0\d{9}$/.test(phone)) throw new HttpError(400, 'Số điện thoại phải gồm 10 chữ số')
  if (!isValidPassword(password)) throw new HttpError(400, 'Mật khẩu phải có ít nhất 8 ký tự')
  const validatedBirthDate = birthDate(request.body.birthDate)
  const passwordHash = await bcrypt.hash(password, 12)
  try {
    const [result] = await database.execute<ResultSetHeader>(
      `INSERT INTO nguoi_dung
       (ma_nguoi_dung, ho_ten, email, so_dien_thoai, mat_khau_bam, vai_tro,
        ngay_sinh, ngon_ngu_giang_day, chuyen_mon)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        newCode(role), fullName, email, phone, passwordHash, role,
        validatedBirthDate,
        role === 'giao_vien' ? request.body.teachingLanguage || null : null,
        role === 'giao_vien' ? request.body.specialty || null : null,
      ],
    )
    const [rows] = await database.query<UserRow[]>(`${selectUsers} WHERE n.id = ? GROUP BY n.id`, [result.insertId])
    const delivery = await deliverAccountInformation(email, fullName, password, role)
    response.status(201).json({ success: true, data: { ...rows[0], ...delivery } })
  } catch (error) {
    if ((error as { code?: string }).code === 'ER_DUP_ENTRY') throw new HttpError(409, 'Email hoặc số điện thoại đã được sử dụng')
    throw error
  }
})

usersRouter.patch('/:id', async (request, response) => {
  const [existing] = await database.query<UserRow[]>(`${selectUsers} WHERE n.id = ? GROUP BY n.id`, [request.params.id])
  const user = existing[0]
  if (!user) throw new HttpError(404, 'Không tìm thấy người dùng')
  const fullName = request.body.fullName === undefined ? user.fullName : text(request.body.fullName, 'Họ tên')
  const email = request.body.email === undefined ? user.email : text(request.body.email, 'Email').toLowerCase()
  const phone = request.body.phone === undefined ? user.phone : text(request.body.phone, 'Số điện thoại').replace(/\s/g, '')
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new HttpError(400, 'Email không hợp lệ')
  if (phone && !/^0\d{9}$/.test(phone)) throw new HttpError(400, 'Số điện thoại phải gồm 10 chữ số')
  const validatedBirthDate = request.body.birthDate === undefined ? user.birthDate : birthDate(request.body.birthDate)
  try {
    await database.execute(
      `UPDATE nguoi_dung SET ho_ten = ?, email = ?, so_dien_thoai = ?, ngay_sinh = ?,
       ngon_ngu_giang_day = ?, chuyen_mon = ? WHERE id = ?`,
      [
        fullName, email, phone, validatedBirthDate,
        user.role === 'giao_vien' ? request.body.teachingLanguage ?? user.teachingLanguage : null,
        user.role === 'giao_vien' ? request.body.specialty ?? user.specialty : null,
        user.id,
      ],
    )
  } catch (error) {
    if ((error as { code?: string }).code === 'ER_DUP_ENTRY') throw new HttpError(409, 'Email hoặc số điện thoại đã được sử dụng')
    throw error
  }
  const [updated] = await database.query<UserRow[]>(`${selectUsers} WHERE n.id = ? GROUP BY n.id`, [user.id])
  response.json({ success: true, data: updated[0] })
})

usersRouter.patch('/:id/status', async (request, response) => {
  const active = request.body.active
  if (typeof active !== 'boolean') throw new HttpError(400, 'active phải là true hoặc false')
  const userId = positiveInt(request.params.id, 'Người dùng')
  if (userId === request.auth!.userId && !active) throw new HttpError(400, 'Không thể tự khóa tài khoản đang đăng nhập')
  const connection = await database.getConnection()
  try {
    await connection.beginTransaction()
    // ponytail: cùng khóa toàn trung tâm như xếp lịch; chuyển sang khóa từng lớp khi lưu lượng cập nhật tài khoản lớn.
    await connection.query('SELECT id FROM lop_hoc ORDER BY id FOR UPDATE')
    await connection.query('SELECT id FROM nguoi_dung WHERE id = ? FOR UPDATE', [userId])
    const [rows] = await connection.query<UserRow[]>(`${selectUsers} WHERE n.id = ? GROUP BY n.id`, [userId])
    const user = rows[0]
    if (!user) throw new HttpError(404, 'Không tìm thấy người dùng')
    if (!active && user.role === 'giao_vien') {
      const [backlog] = await connection.query<RowDataPacket[]>(
        `SELECT COUNT(*) AS total FROM buoi_hoc bh JOIN lop_hoc l ON l.id = bh.lop_hoc_id
         WHERE bh.giao_vien_id = ? AND bh.bat_dau <= NOW() AND bh.trang_thai <> 'da_huy' AND l.trang_thai <> 'da_huy'
           AND EXISTS(SELECT 1 FROM ghi_danh gd WHERE gd.lop_hoc_id = bh.lop_hoc_id
             AND gd.trang_thai IN ('dang_hoc', 'hoan_thanh')
             AND NOT EXISTS(SELECT 1 FROM diem_danh dd WHERE dd.buoi_hoc_id = bh.id AND dd.ghi_danh_id = gd.id))`, [userId],
      )
      if (Number(backlog[0].total)) throw new HttpError(409,
        `Giáo viên còn ${backlog[0].total} buổi thiếu điểm danh. Mở Quản lý lớp, tab Buổi học để bổ sung hoặc xử lý buổi nghỉ trước khi khóa tài khoản.`, 'ATTENDANCE_BACKLOG')
      if (user.activeClasses > 0 && request.query.force !== 'true') {
        throw new HttpError(409, `Giáo viên đang phụ trách ${user.activeClasses} lớp. Gửi force=true để xác nhận khóa.`)
      }
    }
    await connection.execute(
      `UPDATE nguoi_dung SET dang_hoat_dong = ?,
       phien_ban_dang_nhap = phien_ban_dang_nhap + IF(? = FALSE, 1, 0) WHERE id = ?`,
      [active, active, userId],
    )
    await connection.commit()
    response.json({ success: true, message: active ? 'Đã mở khóa tài khoản' : 'Đã khóa tài khoản' })
  } catch (error) { await connection.rollback(); throw error }
  finally { connection.release() }
})

usersRouter.post('/:id/reset-password', async (request, response) => {
  const userId = positiveInt(request.params.id, 'Người dùng')
  if (userId === request.auth!.userId) throw new HttpError(400, 'Hãy dùng chức năng đổi mật khẩu cho tài khoản của bạn')
  const [rows] = await database.query<UserRow[]>(`${selectUsers} WHERE n.id = ? GROUP BY n.id`, [userId])
  const user = rows[0]
  if (!user) throw new HttpError(404, 'Không tìm thấy người dùng')
  if (user.role === 'quan_tri') throw new HttpError(403, 'Không được đặt lại mật khẩu của quản trị viên khác')
  const temporaryPassword = generateTemporaryPassword()
  const passwordHash = await bcrypt.hash(temporaryPassword, 12)
  const connection = await database.getConnection()
  try {
    await connection.beginTransaction()
    await connection.execute(
      `UPDATE nguoi_dung SET mat_khau_bam = ?, phien_ban_dang_nhap = phien_ban_dang_nhap + 1
       WHERE id = ?`,
      [passwordHash, userId],
    )
    await connection.execute(
      'UPDATE ma_dat_lai_mat_khau SET da_dung_luc = NOW() WHERE nguoi_dung_id = ? AND da_dung_luc IS NULL',
      [userId],
    )
    const emailSent = await sendTemporaryPassword(user.email, user.fullName, temporaryPassword)
    if (!emailSent && env.nodeEnv === 'production') throw new HttpError(503, 'Dịch vụ gửi email chưa được cấu hình')
    await connection.commit()
    response.json({
      success: true,
      message: 'Đã đặt lại mật khẩu và vô hiệu hóa các phiên đăng nhập cũ',
      data: {
        emailSent,
        ...(!emailSent && env.nodeEnv !== 'production' ? { devTemporaryPassword: temporaryPassword } : {}),
      },
    })
  } catch (error) {
    await connection.rollback()
    throw error
  } finally {
    connection.release()
  }
})

usersRouter.delete('/:id', async (request, response) => {
  const userId = positiveInt(request.params.id, 'Người dùng')
  if (userId === request.auth!.userId) throw new HttpError(400, 'Không thể tự xóa tài khoản đang đăng nhập')
  const [rows] = await database.query<UserRow[]>(`${selectUsers} WHERE n.id = ? GROUP BY n.id`, [userId])
  const user = rows[0]
  if (!user) throw new HttpError(404, 'Không tìm thấy người dùng')
  if (user.role === 'quan_tri') throw new HttpError(403, 'Không được xóa tài khoản quản trị viên')
  const connection = await database.getConnection()
  try {
    await connection.beginTransaction()
    await connection.execute('DELETE FROM ma_dat_lai_mat_khau WHERE nguoi_dung_id = ?', [userId])
    await connection.execute('DELETE FROM thong_bao WHERE nguoi_dung_id = ?', [userId])
    await connection.execute('DELETE FROM nguoi_dung WHERE id = ?', [userId])
    await connection.commit()
    response.status(204).send()
  } catch (error) {
    await connection.rollback()
    if ((error as { code?: string }).code === 'ER_ROW_IS_REFERENCED_2') {
      throw new HttpError(409, 'Không thể xóa tài khoản đang có dữ liệu học tập hoặc giảng dạy')
    }
    throw error
  } finally {
    connection.release()
  }
})
