import cors from 'cors'
import express from 'express'
import { join } from 'node:path'
import { env } from './config/env'
import { errorHandler, notFoundHandler } from './middlewares/error-handler'
import { apiRouter } from './routes'

export const app = express()

app.disable('x-powered-by')
app.use(
  cors({
    origin: env.clientUrl,
    credentials: true,
  }),
)
app.use(express.json({ limit: '1mb' }))
app.use(express.urlencoded({ extended: true }))
app.use('/uploads/certificates', express.static(join(env.storageDir, 'certificates'), { index: false }))

app.get('/', (_request, response) => {
  response.json({
    success: true,
    message: 'Chào mừng đến với API Đồ án 4',
  })
})

app.use('/api', apiRouter)

app.use(notFoundHandler)
app.use(errorHandler)
