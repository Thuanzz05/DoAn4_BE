export type ReportPeriod = { start: string; end: string }
export type NotificationTarget = { userId: number; role: null } | { userId: null; role: 'quan_tri' | 'giao_vien' | 'hoc_vien' }

function dateText(date: Date): string {
  return date.toISOString().slice(0, 10)
}

export function getReportPeriod(
  period: unknown,
  yearValue: unknown,
  unitValue: unknown,
): ReportPeriod | null {
  const year = Number(yearValue)
  const unit = Number(unitValue)
  if (!Number.isInteger(year) || year < 2000 || year > 2100) return null

  if (period === 'month' && Number.isInteger(unit) && unit >= 1 && unit <= 12) {
    return {
      start: dateText(new Date(Date.UTC(year, unit - 1, 1))),
      end: dateText(new Date(Date.UTC(year, unit, 1))),
    }
  }
  if (period === 'quarter' && Number.isInteger(unit) && unit >= 1 && unit <= 4) {
    const month = (unit - 1) * 3
    return {
      start: dateText(new Date(Date.UTC(year, month, 1))),
      end: dateText(new Date(Date.UTC(year, month + 3, 1))),
    }
  }
  if (period === 'year') {
    return { start: `${year}-01-01`, end: `${year + 1}-01-01` }
  }
  return null
}

export function isCertificateEligible(input: {
  enrollmentStatus: string
  paid: boolean
  attendance: number
  average: number | null
  requiredExams: number
  completedExams: number
}): boolean {
  return getCertificateEligibilityReasons(input).length === 0
}

export function getCertificateEligibilityReasons(input: {
  enrollmentStatus: string
  paid: boolean
  attendance: number
  average: number | null
  requiredExams: number
  completedExams: number
}): string[] {
  const reasons: string[] = []
  if (input.enrollmentStatus !== 'hoan_thanh') reasons.push('Chưa hoàn thành khóa học')
  if (!input.paid) reasons.push('Chưa hoàn tất học phí')
  if (input.attendance < 80) reasons.push('Tỷ lệ chuyên cần dưới 80%')
  if (input.requiredExams === 0) reasons.push('Lớp học chưa có kỳ thi')
  else if (input.completedExams < input.requiredExams) reasons.push(`Chưa hoàn thành tất cả kỳ thi (${input.completedExams}/${input.requiredExams})`)
  else if (input.average === null) reasons.push('Chưa có đủ điểm thi')
  else if (input.average < 5) reasons.push('Điểm trung bình dưới 5')
  return reasons
}

export function getNotificationTarget(userIdValue: unknown, roleValue: unknown): NotificationTarget | null {
  const userId = Number(userIdValue)
  const hasUser = Number.isInteger(userId) && userId > 0
  const hasRole = typeof roleValue === 'string' && ['quan_tri', 'giao_vien', 'hoc_vien'].includes(roleValue)
  if (hasUser === hasRole) return null
  return hasUser
    ? { userId, role: null }
    : { userId: null, role: roleValue as 'quan_tri' | 'giao_vien' | 'hoc_vien' }
}
