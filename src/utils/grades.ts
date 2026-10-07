export function isValidScore(value: unknown): boolean {
  if (typeof value !== 'number' && (typeof value !== 'string' || value.trim() === '')) return false
  const score = Number(value)
  return Number.isFinite(score) && score >= 0 && score <= 10
}

export function isValidDraftScore(value: unknown): boolean {
  return value === null || isValidScore(value)
}
