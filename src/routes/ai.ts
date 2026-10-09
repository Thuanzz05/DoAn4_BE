import { Router } from 'express'
import { rateLimit } from 'express-rate-limit'
import type { RowDataPacket } from 'mysql2'
import { database } from '../config/database'
import { env } from '../config/env'
import { HttpError } from '../utils/http-error'

type CourseRow = RowDataPacket & {
  id: number
  code: string
  name: string
  language: string
  level: string
  sessions: number
  tuition: number
  description: string | null
}
type GeminiResponse = {
  candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>
  error?: { message?: string }
}

export function geminiFailure(status: number, providerMessage?: string): HttpError {
  if (status === 429 || status === 503) {
    return new HttpError(503, 'Dịch vụ tư vấn đang bận, vui lòng thử lại sau ít phút.')
  }
  return new HttpError(502, providerMessage ?? 'Dịch vụ AI đang lỗi')
}

export const aiRouter = Router()

aiRouter.post(
  '/tu-van-khoa-hoc',
  rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 20,
    standardHeaders: true,
    legacyHeaders: false,
    message: { success: false, message: 'Bạn gửi quá nhiều yêu cầu tư vấn, vui lòng thử lại sau.' },
  }),
  async (request, response) => {
    const question = typeof request.body.question === 'string' ? request.body.question.trim() : ''
    if (!question || question.length > 1000) throw new HttpError(400, 'Câu hỏi phải từ 1 đến 1000 ký tự')
    if (!env.geminiApiKey) throw new HttpError(503, 'AI chưa được cấu hình GEMINI_API_KEY')

    const [courses] = await database.query<CourseRow[]>(
      `SELECT id, ma_khoa_hoc AS code, ten_khoa_hoc AS name, ngoai_ngu AS language,
       trinh_do AS level, so_buoi AS sessions, hoc_phi AS tuition, mo_ta AS description
       FROM khoa_hoc WHERE trang_thai = 'dang_mo' ORDER BY id`,
    )
    if (!courses.length) throw new HttpError(409, 'Chưa có khóa học đang mở để tư vấn')

    const prompt = `Bạn là trợ lý tư vấn của trung tâm ngoại ngữ. Chỉ được gợi ý từ danh sách khóa học JSON bên dưới, không tự tạo khóa học, giá hoặc cam kết đầu ra. Trả lời ngắn gọn bằng tiếng Việt, nêu tối đa 3 lựa chọn và luôn kèm mã khóa học. Nếu thiếu thông tin, hãy hỏi đúng 1 câu làm rõ.\n\nDanh sách khóa học:\n${JSON.stringify(courses)}\n\nNhu cầu người học:\n${question}`
    const aiResponse = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(env.geminiModel)}:generateContent`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': env.geminiApiKey },
        body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: prompt }] }] }),
        signal: AbortSignal.timeout(20_000),
      },
    )
    const body = (await aiResponse.json()) as GeminiResponse
    if (!aiResponse.ok) throw geminiFailure(aiResponse.status, body.error?.message)
    const answer = body.candidates?.[0]?.content?.parts?.map((part) => part.text ?? '').join('').trim()
    if (!answer) throw new HttpError(502, 'AI không trả về nội dung tư vấn')
    response.json({ success: true, data: { answer } })
  },
)
