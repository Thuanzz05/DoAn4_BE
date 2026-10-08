import assert from 'node:assert/strict'
import test from 'node:test'
import { clientOrigins } from './env'

test('CORS dev chấp nhận hai tên loopback cùng port; production chỉ origin cấu hình', () => {
  assert.deepEqual(clientOrigins('http://localhost:5173/', 'development'), ['http://localhost:5173', 'http://127.0.0.1:5173'])
  assert.deepEqual(clientOrigins('http://127.0.0.1:4173/path', 'development'), ['http://127.0.0.1:4173', 'http://localhost:4173'])
  assert.deepEqual(clientOrigins('https://center.example/', 'development'), ['https://center.example'])
  assert.deepEqual(clientOrigins('http://localhost:5173', 'production'), ['http://localhost:5173'])
  assert.throws(() => clientOrigins('file:///tmp/app', 'development'))
})
