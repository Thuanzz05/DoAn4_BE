import 'dotenv/config'

function readPort(value: string | undefined): number {
  const port = Number(value ?? 3000)

  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('PORT phải là số nguyên từ 1 đến 65535')
  }

  return port
}

export const env = {
  port: readPort(process.env.PORT),
  clientUrl: process.env.CLIENT_URL ?? 'http://localhost:5173',
  nodeEnv: process.env.NODE_ENV ?? 'development',
} as const
