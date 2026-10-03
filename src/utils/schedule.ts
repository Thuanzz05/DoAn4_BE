export type WeeklySlot = {
  dayOfWeek: number
  startTime: string
  endTime: string
  roomId: number
}

export type GeneratedSession = {
  roomId: number
  startsAt: string
  endsAt: string
}

export function roomCanHostClass(roomCapacity: number, classCapacity: number): boolean {
  return Number.isInteger(roomCapacity) && Number.isInteger(classCapacity)
    && roomCapacity > 0 && classCapacity > 0 && roomCapacity >= classCapacity
}

function dateText(date: Date): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

export function generateSessionDates(
  startDate: string,
  totalSessions: number,
  slots: WeeklySlot[],
): GeneratedSession[] {
  const [year, month, day] = startDate.split('-').map(Number)
  const cursor = new Date(year, month - 1, day)
  if (!Number.isInteger(totalSessions) || totalSessions < 1 || !slots.length || Number.isNaN(cursor.getTime())) return []
  const orderedSlots = [...slots].sort((a, b) => a.startTime.localeCompare(b.startTime))
  const sessions: GeneratedSession[] = []

  for (let offset = 0; sessions.length < totalSessions && offset < 730; offset += 1) {
    const current = new Date(cursor)
    current.setDate(cursor.getDate() + offset)
    // MySQL DAYOFWEEK và giao diện cùng dùng 1=Chủ nhật, 2=Thứ hai, ..., 7=Thứ bảy.
    const dayOfWeek = current.getDay() === 0 ? 1 : current.getDay() + 1
    for (const slot of orderedSlots.filter((item) => item.dayOfWeek === dayOfWeek)) {
      const date = dateText(current)
      sessions.push({
        roomId: slot.roomId,
        startsAt: `${date} ${slot.startTime}`,
        endsAt: `${date} ${slot.endTime}`,
      })
      if (sessions.length === totalSessions) break
    }
  }
  return sessions
}
