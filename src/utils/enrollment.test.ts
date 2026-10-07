import assert from 'node:assert/strict'
import test from 'node:test'
import { canChangeEnrollmentStatus, canJoinClass, ensureEnrollmentClass } from './enrollment'

test('chỉ cho phép chuyển trạng thái ghi danh theo vòng đời', () => {
  assert.equal(canChangeEnrollmentStatus('dang_hoc', 'bao_luu'), true)
  assert.equal(canChangeEnrollmentStatus('bao_luu', 'dang_hoc'), true)
  assert.equal(canChangeEnrollmentStatus('cho_xep_lop', 'da_huy'), true)
  assert.equal(canChangeEnrollmentStatus('hoan_thanh', 'dang_hoc'), false)
  assert.equal(canChangeEnrollmentStatus('da_huy', 'dang_hoc'), false)
  assert.equal(canChangeEnrollmentStatus('cho_xep_lop', 'bao_luu'), true)
  assert.equal(canChangeEnrollmentStatus('bao_luu', 'cho_xep_lop'), true)
  assert.equal(canJoinClass('sap_khai_giang', false), true)
  assert.equal(canJoinClass('dang_hoc', false), true)
  assert.equal(canJoinClass('sap_khai_giang', true), false)
  assert.equal(canJoinClass('da_ket_thuc', false), false)
  assert.equal(canJoinClass('dang_hoc', true, true), true)
  assert.equal(canJoinClass('sap_khai_giang', true, true), false)
  assert.equal(canJoinClass('da_ket_thuc', true, true), false)
})

test('xếp lớp kiểm tra khóa, buổi đã bắt đầu và toàn bộ số chỗ cần import', async () => {
  const fake = (status: string, started: number, capacity = 2, enrolled = 1, conflict = false) => ({
    query: async (sql: string) => [sql.includes('SELECT other.ten_lop') ? conflict ? [{ className: 'A2' }] : [] : sql.includes('FROM lop_hoc')
      ? [{ courseId: 7, capacity, status }]
      : [{ hasStarted: started, enrolled }]],
  }) as unknown as Parameters<typeof ensureEnrollmentClass>[0]
  await ensureEnrollmentClass(fake('sap_khai_giang', 0), 1, 7)
  await assert.rejects(ensureEnrollmentClass(fake('dang_hoc', 1), 1, 7), /trước khi buổi học/)
  await assert.rejects(ensureEnrollmentClass(fake('da_ket_thuc', 0), 1, 7), /trước khi buổi học/)
  await assert.rejects(ensureEnrollmentClass(fake('sap_khai_giang', 0), 1, 9), /không thuộc khóa/)
  await assert.rejects(ensureEnrollmentClass(fake('sap_khai_giang', 0), 1, 7, 2), /còn 1 chỗ/)
  await ensureEnrollmentClass(fake('dang_hoc', 1), 1, 7, 1, 5, true, true)
  await ensureEnrollmentClass(fake('sap_khai_giang', 0), 1, 7, 1, 0, true, false, 12)
  await assert.rejects(ensureEnrollmentClass(fake('sap_khai_giang', 0, 2, 1, true), 1, 7, 1, 0, true, false, 12), /trùng lịch với lớp A2/)
})
