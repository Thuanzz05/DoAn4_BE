import assert from 'node:assert/strict'
import test from 'node:test'
import { normalizeLocalDateTime } from './date-time'

test('giữ nguyên giờ địa phương từ datetime-local khi lưu MySQL', () => {
  assert.equal(normalizeLocalDateTime('2026-10-03T20:30'), '2026-10-03 20:30:00')
  assert.equal(normalizeLocalDateTime('2026-02-30T20:30'), null)
  assert.equal(normalizeLocalDateTime('2026-10-03T25:00'), null)
})
