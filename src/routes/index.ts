import { Router } from 'express'
import { checkDatabase } from '../config/database'
import { aiRouter } from './ai'
import { authRouter } from './auth'
import { coursesRouter } from './courses'

export const apiRouter = Router()

apiRouter.get('/health', async (_request, response) => {
  await checkDatabase()
  response.status(200).json({
    success: true,
    message: 'Backend và MySQL đang hoạt động',
    timestamp: new Date().toISOString(),
  })
})

apiRouter.use('/auth', authRouter)
apiRouter.use('/courses', coursesRouter)
apiRouter.use('/ai', aiRouter)
