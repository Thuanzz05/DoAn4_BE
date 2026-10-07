import { randomUUID } from 'node:crypto'
import bcrypt from 'bcryptjs'
import ExcelJS from 'exceljs'
import express, { Router } from 'express'
import type { PoolConnection, ResultSetHeader, RowDataPacket } from 'mysql2/promise'
import { database } from '../config/database'
import { requireAuth, requireRole } from '../middlewares/auth'
import { validateImportedStudents, normalizeHeader, type ImportedStudentRow } from '../utils/enrollment-import'
import { HttpError } from '../utils/http-error'
import { ensureEnrollmentClass } from '../utils/enrollment'
import { parseTuitionAmount } from '../utils/operations'
import { generateTemporaryPassword } from '../utils/account'
import { deliverAccountInformation } from '../services/mailer'

type SimpleRow = RowDataPacket & Record<string, string | number | null>
type QueryConnection = PoolConnection | typeof database

export const enrollmentImportRouter = Router()
enrollmentImportRouter.use(requireAuth, requireRole('quan_tri'))

function positiveInt(value: unknown, label: string): number {
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < 1) throw new HttpError(400, `${label} phải là số nguyên dương`)
  return parsed
}

function optionalPositiveInt(value: unknown, label: string): number | null {
  return value === undefined || value === null || value === '' ? null : positiveInt(value, label)
}

function cellValue(value: unknown): string | number | Date {
  if (value instanceof Date || typeof value === 'string' || typeof value === 'number') return value
  if (!value || typeof value !== 'object') return ''
  if ('text' in value) return String(value.text ?? '')
  if ('result' in value) return cellValue(value.result)
  if ('richText' in value && Array.isArray(value.richText)) {
    return value.richText.map((part: { text?: string }) => part.text ?? '').join('')
  }
  return ''
}

const headerFields = new Map<string, 'fullName' | 'email' | 'phone' | 'birthDate'>([
  ['hoten', 'fullName'], ['fullname', 'fullName'], ['email', 'email'],
  ['sodienthoai', 'phone'], ['dienthoai', 'phone'], ['phone', 'phone'],
  ['ngaysinh', 'birthDate'], ['birthdate', 'birthDate'],
])

async function readWorkbook(buffer: Buffer): Promise<Array<Record<string, unknown>>> {
  const workbook = new ExcelJS.Workbook()
  try {
    await workbook.xlsx.load(buffer)
  } catch {
    throw new HttpError(400, 'File Excel không hợp lệ hoặc đã bị hỏng')
  }
  const worksheet = workbook.worksheets[0]
  if (!worksheet) throw new HttpError(400, 'File Excel không có trang dữ liệu')
  const columns = new Map<number, 'fullName' | 'email' | 'phone' | 'birthDate'>()
  worksheet.getRow(1).eachCell({ includeEmpty: true }, (cell, column) => {
    const field = headerFields.get(normalizeHeader(String(cellValue(cell.value))))
    if (field) columns.set(column, field)
  })
  const requiredHeaders = { fullName: 'Họ tên', email: 'Email', phone: 'Số điện thoại' } as const
  for (const [field, label] of Object.entries(requiredHeaders)) {
    if (![...columns.values()].includes(field as 'fullName' | 'email' | 'phone')) {
      throw new HttpError(400, `File Excel thiếu cột ${label}`)
    }
  }
  const rows: Array<Record<string, unknown>> = []
  worksheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return
    const item: Record<string, unknown> = { rowNumber }
    for (const [column, field] of columns) item[field] = cellValue(row.getCell(column).value)
    if (Object.values(item).slice(1).some((value) => String(value).trim())) rows.push(item)
  })
  if (!rows.length) throw new HttpError(400, 'File Excel không có học viên')
  if (rows.length > 100) throw new HttpError(400, 'Mỗi lần chỉ được import tối đa 100 học viên')
  return rows
}

