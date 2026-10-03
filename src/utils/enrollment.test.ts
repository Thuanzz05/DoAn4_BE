import assert from 'node:assert/strict'
import test from 'node:test'
import { canChangeEnrollmentStatus } from './enrollment'

test('chỉ cho phép chuyển trạng thái ghi danh theo vòng đời', () => {
  assert.equal(canChangeEnrollmentStatus('dang_hoc', 'bao_luu'), true)
  assert.equal(canChangeEnrollmentStatus('bao_luu', 'dang_hoc'), true)
  assert.equal(canChangeEnrollmentStatus('cho_xep_lop', 'da_huy'), true)
  assert.equal(canChangeEnrollmentStatus('hoan_thanh', 'dang_hoc'), false)
  assert.equal(canChangeEnrollmentStatus('da_huy', 'dang_hoc'), false)
})
