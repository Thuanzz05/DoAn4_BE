import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import test from 'node:test'
import bcrypt from 'bcryptjs'
import type { Request, RequestHandler, Response, Router } from 'express'
import nodemailer from 'nodemailer'
import { database } from '../config/database'
import { env } from '../config/env'
import { HttpError } from '../utils/http-error'

async function invoke(router: Router, path: string, body: Record<string, unknown>, method = 'post') {
  const layer = router.stack.find((item) => item.route?.path === path && item.route.stack.some((entry) => entry.method === method))
  assert.ok(layer?.route)
  const routeHandler = layer.route.stack.at(-1)
  assert.ok(routeHandler)
  const handler = routeHandler.handle as RequestHandler
  let status = 200
  let payload: unknown
  const response = {
    status(code: number) { status = code; return this },
    json(value: unknown) { payload = value },
  }
  await handler({ body, auth: { userId: 1 } } as Request, response as Response, () => {})
  return { status, payload }
}

test('mật khẩu giữ nguyên khoảng trắng khi tạo/đổi/đăng nhập; sai mật khẩu hiện tại không hết phiên', async (context) => {
  context.mock.method(nodemailer, 'createTransport', () => ({ sendMail: async () => ({ accepted: [] }) }))
  const { authRouter } = await import('./auth')
  const { usersRouter } = await import('./users')
  const user = { id: 1, ma_nguoi_dung: 'HV-TEST', ho_ten: 'Học viên thử', email: 'test@example.test',
    so_dien_thoai: '0900000001', mat_khau_bam: '', vai_tro: 'hoc_vien', dang_hoat_dong: 1, phien_ban_dang_nhap: 0 }
  context.mock.method(database, 'query', (async () => [[user], []]) as typeof database.query)
  context.mock.method(database, 'execute', (async (sql: string, values: unknown[]) => {
    user.mat_khau_bam = String(values[sql.startsWith('INSERT') ? 4 : 0])
    return [{ insertId: 1, affectedRows: 1 }, []]
  }) as unknown as typeof database.execute)

  const password = '  Register-password-123  '
  assert.equal((await invoke(authRouter, '/register', { fullName: user.ho_ten, email: user.email,
    phone: user.so_dien_thoai, password })).status, 201)
  assert.equal(await bcrypt.compare(password, user.mat_khau_bam), true)
  assert.equal((await invoke(authRouter, '/login', { account: user.email, password })).status, 200)
  await assert.rejects(invoke(authRouter, '/login', { account: user.email, password: password.trim() }),
    (error: unknown) => error instanceof HttpError && error.status === 401)
  await assert.rejects(invoke(authRouter, '/password', { currentPassword: 'wrong-password', newPassword: 'New-password-123' }, 'patch'),
    (error: unknown) => error instanceof HttpError && error.status === 400)

  const newPassword = '  Changed-password-123  '
  await invoke(authRouter, '/password', { currentPassword: password, newPassword }, 'patch')
  assert.equal((await invoke(authRouter, '/login', { account: user.email, password: newPassword })).status, 200)
  const adminPassword = '  Issued-password-123  '
  assert.equal((await invoke(usersRouter, '/', { fullName: user.ho_ten, email: user.email,
    phone: user.so_dien_thoai, role: 'hoc_vien', password: adminPassword })).status, 201)
  assert.equal((await invoke(authRouter, '/login', { account: user.email, password: adminPassword })).status, 200)
})

