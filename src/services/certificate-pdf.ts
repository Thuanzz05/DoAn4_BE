import { createWriteStream, existsSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import PDFDocument from 'pdfkit'
import { env } from '../config/env'

export type CertificatePdfData = {
  certificateCode: string
  studentName: string
  studentCode: string
  courseName: string
  className: string
  classCode: string
  language: string
  issuedAt: Date
  verificationUrl: string
}

function fontPath(): string {
  const candidates = [
    env.certificateFontPath,
    join(process.env.WINDIR ?? 'C:\\Windows', 'Fonts', 'arial.ttf'),
    '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
    '/usr/share/fonts/truetype/liberation2/LiberationSans-Regular.ttf',
  ].filter(Boolean)
  const found = candidates.find(existsSync)
  if (!found) throw new Error('Không tìm thấy font Unicode. Hãy cấu hình CERTIFICATE_FONT_PATH.')
  return found
}

export async function createCertificatePdf(outputPath: string, data: CertificatePdfData): Promise<void> {
  await mkdir(dirname(outputPath), { recursive: true })
  const font = fontPath()

  await new Promise<void>((resolve, reject) => {
    const document = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 0, info: { Title: data.certificateCode, Author: 'Trung tâm ngoại ngữ' } })
    const output = createWriteStream(outputPath)
    output.on('finish', resolve)
    output.on('error', reject)
    document.on('error', reject)
    document.pipe(output)

    const width = document.page.width
    const height = document.page.height
    const center = { width: width - 120, align: 'center' as const }

    document.rect(0, 0, width, height).fill('#f2f6f0')
    document.lineWidth(2).strokeColor('#092c28').rect(24, 24, width - 48, height - 48).stroke()
    document.lineWidth(0.7).strokeColor('#9eb6aa').rect(32, 32, width - 64, height - 64).stroke()
    document.fillColor('#e9553f').rect(40, 40, 7, height - 80).fill()

    document.fillColor('#092c28').circle(width / 2, 82, 23).fill()
    document.font(font).fillColor('#f2f6f0').fontSize(12).text('TT', width / 2 - 20, 75, { width: 40, align: 'center', characterSpacing: 1 })
    document.fillColor('#385a53').fontSize(10).text('TRUNG TÂM NGOẠI NGỮ', 60, 115, { ...center, characterSpacing: 2.2 })
    document.fillColor('#092c28').fontSize(30).text('CHỨNG CHỈ HOÀN THÀNH', 60, 145, center)
    document.fillColor('#385a53').fontSize(11).text('Trân trọng chứng nhận', 60, 202, center)
    document.fillColor('#092c28').fontSize(29).text(data.studentName, 60, 229, center)
    document.moveTo(235, 270).lineTo(width - 235, 270).lineWidth(0.8).strokeColor('#9eb6aa').stroke()
    document.fillColor('#385a53').fontSize(11).text(`Mã học viên: ${data.studentCode}`, 60, 282, center)
    document.fillColor('#385a53').fontSize(11).text('đã hoàn thành khóa học', 60, 317, center)
    document.fillColor('#092c28').fontSize(21).text(data.courseName, 60, 342, center)
    document.fillColor('#385a53').fontSize(10).text(`Lớp: ${data.className} (${data.classCode})  |  Ngoại ngữ: ${data.language}`, 60, 381, center)

    const issued = new Intl.DateTimeFormat('vi-VN', { day: '2-digit', month: '2-digit', year: 'numeric' }).format(data.issuedAt)
    document.moveTo(100, 450).lineTo(300, 450).lineWidth(0.8).strokeColor('#9eb6aa').stroke()
    document.fillColor('#385a53').fontSize(9).text(`Mã chứng chỉ: ${data.certificateCode}`, 100, 460, { width: 200, align: 'center' })
    document.moveTo(width - 300, 450).lineTo(width - 100, 450).stroke()
    document.fillColor('#385a53').fontSize(9).text(`Ngày cấp: ${issued}`, width - 300, 460, { width: 200, align: 'center' })
    document.fillColor('#6b827b').fontSize(7.5).text(`Xác thực: ${data.verificationUrl}`, 80, height - 76, { width: width - 160, align: 'center' })

    document.end()
  })
}
