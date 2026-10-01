import assert from 'node:assert/strict'
import { readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'
import { createCertificatePdf } from './certificate-pdf'

test('sinh tệp chứng chỉ PDF hợp lệ', async () => {
  const output = join(tmpdir(), `certificate-${process.pid}.pdf`)
  await createCertificatePdf(output, {
    certificateCode: 'CC-2026-000001', studentName: 'Nguyễn Minh Anh', studentCode: 'HV-0001',
    courseName: 'Tiếng Anh giao tiếp', className: 'Giao tiếp căn bản', classCode: 'TA-A1-01',
    language: 'Tiếng Anh', issuedAt: new Date('2026-10-02T00:00:00+07:00'),
    verificationUrl: 'http://localhost:3000/api/certificates/verify/test',
  })
  const bytes = await readFile(output)
  assert.equal(bytes.subarray(0, 4).toString(), '%PDF')
  assert.ok(bytes.length > 2_000)
  await rm(output, { force: true })
})
