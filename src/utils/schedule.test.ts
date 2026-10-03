import assert from 'node:assert/strict'
import test from 'node:test'
import { generateSessionDates, roomCanHostClass } from './schedule'

test('sinh đủ buổi theo lịch thứ hai và thứ tư', () => {
  const sessions = generateSessionDates('2026-09-28', 3, [
    { dayOfWeek: 2, startTime: '18:00:00', endTime: '19:30:00', roomId: 1 },
    { dayOfWeek: 4, startTime: '18:00:00', endTime: '19:30:00', roomId: 1 },
  ])
  assert.deepEqual(sessions.map((item) => item.startsAt), [
    '2026-09-28 18:00:00',
    '2026-09-30 18:00:00',
    '2026-10-05 18:00:00',
  ])
})

test('phòng học phải đủ sức chứa tối đa của lớp', () => {
  assert.equal(roomCanHostClass(30, 30), true)
  assert.equal(roomCanHostClass(29, 30), false)
})
