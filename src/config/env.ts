import 'dotenv/config'
import { randomBytes } from 'node:crypto'
import { resolve } from 'node:path'

const nodeEnv = process.env.NODE_ENV ?? 'development'

function readPort(value: string | undefined, fallback: number, name: string): number {
  const port = Number(value ?? fallback)

  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`${name} phải là số nguyên từ 1 đến 65535`)
  }

  return port
}

function secret(name: string): string {
  const value = process.env[name]
  if (!value) {
    if (nodeEnv === 'production') throw new Error(`${name} là bắt buộc khi chạy production`)
    return randomBytes(32).toString('hex')
  }
  if (value.length < 32) throw new Error(`${name} phải có ít nhất 32 ký tự`)
  return value
}

const port = readPort(process.env.PORT, 3000, 'PORT')

export const env = {
  port,
  clientUrl: process.env.CLIENT_URL ?? 'http://localhost:5173',
  publicUrl: (process.env.PUBLIC_URL ?? `http://localhost:${port}`).replace(/\/$/, ''),
  storageDir: resolve(process.env.STORAGE_DIR ?? 'storage'),
  certificateFontPath: process.env.CERTIFICATE_FONT_PATH ?? '',
  nodeEnv,
  dbHost: process.env.DB_HOST ?? '127.0.0.1',
  dbPort: readPort(process.env.DB_PORT, 3306, 'DB_PORT'),
  dbUser: process.env.DB_USER ?? 'root',
  dbPassword: process.env.DB_PASSWORD ?? '',
  dbName: process.env.DB_NAME ?? 'doan4',
  jwtSecret: secret('JWT_SECRET'),
  otpSecret: secret('OTP_SECRET'),
  googleClientId: process.env.GOOGLE_CLIENT_ID ?? '',
  smtpHost: process.env.SMTP_HOST ?? '',
  smtpPort: readPort(process.env.SMTP_PORT, 465, 'SMTP_PORT'),
  smtpSecure: (process.env.SMTP_SECURE ?? 'true') === 'true',
  smtpUser: process.env.SMTP_USER ?? '',
  smtpPassword: process.env.SMTP_PASSWORD ?? '',
  smtpFrom: process.env.SMTP_FROM ?? process.env.SMTP_USER ?? '',
  geminiApiKey: process.env.GEMINI_API_KEY ?? '',
  geminiModel: process.env.GEMINI_MODEL ?? 'gemini-2.5-flash',
} as const