async function addDatabaseErrors(rows: ImportedStudentRow[], connection: QueryConnection): Promise<ImportedStudentRow[]> {
  const emails = [...new Set(rows.map((row) => row.email).filter(Boolean))]
  const phones = [...new Set(rows.map((row) => row.phone).filter(Boolean))]
  if (!emails.length && !phones.length) return rows
  const conditions: string[] = []
  const values: string[] = []
  if (emails.length) {
    conditions.push(`email IN (${emails.map(() => '?').join(',')})`)
    values.push(...emails)
  }
  if (phones.length) {
    conditions.push(`so_dien_thoai IN (${phones.map(() => '?').join(',')})`)
    values.push(...phones)
  }
  const [existing] = await connection.query<SimpleRow[]>(
    `SELECT email, so_dien_thoai AS phone FROM nguoi_dung WHERE ${conditions.join(' OR ')}`,
    values,
  )
  const existingEmails = new Set(existing.map((item) => String(item.email).toLowerCase()))
  const existingPhones = new Set(existing.map((item) => String(item.phone)))
  return rows.map((row) => ({
    ...row,
    errors: [
      ...row.errors,
      ...(existingEmails.has(row.email) ? ['Email đã tồn tại trong hệ thống'] : []),
      ...(existingPhones.has(row.phone) ? ['Số điện thoại đã tồn tại trong hệ thống'] : []),
    ],
  }))
}

async function ensureTarget(
  connection: QueryConnection,
  courseId: number,
  classId: number | null,
  students: number,
  lock = false,
): Promise<number> {
  const [courses] = await connection.query<SimpleRow[]>(
    `SELECT hoc_phi AS tuition FROM khoa_hoc WHERE id = ? AND trang_thai = 'dang_mo'${lock ? ' FOR UPDATE' : ''}`,
    [courseId],
  )
  if (!courses[0]) throw new HttpError(400, 'Khóa học không tồn tại hoặc đã tạm ẩn')
  if (parseTuitionAmount(courses[0].tuition) === null) throw new HttpError(409, 'Khóa học phải có học phí nguyên dương hợp lệ trước khi ghi danh')
  if (classId) {
    await ensureEnrollmentClass(connection, classId, courseId, students, 0, lock)
  }
  return Number(courses[0].tuition)
}

enrollmentImportRouter.get('/template', async (_request, response) => {
  const workbook = new ExcelJS.Workbook()
  const worksheet = workbook.addWorksheet('Hoc vien')
  worksheet.columns = [
    { header: 'Họ tên', key: 'fullName', width: 28 },
    { header: 'Email', key: 'email', width: 32 },
    { header: 'Số điện thoại', key: 'phone', width: 18 },
    { header: 'Ngày sinh', key: 'birthDate', width: 16 },
  ]
  worksheet.getRow(1).font = { bold: true }
  worksheet.getColumn('phone').numFmt = '@'
  worksheet.getColumn('birthDate').numFmt = '@'
  worksheet.views = [{ state: 'frozen', ySplit: 1 }]
  response.set({
    'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'Content-Disposition': 'attachment; filename="mau-import-hoc-vien.xlsx"',
  })
  response.send(Buffer.from(await workbook.xlsx.writeBuffer()))
})

enrollmentImportRouter.post(
  '/preview',
  express.raw({ type: () => true, limit: '5mb' }),
  async (request, response) => {
    if (!Buffer.isBuffer(request.body) || !request.body.length) throw new HttpError(400, 'File Excel là bắt buộc')
    const courseId = positiveInt(request.query.courseId, 'Khóa học')
    const classId = optionalPositiveInt(request.query.classId, 'Lớp học')
    let rows = validateImportedStudents(await readWorkbook(request.body))
    rows = await addDatabaseErrors(rows, database)
    const valid = rows.filter((row) => !row.errors.length).length
    await ensureTarget(database, courseId, classId, valid)
    response.json({ success: true, data: { total: rows.length, valid, invalid: rows.length - valid, rows } })
  },
)

