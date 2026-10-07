import { app } from './app'
import { checkDatabase, database } from './config/database'
import { env } from './config/env'

let server: ReturnType<typeof app.listen>

async function start(): Promise<void> {
  await checkDatabase()
  server = app.listen(env.port, () => {
    console.log(`Server đang chạy tại http://localhost:${env.port}`)
    console.log(`MySQL database: ${env.dbName}`)
    if (env.nodeEnv !== 'production') console.log(`Swagger: http://localhost:${env.port}/api-docs/`)
  })
}

function shutdown(signal: string): void {
  console.log(`\nĐã nhận ${signal}. Đang dừng server...`)

  if (!server) {
    process.exit(0)
  }
  server.close(async (error) => {
    if (error) {
      console.error('Không thể dừng server an toàn:', error)
      process.exit(1)
    }
    await database.end()
    process.exit(0)
  })
}

process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))

start().catch((error: unknown) => {
  console.error('Không thể khởi động backend. Kiểm tra cấu hình MySQL trong .env:', error)
  process.exit(1)
})
