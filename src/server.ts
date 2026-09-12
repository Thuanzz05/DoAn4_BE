import { app } from './app'
import { env } from './config/env'

const server = app.listen(env.port, () => {
  console.log(`Server đang chạy tại http://localhost:${env.port}`)
  console.log(`Môi trường: ${env.nodeEnv}`)
})

function shutdown(signal: string): void {
  console.log(`\nĐã nhận ${signal}. Đang dừng server...`)

  server.close((error) => {
    if (error) {
      console.error('Không thể dừng server an toàn:', error)
      process.exit(1)
    }

    process.exit(0)
  })
}

process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))
