import assert from 'node:assert/strict'
import test from 'node:test'
import { generateTemporaryPassword, isValidBirthDate, isValidPassword } from './account'

test('kiểm tra ngày sinh và mật khẩu tài khoản', () => {
  assert.equal(isValidBirthDate('2000-02-29'), true)
  assert.equal(isValidBirthDate('2001-02-29'), false)
  assert.equal(isValidBirthDate('2999-01-01'), false)
  assert.equal(isValidPassword('12345678'), true)
  assert.equal(isValidPassword('1234567'), false)
  const temporaryPassword = generateTemporaryPassword()
  assert.equal(isValidPassword(temporaryPassword), true)
  assert.match(temporaryPassword, /^Tk1![A-Za-z0-9_-]{11}$/)
})
