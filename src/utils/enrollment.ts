export type EnrollmentStatus = 'cho_xep_lop' | 'dang_hoc' | 'bao_luu' | 'hoan_thanh' | 'da_huy'

const transitions: Record<EnrollmentStatus, EnrollmentStatus[]> = {
  cho_xep_lop: ['dang_hoc', 'da_huy'],
  dang_hoc: ['bao_luu', 'da_huy'],
  bao_luu: ['dang_hoc', 'da_huy'],
  hoan_thanh: [],
  da_huy: [],
}

export const canChangeEnrollmentStatus = (current: EnrollmentStatus, next: EnrollmentStatus) => current === next || transitions[current].includes(next)
