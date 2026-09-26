export function isValidScore(value: unknown): boolean {
  const score = Number(value)
  return value !== null && value !== '' && Number.isFinite(score) && score >= 0 && score <= 10
}
