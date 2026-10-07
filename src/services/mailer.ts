import nodemailer from 'nodemailer'
import { env } from '../config/env'

const mailConfigured = Boolean(env.smtpHost && env.smtpUser && env.smtpPassword && env.smtpFrom)

const transporter = mailConfigured
  ? nodemailer.createTransport({
      host: env.smtpHost,
      port: env.smtpPort,
      secure: env.smtpSecure,
      pool: true,
      maxConnections: 3,
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 20_000,
      auth: { user: env.smtpUser, pass: env.smtpPassword },
    })
  : null

export type AccountDelivery = { emailSent: boolean; temporaryPassword?: string; emailWarning?: string }

export async function deliverAccountInformation(
  email: string,
  fullName: string,
  password: string,
  role: 'giao_vien' | 'hoc_vien',
): Promise<AccountDelivery> {
  const fallback = { emailSent: false, temporaryPassword: password,
    emailWarning: 'Chưa gửi được email. Hãy bàn giao mật khẩu tạm thời qua kênh riêng hoặc dùng Đặt lại mật khẩu để gửi lại.' }
  if (!transporter) return fallback
  try {
    await transporter.sendMail({
      from: env.smtpFrom,
      to: email,
      subject: 'Thông tin tài khoản Trung tâm ngoại ngữ',
      text: `Xin chào ${fullName}, tài khoản ${role === 'giao_vien' ? 'giáo viên' : 'học viên'} của bạn đã được tạo.\nEmail đăng nhập: ${email}\nMật khẩu ban đầu: ${password}\nĐăng nhập tại: ${env.clientUrl.replace(/\/$/, '')}/login\nHãy đổi mật khẩu sau khi đăng nhập và không chia sẻ thông tin này.`,
    })
    return { emailSent: true }
  } catch {
    return fallback
  }
}

export async function sendInvoiceReminder(
  email: string,
  fullName: string,
  invoice: { code: string; courseName: string; amount: number; dueDate: string; overdue: boolean },
): Promise<boolean> {
  if (!transporter) return false
  await transporter.sendMail({
    from: env.smtpFrom,
    to: email,
    subject: invoice.overdue ? `Học phí quá hạn: ${invoice.code}` : `Nhắc hạn học phí: ${invoice.code}`,
    text: `Xin chào ${fullName}, hóa đơn ${invoice.code} cho khóa ${invoice.courseName} ${invoice.overdue ? 'đã quá hạn' : 'sắp đến hạn'}.\nSố tiền: ${new Intl.NumberFormat('vi-VN').format(invoice.amount)}đ\nHạn thanh toán: ${invoice.dueDate}\nVui lòng liên hệ trung tâm để thanh toán hoặc kiểm tra thông tin.`,
  })
  return true
}

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
  })
  return true
}

export async function sendTemporaryPassword(
  email: string,
  fullName: string,
  password: string,
): Promise<boolean> {
  if (!transporter) return false

  await transporter.sendMail({
    from: env.smtpFrom,
    to: email,
    subject: 'Mật khẩu tạm thời của tài khoản',
    text: `Xin chào ${fullName}, quản trị viên đã đặt lại mật khẩu tài khoản của bạn. Mật khẩu tạm thời: ${password}. Hãy đăng nhập và đổi mật khẩu ngay.`,
  })
  return true
}
