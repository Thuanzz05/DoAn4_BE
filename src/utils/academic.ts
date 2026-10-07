import { normalizeLocalDateTime } from './date-time'
import { isValidScore } from './grades'
import { HttpError } from './http-error'

export type ExamDetails = { name: string; examDate: string | null; deadline: string | null }
export type ExamScore = {
  examId: number; listening: number | null; speaking: number | null
  reading: number | null; writing: number | null
}

export function academicId(value: unknown, label: string): number {
  const parsed = Number(value)
  if ((typeof value !== 'string' && typeof value !== 'number') || !Number.isSafeInteger(parsed) || parsed < 1) {
    throw new HttpError(400, `${label} phải là số nguyên dương`)
  }
  return parsed
}

export function examDetails(input: Record<string, unknown>, current?: ExamDetails): ExamDetails {
  const name = input.name === undefined ? current?.name : input.name
  if (typeof name !== 'string' || !name.trim() || name.trim().length > 100) {
    throw new HttpError(400, 'Tên kỳ thi là bắt buộc và tối đa 100 ký tự')
  }
  const date = input.examDate === undefined ? current?.examDate : input.examDate
  const examDate = date === undefined || date === null || date === '' ? null : date
  if (examDate !== null && (typeof examDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(examDate)
    || !normalizeLocalDateTime(`${examDate}T00:00`))) throw new HttpError(400, 'Ngày thi không hợp lệ (YYYY-MM-DD)')
  const deadlineValue = input.deadline === undefined ? current?.deadline?.replace(' ', 'T') : input.deadline
  const deadline = deadlineValue === undefined || deadlineValue === null || deadlineValue === '' ? null
    : typeof deadlineValue === 'string' ? normalizeLocalDateTime(deadlineValue) : null
  if (deadlineValue !== undefined && deadlineValue !== null && deadlineValue !== '' && !deadline) {
    throw new HttpError(400, 'Hạn sửa điểm không hợp lệ')
  }
  if (input.deadline !== undefined && current?.deadline && deadline === null) {
    throw new HttpError(400, 'Không được bỏ hạn sửa điểm đã thiết lập; hãy chọn hạn mới')
  }
  if (examDate && deadline && deadline < `${examDate} 00:00:00`) {
    throw new HttpError(400, 'Hạn sửa điểm phải từ ngày thi trở đi')
  }
  return { name: name.trim(), examDate: examDate as string | null, deadline }
}

export function examReason(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 255) {
    throw new HttpError(400, 'Lý do là bắt buộc và tối đa 255 ký tự')
  }
  return value.trim()
}

export function assertExamUnlocked(classStatus: string, certificateLocked: boolean): void {
  if (classStatus === 'da_huy') throw new HttpError(409, 'Không thể thay đổi kỳ thi của lớp đã hủy')
  if (certificateLocked) throw new HttpError(409, 'Lớp đã chốt hồ sơ chứng chỉ, không thể thay đổi kỳ thi hoặc hạn sửa điểm')
}

export function scoreAverage(result: ExamScore): number | null {
  const values = [result.listening, result.speaking, result.reading, result.writing]
  return values.every(isValidScore) ? values.reduce<number>((total, score) => total + Number(score), 0) / 4 : null
}

export function summarizeExamScores(examIds: number[], results: ExamScore[]) {
  const required = new Set(examIds)
  const byExam = new Map(results.filter((result) => required.has(result.examId)).map((result) => [result.examId, scoreAverage(result)]))
  const completed = [...required].map((id) => byExam.get(id)).filter((average): average is number => average !== null && average !== undefined)
  return {
    requiredExams: required.size, completedExams: completed.length,
    average: required.size > 0 && completed.length === required.size
      ? completed.reduce((total, average) => total + average, 0) / required.size : null,
  }
}
