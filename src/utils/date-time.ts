export function normalizeLocalDateTime(value: string): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(value)
  if (!match) return null
  const [, year, month, day, hour, minute, second = '00'] = match
  const parts = [year, month, day, hour, minute, second].map(Number)
  const parsed = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2], parts[3], parts[4], parts[5]))
  if ([parsed.getUTCFullYear(), parsed.getUTCMonth() + 1, parsed.getUTCDate(), parsed.getUTCHours(), parsed.getUTCMinutes(), parsed.getUTCSeconds()]
    .some((part, index) => part !== parts[index])) return null
  return `${year}-${month}-${day} ${hour}:${minute}:${second}`
}
