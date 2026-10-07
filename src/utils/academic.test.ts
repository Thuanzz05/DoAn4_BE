import assert from 'node:assert/strict'
import test from 'node:test'
import { academicId, assertExamUnlocked, examDetails, examReason, scoreAverage, summarizeExamScores } from './academic'

test('kỳ thi kiểm tra ngày, giờ Việt Nam, hạn sửa và lý do quản trị', () => {
  assert.deepEqual(examDetails({ name: ' Cuối khóa ', examDate: '2026-10-10', deadline: '2026-10-11T18:30' }),
    { name: 'Cuối khóa', examDate: '2026-10-10', deadline: '2026-10-11 18:30:00' })
  for (const input of [{ name: '' }, { name: 'x'.repeat(101) }, { name: 'Thi', examDate: '2026-02-30' },
    { name: 'Thi', deadline: '2026-10-11T18:30:00Z' }, { name: 'Thi', deadline: false },
    { name: 'Thi', examDate: '2026-10-10', deadline: '2026-10-09T23:59' }]) assert.throws(() => examDetails(input))
  const current = { name: 'Thi', examDate: '2026-10-10', deadline: '2026-10-11 18:30:00' }
  assert.equal(examDetails({ name: 'Thi sửa tên' }, current).deadline, current.deadline)
  assert.throws(() => examDetails({ deadline: null }, current))
  assert.equal(examReason(' Nhập bù điểm '), 'Nhập bù điểm')
  assert.throws(() => examReason(''))
  assert.throws(() => examReason('x'.repeat(256)))
  assert.equal(academicId('12', 'Lớp'), 12)
  for (const value of [true, [], {}, 0, -1, 1.5]) assert.throws(() => academicId(value, 'Lớp'))
})

test('hồ sơ chứng chỉ khóa mọi thay đổi kỳ thi; lớp đã hủy không được sửa', () => {
  assert.doesNotThrow(() => assertExamUnlocked('da_ket_thuc', false))
  assert.throws(() => assertExamUnlocked('da_ket_thuc', true))
  assert.throws(() => assertExamUnlocked('dang_hoc', true))
  assert.throws(() => assertExamUnlocked('da_huy', false))
})

test('điểm toàn khóa chỉ có trung bình khi đủ mọi kỳ thi; điểm 0 khác chưa nhập', () => {
  const zero = { examId: 1, listening: 0, speaking: 0, reading: 0, writing: 0 }
  const complete = { examId: 2, listening: 8, speaking: 8, reading: 8, writing: 8 }
  assert.equal(scoreAverage(zero), 0)
  assert.equal(scoreAverage({ ...zero, writing: null }), null)
  assert.deepEqual(summarizeExamScores([1, 2], [zero]), { requiredExams: 2, completedExams: 1, average: null })
  assert.deepEqual(summarizeExamScores([1, 2], [zero, complete]), { requiredExams: 2, completedExams: 2, average: 4 })
  assert.deepEqual(summarizeExamScores([], [zero]), { requiredExams: 0, completedExams: 0, average: null })
  assert.equal(summarizeExamScores([1, 2], [zero, { ...complete, writing: null }]).average, null)
  assert.equal(summarizeExamScores([1], [zero, complete]).average, 0)
  const borderline = summarizeExamScores([1], [{ ...zero, listening: 4.99, speaking: 5, reading: 5, writing: 5 }]).average!
  assert.ok(borderline < 5, 'Không làm tròn 4.9975 thành điểm đạt 5')
})
