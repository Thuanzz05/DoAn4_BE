import { Router } from 'express'
import { checkDatabase } from '../config/database'
import { aiRouter } from './ai'
import { academicRouter } from './academic'
import { authRouter } from './auth'
import { coursesRouter } from './courses'
import { enrollmentImportRouter } from './enrollment-import'
import { operationsRouter } from './operations'
import { overviewRouter } from './overview'
import { studentRouter } from './student'
import { teacherRouter } from './teacher'
import { usersRouter } from './users'

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
apiRouter.use('/users', usersRouter)
apiRouter.use('/enrollments/import', enrollmentImportRouter)
apiRouter.use(academicRouter)
apiRouter.use(operationsRouter)
apiRouter.use(overviewRouter)
apiRouter.use('/teacher', teacherRouter)
apiRouter.use('/student', studentRouter)
apiRouter.use('/ai', aiRouter)
