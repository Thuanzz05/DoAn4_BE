import cors from 'cors'
import express from 'express'
import swaggerUi from 'swagger-ui-express'
import { join } from 'node:path'
import { clientOrigins, env } from './config/env'
import { openApiDocument } from './docs/openapi'
import { errorHandler, notFoundHandler } from './middlewares/error-handler'
import { apiRouter } from './routes'

export const app = express()

app.disable('x-powered-by')
app.use(
  cors({
    origin: clientOrigins(env.clientUrl, env.nodeEnv),
    credentials: true,
  }),
)
app.use(express.json({ limit: '1mb' }))
app.use(express.urlencoded({ extended: true }))
app.use('/uploads/certificates', express.static(join(env.storageDir, 'certificates'), { index: false }))

if (env.nodeEnv !== 'production') {
  app.get('/api-docs/openapi.json', (_request, response) => response.json(openApiDocument))
  app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(openApiDocument, {
    customSiteTitle: 'Swagger — Đồ án 4',
    swaggerOptions: { docExpansion: 'none', filter: true, persistAuthorization: false, validatorUrl: null },
  }))
}

app.get('/', (_request, response) => {
  response.json({
    success: true,
    message: 'Chào mừng đến với API Đồ án 4',
  })
})

app.use('/api', apiRouter)

app.use(notFoundHandler)
app.use(errorHandler)
