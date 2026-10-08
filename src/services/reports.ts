import ExcelJS from 'exceljs'
import PDFDocument from 'pdfkit'
import type { RowDataPacket } from 'mysql2/promise'
import { database } from '../config/database'
import { getReportPeriod } from '../utils/operations'
import { HttpError } from '../utils/http-error'
import { fontPath } from './certificate-pdf'

type ReportRow = RowDataPacket & Record<string, string | number | null>
export type ReportData = {
  period: { start: string; end: string }
  selection: { period: 'month' | 'quarter' | 'year'; year: number; unit: number }
  metrics: Record<string, string | number | null>
  academicMetrics: { passed: number; failed: number; pending: number }
  revenueByMonth: ReportRow[]; languageShare: ReportRow[]; coursePerformance: ReportRow[]; classPerformance: ReportRow[]
}

export async function getReportData(periodValue: unknown, yearValue: unknown, unitValue: unknown): Promise<ReportData> {
  const now = new Date()
  const periodName = periodValue ?? 'month'
  const year = Number(yearValue ?? now.getFullYear())
  const unit = Number(unitValue ?? (periodName === 'quarter' ? Math.floor(now.getMonth() / 3) + 1 : now.getMonth() + 1))
  const period = getReportPeriod(periodName, year, unit)
  if (!period) throw new HttpError(400, 'Kỳ báo cáo không hợp lệ')
  const params = [period.start, period.end]
  const [[metrics], [counts], [revenueByMonth], [languageShare], [coursePerformance], [classPerformance]] = await Promise.all([
    database.query<ReportRow[]>(
      `SELECT COALESCE(SUM(CASE WHEN trang_thai = 'da_thanh_toan' AND ngay_thanh_toan >= ?
          AND ngay_thanh_toan < ? THEN so_tien ELSE 0 END), 0) AS revenue,
        COALESCE(SUM(CASE WHEN trang_thai = 'chua_thanh_toan' AND ngay_lap >= ?
          AND ngay_lap < ? THEN so_tien ELSE 0 END), 0) AS debt FROM hoa_don`, [...params, ...params]),
    database.query<ReportRow[]>(
      `SELECT (SELECT COUNT(DISTINCT hoc_vien_id) FROM ghi_danh WHERE ngay_ghi_danh >= ?
          AND ngay_ghi_danh < ? AND trang_thai <> 'da_huy') AS students,
        (SELECT COUNT(*) FROM lop_hoc WHERE trang_thai = 'dang_hoc') AS activeClasses,
        (SELECT COUNT(*) FROM chung_chi WHERE trang_thai = 'da_cap' AND ngay_cap >= ? AND ngay_cap < ?) AS certificates`,
      [...params, ...params]),
    database.query<ReportRow[]>(
      `SELECT DATE_FORMAT(ngay_thanh_toan, '%Y-%m') AS month, SUM(so_tien) AS revenue
       FROM hoa_don WHERE trang_thai = 'da_thanh_toan' AND ngay_thanh_toan >= ? AND ngay_thanh_toan < ?
       GROUP BY month ORDER BY month`, params),
    database.query<ReportRow[]>(
      `SELECT k.ngoai_ngu AS language, COUNT(DISTINCT gd.hoc_vien_id) AS students
       FROM ghi_danh gd JOIN khoa_hoc k ON k.id = gd.khoa_hoc_id WHERE gd.ngay_ghi_danh >= ?
         AND gd.ngay_ghi_danh < ? AND gd.trang_thai <> 'da_huy' GROUP BY k.ngoai_ngu ORDER BY students DESC`, params),
    database.query<ReportRow[]>(
      `SELECT k.id, k.ten_khoa_hoc AS courseName,
        (SELECT COUNT(*) FROM lop_hoc l WHERE l.khoa_hoc_id = k.id) AS classes,
        (SELECT COUNT(DISTINCT gd.hoc_vien_id) FROM ghi_danh gd WHERE gd.khoa_hoc_id = k.id
          AND gd.ngay_ghi_danh >= ? AND gd.ngay_ghi_danh < ? AND gd.trang_thai <> 'da_huy') AS students,
        (SELECT ROUND(100 * SUM(gd.trang_thai = 'hoan_thanh') / NULLIF(COUNT(*), 0), 0)
          FROM ghi_danh gd WHERE gd.khoa_hoc_id = k.id AND gd.ngay_ghi_danh >= ?
            AND gd.ngay_ghi_danh < ? AND gd.trang_thai <> 'da_huy') AS completion,
        (SELECT COALESCE(SUM(hd.so_tien), 0) FROM hoa_don hd JOIN ghi_danh gd ON gd.id = hd.ghi_danh_id
          WHERE gd.khoa_hoc_id = k.id AND hd.trang_thai = 'da_thanh_toan'
            AND hd.ngay_thanh_toan >= ? AND hd.ngay_thanh_toan < ?) AS revenue
       FROM khoa_hoc k ORDER BY revenue DESC`, [...params, ...params, ...params]),
    database.query<ReportRow[]>(
      `SELECT result.classId AS id, l.ma_lop AS classCode, l.ten_lop AS className, k.ten_khoa_hoc AS courseName,
        COUNT(*) AS students,
        SUM(result.ready = 1 AND result.average >= 5) AS passed,
        SUM(result.ready = 1 AND result.average < 5) AS failed,
        SUM(result.ready = 0) AS pending,
        ROUND(AVG(CASE WHEN result.ready = 1 THEN result.average END), 2) AS average
       FROM (
         SELECT gd.lop_hoc_id AS classId,
           (gd.trang_thai = 'hoan_thanh' AND COUNT(kt.id) > 0 AND
             COUNT(kt.id) = COUNT(CASE WHEN kq.nghe IS NOT NULL AND kq.noi IS NOT NULL
               AND kq.doc IS NOT NULL AND kq.viet IS NOT NULL THEN 1 END)) AS ready,
           AVG(CASE WHEN kq.nghe IS NOT NULL AND kq.noi IS NOT NULL AND kq.doc IS NOT NULL
             AND kq.viet IS NOT NULL THEN (kq.nghe + kq.noi + kq.doc + kq.viet) / 4 END) AS average
         FROM ghi_danh gd LEFT JOIN ky_thi kt ON kt.lop_hoc_id = gd.lop_hoc_id AND kt.da_huy = FALSE
         LEFT JOIN ket_qua_thi kq ON kq.ky_thi_id = kt.id AND kq.ghi_danh_id = gd.id
         WHERE gd.ngay_ghi_danh >= ? AND gd.ngay_ghi_danh < ? AND gd.trang_thai <> 'da_huy'
           AND gd.lop_hoc_id IS NOT NULL GROUP BY gd.id, gd.lop_hoc_id, gd.trang_thai
       ) result JOIN lop_hoc l ON l.id = result.classId JOIN khoa_hoc k ON k.id = l.khoa_hoc_id
       GROUP BY result.classId, l.ma_lop, l.ten_lop, k.ten_khoa_hoc ORDER BY l.ma_lop`, params),
  ])
  const academicMetrics = classPerformance.reduce((total, row) => ({ passed: total.passed + Number(row.passed),
    failed: total.failed + Number(row.failed), pending: total.pending + Number(row.pending) }), { passed: 0, failed: 0, pending: 0 })
  return { period, selection: { period: periodName as 'month' | 'quarter' | 'year', year, unit },
    metrics: { ...metrics[0], ...counts[0] }, academicMetrics, revenueByMonth, languageShare, coursePerformance, classPerformance }
}

