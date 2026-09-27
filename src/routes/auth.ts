import { createHmac, randomInt, timingSafeEqual } from 'node:crypto'
import bcrypt from 'bcryptjs'
import { Router } from 'express'
import { rateLimit } from 'express-rate-limit'
import { OAuth2Client } from 'google-auth-library'
import jwt from 'jsonwebtoken'
import type { ResultSetHeader, RowDataPacket } from 'mysql2'
import { database } from '../config/database'
import { env } from '../config/env'
import { requireAuth } from '../middlewares/auth'
import { sendPasswordResetCode } from '../services/mailer'
import { isValidBirthDate, isValidPassword } from '../utils/account'
import { HttpError } from '../utils/http-error'

type VaiTro = 'quan_tri' | 'giao_vien' | 'hoc_vien'
type UserRow = RowDataPacket & {
  id: number
  ma_nguoi_dung: string
  ho_ten: string
  email: string
  so_dien_thoai: string | null
  mat_khau_bam: string | null
  google_sub: string | null
  vai_tro: VaiTro
  dang_hoat_dong: number
  phien_ban_dang_nhap: number
  ngay_sinh: string | null
  ngon_ngu_giang_day: string | null
  chuyen_mon: string | null
}
type ResetRow = RowDataPacket & {
  id: number
  nguoi_dung_id: number
  ma_hmac: string
  so_lan_nhap_sai: number
}

export const authRouter = Router()
const googleClient = new OAuth2Client()
const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const phonePattern = /^0\d{9}$/
const genericResetMessage = 'Nếu email tồn tại, hệ thống đã gửi mã đặt lại mật khẩu.'

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Bạn thao tác quá nhanh, vui lòng thử lại sau.' },
})
const resetLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Bạn đã yêu cầu quá nhiều mã, vui lòng thử lại sau.' },
})

function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new HttpError(400, `${label} là bắt buộc`)
  return value.trim()
}

function publicUser(user: UserRow) {
  return {
    id: user.id,
    code: user.ma_nguoi_dung,
    fullName: user.ho_ten,
    email: user.email,
    phone: user.so_dien_thoai,
    role: user.vai_tro,
    hasGoogle: Boolean(user.google_sub),
    hasPassword: Boolean(user.mat_khau_bam),
    birthDate: user.ngay_sinh,
    teachingLanguage: user.ngon_ngu_giang_day,
    specialty: user.chuyen_mon,
  }
}

function issueToken(user: UserRow): string {
  return jwt.sign(
    { role: user.vai_tro, ver: user.phien_ban_dang_nhap },
    env.jwtSecret,
    { subject: String(user.id), expiresIn: '7d' },
  )
}

function studentCode(): string {
  return `HV-${randomInt(10_000_000, 100_000_000)}`
}

function otpHmac(userId: number, code: string): string {
  return createHmac('sha256', env.otpSecret).update(`${userId}:${code}`).digest('hex')
}

async function verifyGoogleCredential(credential: unknown) {
  if (!env.googleClientId) throw new HttpError(503, 'Đăng nhập Google chưa được cấu hình')
  const token = requiredString(credential, 'Google credential')
  try {
    const ticket = await googleClient.verifyIdToken({ idToken: token, audience: env.googleClientId })
    const payload = ticket.getPayload()
    if (!payload?.sub || !payload.email || !payload.email_verified) {
      throw new HttpError(401, 'Tài khoản Google không hợp lệ hoặc email chưa xác minh')
    }
    return { sub: payload.sub, email: payload.email.toLowerCase(), name: payload.name?.trim() || 'Học viên' }
  } catch (error) {
    if (error instanceof HttpError) throw error
    throw new HttpError(401, 'Google credential không hợp lệ hoặc đã hết hạn')
  }
}

