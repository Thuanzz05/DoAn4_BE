import assert from 'node:assert/strict'
import test from 'node:test'
import { isValidDraftScore, isValidScore } from './grades'

test('điểm hợp lệ nằm trong khoảng từ 0 đến 10', () => {
  assert.equal(isValidScore(0), true)
  assert.equal(isValidScore('7.5'), true)
  assert.equal(isValidScore(10), true)
  assert.equal(isValidScore(null), false)
  assert.equal(isValidScore(-0.5), false)
  assert.equal(isValidScore(10.5), false)
  assert.equal(isValidScore(true), false)
  assert.equal(isValidScore(' '), false)
  assert.equal(isValidScore([]), false)
  assert.equal(isValidScore(undefined), false)
  assert.equal(isValidScore(Symbol('điểm')), false)
  assert.equal(isValidScore(Number.NaN), false)
  assert.equal(isValidScore(Number.POSITIVE_INFINITY), false)
})

test('bảng điểm nháp giữ null khác 0, không ép dữ liệu sai thành điểm', () => {
  assert.equal(isValidDraftScore(null), true)
  assert.equal(isValidDraftScore(0), true)
  assert.equal(isValidDraftScore('8.5'), true)
  assert.equal(isValidDraftScore(''), false)
  assert.equal(isValidDraftScore(undefined), false)
  assert.equal(isValidDraftScore(false), false)
})