function reportSections(data: ReportData) {
  return [
    { name: 'Tổng quan', headers: ['Chỉ tiêu', 'Giá trị'], rows: [
      ['Doanh thu đã thanh toán trong kỳ (đồng)', Number(data.metrics.revenue)],
      ['Công nợ hiện tại của hóa đơn lập trong kỳ (đồng)', Number(data.metrics.debt)],
      ['Học viên ghi danh trong kỳ', Number(data.metrics.students)],
      ['Lớp đang học hiện tại', Number(data.metrics.activeClasses)],
      ['Chứng chỉ cấp trong kỳ', Number(data.metrics.certificates)],
      ['Ghi danh đạt', data.academicMetrics.passed], ['Ghi danh không đạt', data.academicMetrics.failed],
      ['Ghi danh chưa có kết quả', data.academicMetrics.pending],
    ] },
    { name: 'Doanh thu', headers: ['Tháng', 'Doanh thu (đồng)'], rows: data.revenueByMonth.map((r) => [r.month, Number(r.revenue)]) },
    { name: 'Ngoại ngữ', headers: ['Ngoại ngữ', 'Học viên ghi danh trong kỳ'], rows: data.languageShare.map((r) => [r.language, Number(r.students)]) },
    { name: 'Khóa học', headers: ['Khóa học', 'Số lớp toàn bộ', 'Học viên trong kỳ', 'Hoàn thành (%)', 'Doanh thu trong kỳ (đồng)'],
      rows: data.coursePerformance.map((r) => [r.courseName, Number(r.classes), Number(r.students), r.completion === null ? null : Number(r.completion), Number(r.revenue)]) },
    { name: 'Kết quả theo lớp', headers: ['Mã lớp', 'Lớp', 'Khóa học', 'Ghi danh trong kỳ', 'Đạt', 'Không đạt', 'Chưa có kết quả', 'Điểm TB'],
      rows: data.classPerformance.map((r) => [r.classCode, r.className, r.courseName, Number(r.students), Number(r.passed), Number(r.failed), Number(r.pending), r.average === null ? null : Number(r.average)]) },
  ]
}

