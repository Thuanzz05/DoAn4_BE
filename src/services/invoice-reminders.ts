import type { Pool, ResultSetHeader, RowDataPacket } from 'mysql2/promise'
import { database } from '../config/database'
import { sendInvoiceReminder } from './mailer'

type InvoiceReminder = RowDataPacket & {
  id: number; studentId: number; email: string; fullName: string; code: string;
  courseName: string; amount: number; dueDate: string; daysLeft: number;
}

export function reminderType(daysLeft: number): 'sap_den_han' | 'qua_han' | null {
  if (!Number.isInteger(daysLeft) || daysLeft > 3) return null
  return daysLeft < 0 ? 'qua_han' : 'sap_den_han'
}

export async function sendDueInvoiceReminders(classId: number | null = null, pool: Pool = database,
  emailSender: typeof sendInvoiceReminder = sendInvoiceReminder) {
  const [invoices] = await pool.query<InvoiceReminder[]>(
    `SELECT hd.id, hd.ma_hoa_don AS code, hd.so_tien AS amount, hd.han_thanh_toan AS dueDate,
      DATEDIFF(hd.han_thanh_toan, CURDATE()) AS daysLeft, hv.id AS studentId,
      hv.email, hv.ho_ten AS fullName, k.ten_khoa_hoc AS courseName
     FROM hoa_don hd JOIN ghi_danh gd ON gd.id = hd.ghi_danh_id
     JOIN nguoi_dung hv ON hv.id = gd.hoc_vien_id JOIN khoa_hoc k ON k.id = gd.khoa_hoc_id
     WHERE hd.trang_thai = 'chua_thanh_toan' AND hd.han_thanh_toan <= DATE_ADD(CURDATE(), INTERVAL 3 DAY)
       AND gd.trang_thai NOT IN ('da_huy', 'bao_luu') AND hv.dang_hoat_dong = TRUE
       AND (? IS NULL OR gd.lop_hoc_id = ?) ORDER BY hd.id`, [classId, classId],
  )
  let sent = 0
  let emailed = 0
  let emailFailures = 0
  for (const invoice of invoices) {
    const kind = reminderType(Number(invoice.daysLeft))
    if (!kind) continue
    const connection = await pool.getConnection()
    let created = false
    try {
      await connection.beginTransaction()
      const [current] = await connection.query<RowDataPacket[]>(
        `SELECT hd.id FROM hoa_don hd JOIN ghi_danh gd ON gd.id = hd.ghi_danh_id
         JOIN nguoi_dung hv ON hv.id = gd.hoc_vien_id
         WHERE hd.id = ? AND hd.trang_thai = 'chua_thanh_toan' AND hd.han_thanh_toan = ?
           AND gd.trang_thai NOT IN ('da_huy', 'bao_luu') AND hv.dang_hoat_dong = TRUE FOR UPDATE`,
        [invoice.id, invoice.dueDate],
      )
      if (current.length) {
        const [result] = await connection.execute<ResultSetHeader>(
          'INSERT IGNORE INTO nhac_hoc_phi (hoa_don_id, han_thanh_toan, loai) VALUES (?, ?, ?)',
          [invoice.id, invoice.dueDate, kind],
        )
        if (result.affectedRows) {
          const title = kind === 'qua_han' ? 'Học phí quá hạn' : 'Học phí sắp đến hạn'
          const content = `Hóa đơn ${invoice.code} của khóa ${invoice.courseName}, số tiền ${Number(invoice.amount).toLocaleString('vi-VN')} đồng, hạn thanh toán ${invoice.dueDate}. Vui lòng liên hệ trung tâm để hoàn tất học phí.`
          await connection.execute('INSERT INTO thong_bao (nguoi_dung_id, tieu_de, noi_dung) VALUES (?, ?, ?)',
            [invoice.studentId, title, content])
          created = true
        }
      }
      await connection.commit()
    } catch (error) { await connection.rollback(); throw error } finally { connection.release() }
    if (created) {
      sent += 1
      try {
        if (await emailSender(invoice.email, invoice.fullName, { code: invoice.code, courseName: invoice.courseName,
          amount: Number(invoice.amount), dueDate: invoice.dueDate, overdue: kind === 'qua_han' })) emailed += 1
      } catch { emailFailures += 1 }
    }
  }
  return { sent, emailed, emailFailures }
}

export function startInvoiceReminderJob(): () => void {
  let running = false
  let stopped = false
  const run = async () => {
    if (running || stopped) return
    running = true
    try { await sendDueInvoiceReminders() } catch (error) { console.error('Không thể nhắc học phí:', error) }
    finally { running = false }
  }
  // ponytail: một lượt quét mỗi giờ cho một trung tâm; dùng hàng đợi nếu có lượng hóa đơn lớn.
  const timer = setInterval(() => { void run() }, 60 * 60 * 1000)
  timer.unref()
  void run()
  return () => { stopped = true; clearInterval(timer) }
}
