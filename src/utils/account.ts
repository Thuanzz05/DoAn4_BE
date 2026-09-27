import { randomBytes } from 'node:crypto'

export function isValidPassword(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 8
}

export function generateTemporaryPassword(): string {
  return `Tk1!${randomBytes(8).toString('base64url')}`
}

export function isValidBirthDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const [year, month, day] = value.split('-').map(Number)
  const parsed = new Date(Date.UTC(year, month - 1, day))
  return parsed.getUTCFullYear() === year
    && parsed.getUTCMonth() === month - 1
    && parsed.getUTCDate() === day
    && value <= new Date().toISOString().slice(0, 10)
}