export async function createReportExcel(data: ReportData): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook()
  workbook.creator = 'Trung tâm ngoại ngữ'
  for (const section of reportSections(data)) {
    const sheet = workbook.addWorksheet(section.name)
    sheet.addRow([`Báo cáo từ ${data.period.start} đến trước ${data.period.end}`])
    sheet.addRow(['Kết quả đào tạo: ghi danh trong kỳ; đạt khi hoàn thành lớp, đủ mọi kỳ thi và điểm trung bình từ 5.'])
    sheet.addRow(section.headers)
    section.rows.forEach((row) => sheet.addRow(row))
    sheet.getRow(3).font = { bold: true, color: { argb: 'FFFFFFFF' } }
    sheet.getRow(3).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF092C28' } }
    sheet.views = [{ state: 'frozen', ySplit: 3 }]
    sheet.autoFilter = { from: { row: 3, column: 1 }, to: { row: 3, column: section.headers.length } }
    sheet.columns.forEach((column, index) => { column.width = index === 0 ? 42 : 25 })
    sheet.eachRow((row, rowNumber) => {
      row.alignment = { vertical: 'middle', wrapText: true }
      if (rowNumber > 3) row.eachCell((cell) => { if (typeof cell.value === 'number') cell.numFmt = '#,##0.##' })
    })
    sheet.getRow(1).font = { bold: true, size: 14 }
    sheet.getRow(2).height = 36
    sheet.mergeCells(1, 1, 1, Math.max(2, section.headers.length))
    sheet.mergeCells(2, 1, 2, Math.max(2, section.headers.length))
  }
  return Buffer.from(await workbook.xlsx.writeBuffer())
}

export async function createReportPdf(data: ReportData): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const document = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 32, info: { Title: 'Báo cáo đào tạo', Author: 'Trung tâm ngoại ngữ' } })
    const chunks: Buffer[] = []
    document.on('data', (chunk: Buffer) => chunks.push(chunk))
    document.on('end', () => resolve(Buffer.concat(chunks)))
    document.on('error', reject)
    document.font(fontPath()).fillColor('#092c28').fontSize(18).text('BÁO CÁO TRUNG TÂM NGOẠI NGỮ')
    document.fontSize(10).text(`Từ ${data.period.start} đến trước ${data.period.end}`)
    document.fontSize(9).text('Kết quả của ghi danh trong kỳ: hoàn thành lớp + đủ kỳ thi + điểm TB từ 5 = đạt; thiếu dữ liệu = chưa có kết quả.')
    document.moveDown()
    for (const section of reportSections(data)) {
      if (document.y > document.page.height - 110) document.addPage()
      document.fontSize(12).fillColor('#092c28').text(section.name)
      const width = document.page.width - 64
      const columnWidth = width / section.headers.length
      const renderRow = (cells: Array<string | number | null>, header = false) => {
        const values = cells.map((v) => v === null ? '—' : typeof v === 'number' ? v.toLocaleString('vi-VN', { maximumFractionDigits: 2 }) : String(v))
        document.fontSize(8)
        const height = Math.max(24, ...values.map((v) => document.heightOfString(v, { width: columnWidth - 10 }) + 12))
        if (document.y + height > document.page.height - 32) {
          document.addPage()
          if (!header) renderRow(section.headers, true)
        }
        const top = document.y
        if (header) document.rect(32, top, width, height).fill('#e6efeb')
        values.forEach((value, index) => { document.fillColor('#092c28').text(value, 37 + index * columnWidth, top + 6,
          { width: columnWidth - 10, height: height - 6, lineBreak: true }) })
        document.moveTo(32, top + height).lineTo(32 + width, top + height).lineWidth(0.3).strokeColor('#cbd8d1').stroke()
        document.y = top + height
        document.x = 32
      }
      renderRow(section.headers, true)
      if (section.rows.length) section.rows.forEach((row) => renderRow(row))
      else renderRow(['Không có dữ liệu trong kỳ', ...section.headers.slice(1).map(() => '')])
      document.moveDown()
    }
    document.end()
  })
}