enrollmentImportRouter.post('/confirm', async (request, response) => {
  const courseId = positiveInt(request.body.courseId, 'Khóa học')
  const classId = optionalPositiveInt(request.body.classId, 'Lớp học')
  if (!Array.isArray(request.body.rows) || !request.body.rows.length) throw new HttpError(400, 'Danh sách học viên là bắt buộc')
  if (request.body.rows.length > 100) throw new HttpError(400, 'Mỗi lần chỉ được import tối đa 100 học viên')
  let rows = validateImportedStudents(request.body.rows)
  if (rows.some((row) => row.errors.length)) throw new HttpError(400, 'Danh sách học viên còn dữ liệu không hợp lệ')
  const accounts = await Promise.all(rows.map(async (row) => {
    const temporaryPassword = generateTemporaryPassword()
    return { ...row, temporaryPassword, passwordHash: await bcrypt.hash(temporaryPassword, 12) }
  }))
  const connection = await database.getConnection()
  let released = false
  try {
    await connection.beginTransaction()
    rows = await addDatabaseErrors(rows, connection)
    if (rows.some((row) => row.errors.length)) throw new HttpError(409, 'Email hoặc số điện thoại đã tồn tại trong hệ thống')
    const tuition = await ensureTarget(connection, courseId, classId, rows.length, true)
    const created = []
    for (const account of accounts) {
      const code = `HV-${randomUUID().replaceAll('-', '').slice(0, 12).toUpperCase()}`
      const [user] = await connection.execute<ResultSetHeader>(
        `INSERT INTO nguoi_dung
         (ma_nguoi_dung, ho_ten, email, so_dien_thoai, mat_khau_bam, vai_tro, ngay_sinh)
         VALUES (?, ?, ?, ?, ?, 'hoc_vien', ?)`,
        [code, account.fullName, account.email, account.phone, account.passwordHash, account.birthDate],
      )
      const status = classId ? 'dang_hoc' : 'cho_xep_lop'
      const [enrollment] = await connection.execute<ResultSetHeader>(
        `INSERT INTO ghi_danh (hoc_vien_id, khoa_hoc_id, lop_hoc_id, ngay_ghi_danh, trang_thai)
         VALUES (?, ?, ?, CURDATE(), ?)`,
        [user.insertId, courseId, classId, status],
      )
      const invoiceCode = `HD-${new Date().getFullYear()}-${randomUUID().replaceAll('-', '').slice(0, 12).toUpperCase()}`
      await connection.execute(
        `INSERT INTO hoa_don (ma_hoa_don, ghi_danh_id, so_tien, ngay_lap, han_thanh_toan)
         VALUES (?, ?, ?, CURDATE(), DATE_ADD(CURDATE(), INTERVAL 14 DAY))`,
        [invoiceCode, enrollment.insertId, tuition],
      )
      await connection.execute("INSERT INTO thong_bao (nguoi_dung_id, tieu_de, noi_dung) VALUES (?, 'Ghi danh khóa học mới', ?)", [user.insertId, `Bạn đã được ghi danh và tạo hóa đơn ${invoiceCode}.`])
      created.push({
        studentId: user.insertId, enrollmentId: enrollment.insertId, code,
        email: account.email, temporaryPassword: account.temporaryPassword, invoiceCode,
      })
    }
    await connection.commit()
    connection.release()
    released = true
    const delivered = await Promise.all(created.map(async ({ temporaryPassword, ...account }, index) => ({
      ...account,
      ...await deliverAccountInformation(account.email, accounts[index].fullName, temporaryPassword, 'hoc_vien'),
    })))
    response.status(201).json({ success: true, data: { created: delivered.length, accounts: delivered } })
  } catch (error) {
    if (!released) await connection.rollback()
    if ((error as { code?: string }).code === 'ER_DUP_ENTRY') throw new HttpError(409, 'Dữ liệu bị trùng, vui lòng xem trước lại file')
    throw error
  } finally {
    if (!released) connection.release()
  }
})