authRouter.post('/register', authLimiter, async (request, response) => {
  const fullName = requiredString(request.body.fullName, 'Họ tên')
  const email = requiredString(request.body.email, 'Email').toLowerCase()
  const phone = requiredString(request.body.phone, 'Số điện thoại').replace(/\s/g, '')
  const password = requiredString(request.body.password, 'Mật khẩu')
  const birthDate = request.body.birthDate || null

  if (!emailPattern.test(email)) throw new HttpError(400, 'Email không hợp lệ')
  if (!phonePattern.test(phone)) throw new HttpError(400, 'Số điện thoại phải gồm 10 chữ số')
  if (!isValidPassword(password)) throw new HttpError(400, 'Mật khẩu phải có ít nhất 8 ký tự')
  if (birthDate !== null && !isValidBirthDate(birthDate)) {
    throw new HttpError(400, 'Ngày sinh không hợp lệ')
  }

  const passwordHash = await bcrypt.hash(password, 12)
  try {
    const [result] = await database.execute<ResultSetHeader>(
      `INSERT INTO nguoi_dung
        (ma_nguoi_dung, ho_ten, email, so_dien_thoai, mat_khau_bam, vai_tro, ngay_sinh)
       VALUES (?, ?, ?, ?, ?, 'hoc_vien', ?)`,
      [studentCode(), fullName, email, phone, passwordHash, birthDate],
    )
    const [rows] = await database.query<UserRow[]>('SELECT * FROM nguoi_dung WHERE id = ?', [result.insertId])
    const user = rows[0]
    response.status(201).json({ success: true, data: { token: issueToken(user), user: publicUser(user) } })
  } catch (error) {
    if ((error as { code?: string }).code === 'ER_DUP_ENTRY') {
      throw new HttpError(409, 'Email hoặc số điện thoại đã được sử dụng')
    }
    throw error
  }
})

authRouter.post('/login', authLimiter, async (request, response) => {
  const account = requiredString(request.body.account ?? request.body.username, 'Email hoặc mã người dùng')
  const password = requiredString(request.body.password, 'Mật khẩu')
  const [rows] = await database.query<UserRow[]>(
    'SELECT * FROM nguoi_dung WHERE email = ? OR ma_nguoi_dung = ? LIMIT 1',
    [account.toLowerCase(), account],
  )
  const user = rows[0]
  const valid = user?.mat_khau_bam ? await bcrypt.compare(password, user.mat_khau_bam) : false
  if (!user || !valid) throw new HttpError(401, 'Thông tin đăng nhập không chính xác')
  if (!user.dang_hoat_dong) throw new HttpError(403, 'Tài khoản đã bị khóa')
  response.json({ success: true, data: { token: issueToken(user), user: publicUser(user) } })
})

authRouter.post('/google', authLimiter, async (request, response) => {
  const google = await verifyGoogleCredential(request.body.credential)
  const [googleRows] = await database.query<UserRow[]>('SELECT * FROM nguoi_dung WHERE google_sub = ? LIMIT 1', [google.sub])
  let user = googleRows[0]

  if (!user) {
    const [emailRows] = await database.query<UserRow[]>('SELECT * FROM nguoi_dung WHERE email = ? LIMIT 1', [google.email])
    if (emailRows[0]) {
      throw new HttpError(409, 'Email đã có tài khoản. Hãy đăng nhập bằng mật khẩu rồi liên kết Google.', 'CAN_LIEN_KET_GOOGLE')
    }
    const [result] = await database.execute<ResultSetHeader>(
      `INSERT INTO nguoi_dung (ma_nguoi_dung, ho_ten, email, google_sub, vai_tro)
       VALUES (?, ?, ?, ?, 'hoc_vien')`,
      [studentCode(), google.name, google.email, google.sub],
    )
    const [createdRows] = await database.query<UserRow[]>('SELECT * FROM nguoi_dung WHERE id = ?', [result.insertId])
    user = createdRows[0]
  }

  if (!user.dang_hoat_dong) throw new HttpError(403, 'Tài khoản đã bị khóa')
  response.json({ success: true, data: { token: issueToken(user), user: publicUser(user) } })
})

authRouter.post('/google/link', requireAuth, async (request, response) => {
  const google = await verifyGoogleCredential(request.body.credential)
  const [rows] = await database.query<UserRow[]>('SELECT * FROM nguoi_dung WHERE id = ?', [request.auth!.userId])
  const user = rows[0]
  if (user.email.toLowerCase() !== google.email) throw new HttpError(400, 'Email Google phải trùng với email tài khoản')
  try {
    await database.execute('UPDATE nguoi_dung SET google_sub = ? WHERE id = ?', [google.sub, user.id])
  } catch (error) {
    if ((error as { code?: string }).code === 'ER_DUP_ENTRY') throw new HttpError(409, 'Tài khoản Google đã liên kết với người dùng khác')
    throw error
  }
  response.json({ success: true, message: 'Đã liên kết tài khoản Google' })
})

