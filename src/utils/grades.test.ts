import assert from 'node:assert/strict'
import test from 'node:test'
import { isValidScore } from './grades'

test('điểm hợp lệ nằm trong khoảng từ 0 đến 10', () => {
  assert.equal(isValidScore(0), true)
  assert.equal(isValidScore('7.5'), true)
  assert.equal(isValidScore(10), true)
  assert.equal(isValidScore(null), false)
  assert.equal(isValidScore(-0.5), false)
  assert.equal(isValidScore(10.5), false)
})
