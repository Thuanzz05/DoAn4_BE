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

export function canMarkAttendance(status: string, hasStarted: boolean): boolean {
  return status !== 'da_huy' && hasStarted
}

export function canEditSession(status: string, hasStarted: boolean): boolean {
  return status === 'da_huy' || (status === 'da_len_lich' && !hasStarted)
}

export function canCancelSession(status: string, hasStarted: boolean): boolean {
  return status === 'da_len_lich' && !hasStarted
}

export function shouldSyncTeacherAssignment(
  currentTeacherId: number | null,
  nextTeacherId: number | null,
  generatedSessions: number,
): boolean {
  return generatedSessions > 0 && nextTeacherId !== null && currentTeacherId !== nextTeacherId
}

export function canChangeClassPlan(
  generatedSessions: number,
  currentStartDate: string,
  currentSessions: number,
  nextStartDate: string,
  nextSessions: number,
): boolean {
  return generatedSessions === 0
    || (currentStartDate === nextStartDate && currentSessions === nextSessions)
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
  if (!Number.isInteger(totalSessions) || totalSessions < 1 || !slots.length || Number.isNaN(cursor.getTime()) || dateText(cursor) !== startDate) return []
  if (slots.some((slot) => !Number.isInteger(slot.dayOfWeek) || slot.dayOfWeek < 1 || slot.dayOfWeek > 7
    || !/^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/.test(slot.startTime)
    || !/^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/.test(slot.endTime) || slot.endTime <= slot.startTime)) return []
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
