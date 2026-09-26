import type { RequestHandler } from 'express'
import jwt from 'jsonwebtoken'
import type { RowDataPacket } from 'mysql2'
import { database } from '../config/database'
import { env } from '../config/env'
import { HttpError } from '../utils/http-error'

type VaiTro = 'quan_tri' | 'giao_vien' | 'hoc_vien'
type TokenPayload = jwt.JwtPayload & { sub: string; role: VaiTro; ver: number }
type AuthRow = RowDataPacket & {
  id: number
  vai_tro: VaiTro
  dang_hoat_dong: number
  phien_ban_dang_nhap: number
}

export const requireAuth: RequestHandler = async (request, _response, next) => {
  try {
    const authorization = request.headers.authorization
    if (!authorization?.startsWith('Bearer ')) throw new HttpError(401, 'Bạn chưa đăng nhập')

    const payload = jwt.verify(authorization.slice(7), env.jwtSecret) as TokenPayload
    const userId = Number(payload.sub)
    if (!Number.isInteger(userId)) throw new HttpError(401, 'Phiên đăng nhập không hợp lệ')

    const [rows] = await database.query<AuthRow[]>(
      'SELECT id, vai_tro, dang_hoat_dong, phien_ban_dang_nhap FROM nguoi_dung WHERE id = ? LIMIT 1',
      [userId],
    )
    const user = rows[0]
    if (!user?.dang_hoat_dong || user.phien_ban_dang_nhap !== payload.ver) {
      throw new HttpError(401, 'Phiên đăng nhập đã hết hiệu lực')
    }

    request.auth = {
      userId: user.id,
      role: user.vai_tro,
      sessionVersion: user.phien_ban_dang_nhap,
    }
    next()
  } catch (error) {
    next(error instanceof HttpError ? error : new HttpError(401, 'Phiên đăng nhập không hợp lệ'))
  }
}

export function requireRole(...roles: VaiTro[]): RequestHandler {
  return (request, _response, next) => {
    if (!request.auth || !roles.includes(request.auth.role)) {
      next(new HttpError(403, 'Bạn không có quyền thực hiện chức năng này'))
      return
    }
    next()
  }
}
