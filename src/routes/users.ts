import { randomInt } from 'node:crypto'
import bcrypt from 'bcryptjs'
import { Router } from 'express'
import type { ResultSetHeader, RowDataPacket } from 'mysql2'
import { database } from '../config/database'
import { requireAuth, requireRole } from '../middlewares/auth'
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
  FROM nguoi_dung n LEFT JOIN lop_hoc l ON l.giao_vien_id = n.id`

function text(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new HttpError(400, `${label} là bắt buộc`)
  return value.trim()
}

function newCode(role: 'giao_vien' | 'hoc_vien'): string {
  return `${role === 'giao_vien' ? 'GV' : 'HV'}-${randomInt(10_000_000, 100_000_000)}`
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
  const password = text(request.body.password, 'Mật khẩu')
  const role = request.body.role as 'giao_vien' | 'hoc_vien'
  if (!['giao_vien', 'hoc_vien'].includes(role)) throw new HttpError(400, 'Chỉ được tạo giáo viên hoặc học viên')
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new HttpError(400, 'Email không hợp lệ')
  if (!/^0\d{9}$/.test(phone)) throw new HttpError(400, 'Số điện thoại phải gồm 10 chữ số')
  if (password.length < 8) throw new HttpError(400, 'Mật khẩu phải có ít nhất 8 ký tự')
  const passwordHash = await bcrypt.hash(password, 12)
  try {
    const [result] = await database.execute<ResultSetHeader>(
      `INSERT INTO nguoi_dung
       (ma_nguoi_dung, ho_ten, email, so_dien_thoai, mat_khau_bam, vai_tro,
        ngay_sinh, ngon_ngu_giang_day, chuyen_mon)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        newCode(role), fullName, email, phone, passwordHash, role,
        request.body.birthDate || null,
        role === 'giao_vien' ? request.body.teachingLanguage || null : null,
        role === 'giao_vien' ? request.body.specialty || null : null,
      ],
    )
    const [rows] = await database.query<UserRow[]>(`${selectUsers} WHERE n.id = ? GROUP BY n.id`, [result.insertId])
    response.status(201).json({ success: true, data: rows[0] })
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
  try {
    await database.execute(
      `UPDATE nguoi_dung SET ho_ten = ?, email = ?, so_dien_thoai = ?, ngay_sinh = ?,
       ngon_ngu_giang_day = ?, chuyen_mon = ? WHERE id = ?`,
      [
        fullName, email, phone, request.body.birthDate ?? user.birthDate,
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
  const userId = Number(request.params.id)
  if (userId === request.auth!.userId && !active) throw new HttpError(400, 'Không thể tự khóa tài khoản đang đăng nhập')
  const [rows] = await database.query<UserRow[]>(`${selectUsers} WHERE n.id = ? GROUP BY n.id`, [userId])
  const user = rows[0]
  if (!user) throw new HttpError(404, 'Không tìm thấy người dùng')
  if (!active && user.role === 'giao_vien' && user.activeClasses > 0 && request.query.force !== 'true') {
    throw new HttpError(409, `Giáo viên đang phụ trách ${user.activeClasses} lớp. Gửi force=true để xác nhận khóa.`)
  }
  await database.execute(
    `UPDATE nguoi_dung SET dang_hoat_dong = ?,
     phien_ban_dang_nhap = phien_ban_dang_nhap + IF(? = FALSE, 1, 0) WHERE id = ?`,
    [active, active, userId],
  )
  response.json({ success: true, message: active ? 'Đã mở khóa tài khoản' : 'Đã khóa tài khoản' })
})
