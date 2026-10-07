import assert from 'node:assert/strict'
import test from 'node:test'
import { reminderType } from './invoice-reminders'

test('nhắc trong ba ngày trước hạn và khi quá hạn, không nhắc trước thời điểm đó', () => {
  assert.equal(reminderType(4), null)
  assert.equal(reminderType(3), 'sap_den_han')
  assert.equal(reminderType(0), 'sap_den_han')
  assert.equal(reminderType(-1), 'qua_han')
  assert.equal(reminderType(1.5), null)
})
