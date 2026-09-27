import assert from 'node:assert/strict'
import test from 'node:test'
import { normalizeHeader, validateImportedStudents } from './enrollment-import'

test('chuẩn hóa và kiểm tra dữ liệu học viên import', () => {
  assert.equal(normalizeHeader('Số điện thoại'), 'sodienthoai')
  const rows = validateImportedStudents([
    { rowNumber: 2, fullName: 'Nguyễn Văn A', email: 'A@Example.com', phone: '0912 345 678', birthDate: '20/09/2004' },
    { rowNumber: 3, fullName: '', email: 'a@example.com', phone: '0912345678', birthDate: '31/02/2004' },
  ])
  assert.deepEqual(rows[0], {
    rowNumber: 2,
    fullName: 'Nguyễn Văn A',
    email: 'a@example.com',
    phone: '0912345678',
    birthDate: '2004-09-20',
    errors: ['Email bị trùng trong file', 'Số điện thoại bị trùng trong file'],
  })
  assert.deepEqual(rows[1].errors, [
    'Thiếu họ tên',
    'Ngày sinh không hợp lệ',
    'Email bị trùng trong file',
    'Số điện thoại bị trùng trong file',
  ])
})
