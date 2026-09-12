import type { ErrorRequestHandler, RequestHandler } from 'express'

export const notFoundHandler: RequestHandler = (request, response) => {
  response.status(404).json({
    success: false,
    message: `Không tìm thấy ${request.method} ${request.originalUrl}`,
  })
}

export const errorHandler: ErrorRequestHandler = (
  error: unknown,
  _request,
  response,
  _next,
) => {
  console.error(error)

  response.status(500).json({
    success: false,
    message: 'Đã xảy ra lỗi phía máy chủ',
  })
}
