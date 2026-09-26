export type ReportPeriod = { start: string; end: string }

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
}): boolean {
  return input.enrollmentStatus === 'hoan_thanh'
    && input.paid
    && input.attendance >= 80
    && input.average !== null
    && input.average >= 5
}
