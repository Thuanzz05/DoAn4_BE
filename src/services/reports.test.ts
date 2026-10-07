import assert from 'node:assert/strict'
import test from 'node:test'
import ExcelJS from 'exceljs'
import { createReportExcel, createReportPdf, type ReportData } from './reports'

test('báo cáo Excel/PDF chứa đủ bảng và giữ điểm 0 khác chưa có kết quả', async () => {
  const data: ReportData = {
    period: { start: '2026-10-01', end: '2026-11-01' }, selection: { period: 'month', year: 2026, unit: 10 },
    metrics: { revenue: 1000, debt: 2000, students: 2, activeClasses: 1, certificates: 0 },
    academicMetrics: { passed: 0, failed: 1, pending: 1 }, revenueByMonth: [], languageShare: [], coursePerformance: [],
    classPerformance: [{ id: 1, classCode: 'A1', className: 'Tiếng Anh A1', courseName: 'Tiếng Anh', students: 2,
      passed: 0, failed: 1, pending: 1, average: 0 }] as ReportData['classPerformance'],
  }
  const bytes = await createReportExcel(data)
  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.load(bytes as unknown as Parameters<typeof workbook.xlsx.load>[0])
  assert.deepEqual(workbook.worksheets.map((sheet) => sheet.name), ['Tổng quan', 'Doanh thu', 'Ngoại ngữ', 'Khóa học', 'Kết quả theo lớp'])
  const classes = workbook.getWorksheet('Kết quả theo lớp')!
  assert.equal(classes.getCell('H4').value, 0)
  assert.equal(classes.getCell('F4').value, 1)
  assert.equal(classes.getCell('G4').value, 1)
  const pdf = await createReportPdf(data)
  assert.equal(pdf.subarray(0, 4).toString(), '%PDF')
  assert.ok(pdf.length > 2000)
})
