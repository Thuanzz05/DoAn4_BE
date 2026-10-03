import assert from 'node:assert/strict'
import test from 'node:test'
import { getCertificateEligibilityReasons, getNotificationTarget, getReportPeriod, isCertificateEligible } from './operations'

test('tính khoảng báo cáo và điều kiện chứng chỉ', () => {
  assert.deepEqual(getReportPeriod('quarter', 2026, 3), { start: '2026-07-01', end: '2026-10-01' })
  assert.equal(isCertificateEligible({ enrollmentStatus: 'hoan_thanh', paid: true, attendance: 80, average: 5, requiredExams: 2, completedExams: 2 }), true)
  assert.equal(isCertificateEligible({ enrollmentStatus: 'hoan_thanh', paid: true, attendance: 95, average: 8, requiredExams: 2, completedExams: 1 }), false)
  assert.equal(isCertificateEligible({ enrollmentStatus: 'dang_hoc', paid: true, attendance: 95, average: 8, requiredExams: 1, completedExams: 1 }), false)
  assert.deepEqual(
    getCertificateEligibilityReasons({ enrollmentStatus: 'dang_hoc', paid: false, attendance: 70, average: null, requiredExams: 2, completedExams: 1 }),
    ['Chưa hoàn thành khóa học', 'Chưa hoàn tất học phí', 'Tỷ lệ chuyên cần dưới 80%', 'Chưa hoàn thành tất cả kỳ thi (1/2)'],
  )
  assert.deepEqual(getNotificationTarget(12, undefined), { userId: 12, role: null })
  assert.deepEqual(getNotificationTarget(undefined, 'giao_vien'), { userId: null, role: 'giao_vien' })
  assert.equal(getNotificationTarget(12, 'giao_vien'), null)
})
