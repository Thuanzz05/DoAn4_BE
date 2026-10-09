import assert from 'node:assert/strict'
import test from 'node:test'
import nodemailer from 'nodemailer'
import type { SendMailOptions } from 'nodemailer'

test('gửi tài khoản không lộ mật khẩu khi thành công, có phương án bàn giao khi email lỗi', async (context) => {
  const smtpKeys = ['SMTP_HOST', 'SMTP_USER', 'SMTP_PASSWORD', 'SMTP_FROM'] as const
  const original = Object.fromEntries(smtpKeys.map((key) => [key, process.env[key]]))
  Object.assign(process.env, { SMTP_HOST: 'mail.invalid', SMTP_USER: 'test', SMTP_PASSWORD: 'stub-only', SMTP_FROM: 'center@example.test' })
  const sent: SendMailOptions[] = []
  let fails = false
  context.mock.method(nodemailer, 'createTransport', () => ({
    sendMail: async (mail: SendMailOptions) => {
      if (fails) throw new Error('SMTP unavailable')
      sent.push(mail)
      return { accepted: [mail.to] }
    },
  }))
  try {
    const { deliverAccountInformation, sendInvoiceReminder } = await import('./mailer.js')
    const delivered = await deliverAccountInformation('student@example.test', 'Học viên thử', 'Temp-test-123', 'hoc_vien')
    assert.deepEqual(delivered, { emailSent: true })
    assert.equal(sent[0].to, 'student@example.test')
    assert.match(String(sent[0].text), /Temp-test-123/)
    assert.match(String(sent[0].text), /\/login/)

    fails = true
    const fallback = await deliverAccountInformation('teacher@example.test', 'Giáo viên thử', 'Temp-test-456', 'giao_vien')
    assert.equal(fallback.emailSent, false)
    assert.equal(fallback.temporaryPassword, 'Temp-test-456')
    assert.match(fallback.emailWarning ?? '', /bàn giao/)

    fails = false
    assert.equal(await sendInvoiceReminder('student@example.test', 'Học viên thử', {
      code: 'HD-TEST', courseName: 'Tiếng Anh', amount: 1000000, dueDate: '2026-10-10', overdue: true,
    }), true)
    assert.match(String(sent[1].subject), /quá hạn/)
    assert.match(String(sent[1].text), /HD-TEST/)
  } finally {
    for (const key of smtpKeys) {
      if (original[key] === undefined) delete process.env[key]
      else process.env[key] = original[key]
    }
  }
})
