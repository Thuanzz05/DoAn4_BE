import { isValidBirthDate } from './account'

export type ImportedStudentRow = {
  rowNumber: number
  fullName: string
  email: string
  phone: string
  birthDate: string | null
  errors: string[]
}

export function normalizeHeader(value: string): string {
  return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/gi, 'd').toLowerCase().replace(/[^a-z0-9]/g, '')
}

function birthDate(value: unknown): string | null {
  if (value instanceof Date) return value.toISOString().slice(0, 10)
  const text = String(value ?? '').trim()
  if (!text) return null
  const match = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(text)
  return match ? `${match[3]}-${match[2].padStart(2, '0')}-${match[1].padStart(2, '0')}` : text
}

export function validateImportedStudents(rows: Array<Record<string, unknown>>): ImportedStudentRow[] {
  const normalized = rows.map((row, index) => ({
    rowNumber: Number(row.rowNumber) || index + 2,
    fullName: String(row.fullName ?? '').trim(),
    email: String(row.email ?? '').trim().toLowerCase(),
    phone: String(row.phone ?? '').replace(/\s/g, ''),
    birthDate: birthDate(row.birthDate),
  }))
  const emailCounts = new Map<string, number>()
  const phoneCounts = new Map<string, number>()
  for (const row of normalized) {
    if (row.email) emailCounts.set(row.email, (emailCounts.get(row.email) ?? 0) + 1)
    if (row.phone) phoneCounts.set(row.phone, (phoneCounts.get(row.phone) ?? 0) + 1)
  }
  return normalized.map((row) => {
    const errors: string[] = []
    if (!row.fullName) errors.push('Thiếu họ tên')
    else if (row.fullName.length > 150) errors.push('Họ tên vượt quá 150 ký tự')
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(row.email)) errors.push('Email không hợp lệ')
    if (!/^0\d{9}$/.test(row.phone)) errors.push('Số điện thoại phải gồm 10 chữ số')
    if (row.birthDate && !isValidBirthDate(row.birthDate)) errors.push('Ngày sinh không hợp lệ')
    if ((emailCounts.get(row.email) ?? 0) > 1) errors.push('Email bị trùng trong file')
    if ((phoneCounts.get(row.phone) ?? 0) > 1) errors.push('Số điện thoại bị trùng trong file')
    return { ...row, errors }
  })
}