test('OTP chỉ đổi mật khẩu một lần khi hai yêu cầu đồng thời; dùng lại/hết hạn/quá số lần đều bị chặn', async (context) => {
  const { authRouter } = await import('./auth')
  const code = '123456'
  const reset = { id: 10, nguoi_dung_id: 1, so_lan_nhap_sai: 0,
    ma_hmac: createHmac('sha256', env.otpSecret).update(`1:${code}`).digest('hex') }
  let readers = 0
  let releaseReaders!: () => void
  const bothRead = new Promise<void>((resolve) => { releaseReaders = resolve })
  context.mock.method(database, 'query', (async () => {
    if (++readers === 2) releaseReaders()
    await bothRead
    return [[reset], []]
  }) as typeof database.query)
  let used = false
  let reserved = false
  let expired = false
  let attempts = 0
  let updates = 0
  let rollbacks = 0
  let failPasswordWrite = false
  let storedPassword = ''
  context.mock.method(database, 'getConnection', (async () => {
    let ownsReservation = false
    let pendingPassword = ''
    return {
      beginTransaction: async () => {},
      execute: async (sql: string, values: unknown[]) => {
        if (sql.includes('UPDATE ma_dat_lai_mat_khau')) {
          assert.match(sql, /da_dung_luc IS NULL/)
          assert.match(sql, /het_han_luc > NOW\(\)/)
          assert.match(sql, /so_lan_nhap_sai < 5/)
          if (used || reserved || expired || attempts >= 5) return [{ affectedRows: 0 }, []]
          reserved = ownsReservation = true
        } else {
          assert.equal(ownsReservation, true, 'OTP phải được nhận độc quyền trước khi sửa mật khẩu')
          if (failPasswordWrite) throw new Error('simulated password write failure')
          pendingPassword = String(values[0])
        }
        return [{ affectedRows: 1 }, []]
      },
      commit: async () => { used = true; reserved = false; storedPassword = pendingPassword; updates += 1 },
      rollback: async () => { if (ownsReservation) reserved = false; rollbacks += 1 },
      release: () => {},
    }
  }) as unknown as typeof database.getConnection)

  const request = { email: 'test@example.test', code, newPassword: '  Reset-password-123  ' }
  const outcomes = await Promise.allSettled([invoke(authRouter, '/reset-password', request), invoke(authRouter, '/reset-password', request)])
  assert.equal(outcomes.filter((result) => result.status === 'fulfilled').length, 1)
  const failure = outcomes.find((result) => result.status === 'rejected') as PromiseRejectedResult
  assert.equal(failure.reason.status, 400)
  assert.equal(updates, 1)
  assert.equal(rollbacks, 1)
  assert.equal(await bcrypt.compare(request.newPassword, storedPassword), true)

  const rejected = (error: unknown) => error instanceof HttpError && error.status === 400
  await assert.rejects(invoke(authRouter, '/reset-password', request), rejected)
  used = false; expired = true
  await assert.rejects(invoke(authRouter, '/reset-password', request), rejected)
  expired = false; attempts = 5
  await assert.rejects(invoke(authRouter, '/reset-password', request), rejected)
  assert.equal(updates, 1)
  attempts = 0; failPasswordWrite = true
  await assert.rejects(invoke(authRouter, '/reset-password', request), /simulated password write failure/)
  assert.equal(reserved, false)
  assert.equal(used, false)
  failPasswordWrite = false
  assert.equal((await invoke(authRouter, '/reset-password', request)).status, 200)
  assert.equal(updates, 2)
})

test('OTP bị khóa đúng ở lần nhập sai thứ năm, không tăng số lần sau khi đã dùng', async (context) => {
  const { authRouter } = await import('./auth')
  let attempts = 0
  let used = false
  context.mock.method(database, 'query', (async () => [[...(!used ? [{ id: 10, nguoi_dung_id: 1,
    ma_hmac: createHmac('sha256', env.otpSecret).update('1:123456').digest('hex'), so_lan_nhap_sai: attempts }] : [])], []]) as typeof database.query)
  context.mock.method(database, 'execute', (async (sql: string) => {
    assert.match(sql, /da_dung_luc IS NULL/)
    assert.ok(sql.indexOf('SET da_dung_luc') < sql.indexOf('so_lan_nhap_sai = so_lan_nhap_sai + 1'))
    used = attempts >= 4
    attempts += 1
    return [{ affectedRows: 1 }, []]
  }) as unknown as typeof database.execute)
  const request = { email: 'test@example.test', code: '000000', newPassword: 'Reset-password-123' }
  for (let index = 1; index <= 5; index += 1) {
    await assert.rejects(invoke(authRouter, '/reset-password', request), (error: unknown) => error instanceof HttpError && error.status === 400)
    assert.equal(attempts, index)
    assert.equal(used, index === 5)
  }
  await assert.rejects(invoke(authRouter, '/reset-password', request))
  assert.equal(attempts, 5)
})
