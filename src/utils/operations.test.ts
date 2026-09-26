import assert from 'node:assert/strict'
import test from 'node:test'
import { getReportPeriod, isCertificateEligible } from './operations'

test('tính khoảng báo cáo và điều kiện chứng chỉ', () => {
  assert.deepEqual(getReportPeriod('quarter', 2026, 3), { start: '2026-07-01', end: '2026-10-01' })
  assert.equal(isCertificateEligible({ enrollmentStatus: 'hoan_thanh', paid: true, attendance: 80, average: 5 }), true)
  assert.equal(isCertificateEligible({ enrollmentStatus: 'dang_hoc', paid: true, attendance: 95, average: 8 }), false)
})