authRouter.post('/forgot-password', resetLimiter, async (request, response) => {
  const email = typeof request.body.email === 'string' ? request.body.email.trim().toLowerCase() : ''
  if (!emailPattern.test(email)) throw new HttpError(400, 'Email không hợp lệ')
  const [rows] = await database.query<UserRow[]>('SELECT * FROM nguoi_dung WHERE email = ? LIMIT 1', [email])
  const user = rows[0]
  if (!user) {
    response.json({ success: true, message: genericResetMessage })
    return
  }

  const code = String(randomInt(0, 1_000_000)).padStart(6, '0')
  await database.execute(
    'UPDATE ma_dat_lai_mat_khau SET da_dung_luc = NOW() WHERE nguoi_dung_id = ? AND da_dung_luc IS NULL',
    [user.id],
  )
  await database.execute(
    `INSERT INTO ma_dat_lai_mat_khau (nguoi_dung_id, ma_hmac, het_han_luc)
     VALUES (?, ?, DATE_ADD(NOW(), INTERVAL 10 MINUTE))`,
    [user.id, otpHmac(user.id, code)],
  )
  const sent = await sendPasswordResetCode(user.email, user.ho_ten, code)
  if (!sent && env.nodeEnv === 'production') throw new HttpError(503, 'Dịch vụ gửi email chưa được cấu hình')

  response.json({
    success: true,
    message: genericResetMessage,
    ...(!sent && env.nodeEnv !== 'production' ? { devCode: code } : {}),
  })
})

authRouter.post('/reset-password', resetLimiter, async (request, response) => {
  const email = requiredString(request.body.email, 'Email').toLowerCase()
  const code = requiredString(request.body.code, 'Mã xác nhận')
  const newPassword = requiredString(request.body.newPassword, 'Mật khẩu mới')
  if (!/^\d{6}$/.test(code)) throw new HttpError(400, 'Mã xác nhận phải gồm 6 chữ số')
  if (!isValidPassword(newPassword)) throw new HttpError(400, 'Mật khẩu phải có ít nhất 8 ký tự')

  const [rows] = await database.query<ResetRow[]>(
    `SELECT m.id, m.nguoi_dung_id, m.ma_hmac, m.so_lan_nhap_sai
     FROM ma_dat_lai_mat_khau m
     JOIN nguoi_dung n ON n.id = m.nguoi_dung_id
     WHERE n.email = ? AND m.da_dung_luc IS NULL AND m.het_han_luc > NOW()
     ORDER BY m.id DESC LIMIT 1`,
    [email],
  )
  const reset = rows[0]
  if (!reset || reset.so_lan_nhap_sai >= 5) throw new HttpError(400, 'Mã xác nhận không hợp lệ hoặc đã hết hạn')
  const expected = Buffer.from(reset.ma_hmac, 'hex')
  const actual = Buffer.from(otpHmac(reset.nguoi_dung_id, code), 'hex')
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    await database.execute(
      `UPDATE ma_dat_lai_mat_khau
       SET so_lan_nhap_sai = so_lan_nhap_sai + 1,
           da_dung_luc = IF(so_lan_nhap_sai + 1 >= 5, NOW(), da_dung_luc)
       WHERE id = ?`,
      [reset.id],
    )
    throw new HttpError(400, 'Mã xác nhận không hợp lệ hoặc đã hết hạn')
  }

  const connection = await database.getConnection()
  try {
    await connection.beginTransaction()
    const passwordHash = await bcrypt.hash(newPassword, 12)
    await connection.execute(
      'UPDATE nguoi_dung SET mat_khau_bam = ?, phien_ban_dang_nhap = phien_ban_dang_nhap + 1 WHERE id = ?',
      [passwordHash, reset.nguoi_dung_id],
    )
    await connection.execute('UPDATE ma_dat_lai_mat_khau SET da_dung_luc = NOW() WHERE id = ?', [reset.id])
    await connection.commit()
  } catch (error) {
    await connection.rollback()
    throw error
  } finally {
    connection.release()
  }
  response.json({ success: true, message: 'Đặt lại mật khẩu thành công. Vui lòng đăng nhập lại.' })
})

