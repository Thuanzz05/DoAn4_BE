import nodemailer from 'nodemailer'
import { env } from '../config/env'

const mailConfigured = Boolean(env.smtpHost && env.smtpUser && env.smtpPassword && env.smtpFrom)

const transporter = mailConfigured
  ? nodemailer.createTransport({
      host: env.smtpHost,
      port: env.smtpPort,
      secure: env.smtpSecure,
      auth: { user: env.smtpUser, pass: env.smtpPassword },
    })
  : null

export async function sendPasswordResetCode(
  email: string,
  fullName: string,
  code: string,
): Promise<boolean> {
  if (!transporter) return false

  await transporter.sendMail({
    from: env.smtpFrom,
    to: email,
    subject: 'Mã đặt lại mật khẩu',
    text: `Xin chào ${fullName}, mã đặt lại mật khẩu của bạn là ${code}. Mã có hiệu lực trong 10 phút. Nếu bạn không yêu cầu, hãy bỏ qua email này.`,
    html: `<p>Xin chào <strong>${fullName}</strong>,</p><p>Mã đặt lại mật khẩu của bạn là:</p><p style="font-size:28px;font-weight:700;letter-spacing:6px">${code}</p><p>Mã có hiệu lực trong 10 phút. Nếu bạn không yêu cầu, hãy bỏ qua email này.</p>`,
  })
  return true
}
