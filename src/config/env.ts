import 'dotenv/config'

function readPort(value: string | undefined, fallback: number, name: string): number {
  const port = Number(value ?? fallback)

  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`${name} phải là số nguyên từ 1 đến 65535`)
  }

  return port
}

function secret(name: string, fallback: string): string {
  const value = process.env[name] ?? fallback
  if (value.length < 32) throw new Error(`${name} phải có ít nhất 32 ký tự`)
  return value
}

export const env = {
  port: readPort(process.env.PORT, 3000, 'PORT'),
  clientUrl: process.env.CLIENT_URL ?? 'http://localhost:5173',
  nodeEnv: process.env.NODE_ENV ?? 'development',
  dbHost: process.env.DB_HOST ?? '127.0.0.1',
  dbPort: readPort(process.env.DB_PORT, 3306, 'DB_PORT'),
  dbUser: process.env.DB_USER ?? 'root',
  dbPassword: process.env.DB_PASSWORD ?? '',
  dbName: process.env.DB_NAME ?? 'doan4',
  jwtSecret: secret('JWT_SECRET', 'dev-jwt-secret-thay-khi-trien-khai-123456'),
  otpSecret: secret('OTP_SECRET', 'dev-otp-secret-thay-khi-trien-khai-123456'),
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