authRouter.get('/me', requireAuth, async (request, response) => {
  const [rows] = await database.query<UserRow[]>('SELECT * FROM nguoi_dung WHERE id = ?', [request.auth!.userId])
  response.json({ success: true, data: publicUser(rows[0]) })
})

authRouter.patch('/me', requireAuth, async (request, response) => {
  const [rows] = await database.query<UserRow[]>('SELECT * FROM nguoi_dung WHERE id = ?', [request.auth!.userId])
  const user = rows[0]
  const fullName = request.body.fullName === undefined ? user.ho_ten : requiredString(request.body.fullName, 'Họ tên')
  const phone = request.body.phone === undefined ? user.so_dien_thoai : requiredString(request.body.phone, 'Số điện thoại').replace(/\s/g, '')
  const birthDate = request.body.birthDate === undefined ? user.ngay_sinh : request.body.birthDate || null
  if (phone && !phonePattern.test(phone)) throw new HttpError(400, 'Số điện thoại phải gồm 10 chữ số')
  if (birthDate !== null && !isValidBirthDate(birthDate)) throw new HttpError(400, 'Ngày sinh không hợp lệ')
  try {
    await database.execute(
      'UPDATE nguoi_dung SET ho_ten = ?, so_dien_thoai = ?, ngay_sinh = ? WHERE id = ?',
      [fullName, phone, birthDate, user.id],
    )
  } catch (error) {
    if ((error as { code?: string }).code === 'ER_DUP_ENTRY') throw new HttpError(409, 'Số điện thoại đã được sử dụng')
    throw error
  }
  const [updated] = await database.query<UserRow[]>('SELECT * FROM nguoi_dung WHERE id = ?', [user.id])
  response.json({ success: true, data: publicUser(updated[0]) })
})

authRouter.patch('/password', requireAuth, async (request, response) => {
  const currentPassword = typeof request.body.currentPassword === 'string' ? request.body.currentPassword : ''
  const newPassword = request.body.newPassword
  if (!isValidPassword(newPassword)) throw new HttpError(400, 'Mật khẩu mới phải có ít nhất 8 ký tự')
  const [rows] = await database.query<UserRow[]>('SELECT * FROM nguoi_dung WHERE id = ?', [request.auth!.userId])
  const user = rows[0]
  if (user.mat_khau_bam && !await bcrypt.compare(currentPassword, user.mat_khau_bam)) {
    throw new HttpError(401, 'Mật khẩu hiện tại không chính xác')
  }
  if (user.mat_khau_bam && await bcrypt.compare(newPassword, user.mat_khau_bam)) {
    throw new HttpError(400, 'Mật khẩu mới phải khác mật khẩu hiện tại')
  }
  const passwordHash = await bcrypt.hash(newPassword, 12)
  await database.execute(
    'UPDATE nguoi_dung SET mat_khau_bam = ?, phien_ban_dang_nhap = phien_ban_dang_nhap + 1 WHERE id = ?',
    [passwordHash, user.id],
  )
  response.json({ success: true, message: 'Đã đổi mật khẩu. Vui lòng đăng nhập lại.' })
})

authRouter.post('/logout', requireAuth, async (request, response) => {
  await database.execute(
    'UPDATE nguoi_dung SET phien_ban_dang_nhap = phien_ban_dang_nhap + 1 WHERE id = ?',
    [request.auth!.userId],
  )
  response.json({ success: true, message: 'Đã đăng xuất' })
})

authRouter.delete('/google/link', requireAuth, async (request, response) => {
  const [rows] = await database.query<UserRow[]>('SELECT * FROM nguoi_dung WHERE id = ?', [request.auth!.userId])
  const user = rows[0]
  if (!user.google_sub) throw new HttpError(409, 'Tài khoản chưa liên kết Google')
  if (!user.mat_khau_bam) throw new HttpError(409, 'Hãy đặt mật khẩu trước khi gỡ liên kết Google')
  await database.execute('UPDATE nguoi_dung SET google_sub = NULL WHERE id = ?', [user.id])
  response.json({ success: true, message: 'Đã gỡ liên kết tài khoản Google' })
})
