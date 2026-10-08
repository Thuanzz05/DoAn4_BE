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
  let emailSkipped = 0
  for (const invoice of invoices) {
    let kind = reminderType(Number(invoice.daysLeft))
    if (!kind) continue
    const connection = await pool.getConnection()
    let created = false
    let emailClaimed = false
    let email = invoice.email
    let fullName = invoice.fullName
    try {
      await connection.beginTransaction()
      const [current] = await connection.query<RowDataPacket[]>(
        `SELECT hd.id, hv.email, hv.ho_ten AS fullName,
           DATEDIFF(hd.han_thanh_toan, CURDATE()) AS daysLeft FROM hoa_don hd JOIN ghi_danh gd ON gd.id = hd.ghi_danh_id
         JOIN nguoi_dung hv ON hv.id = gd.hoc_vien_id
         WHERE hd.id = ? AND hd.trang_thai = 'chua_thanh_toan' AND hd.han_thanh_toan = ?
           AND gd.trang_thai NOT IN ('da_huy', 'bao_luu') AND hv.dang_hoat_dong = TRUE FOR UPDATE`,
        [invoice.id, invoice.dueDate],
      )
      kind = current.length ? reminderType(Number(current[0].daysLeft)) : null
      if (kind) {
        email = String(current[0].email); fullName = String(current[0].fullName)
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
        // ponytail: lease 1 giờ đủ cho SMTP timeout 20 giây; dùng hàng đợi nếu cần nhiều worker hoặc bảo đảm giao email mạnh hơn.
        const [claim] = await connection.execute<ResultSetHeader>(
          `UPDATE nhac_hoc_phi SET email_thu_luc = NOW(), email_loi = NULL
           WHERE hoa_don_id = ? AND han_thanh_toan = ? AND loai = ? AND email_da_gui_luc IS NULL
             AND (email_thu_luc IS NULL OR email_thu_luc <= DATE_SUB(NOW(), INTERVAL 1 HOUR))`,
          [invoice.id, invoice.dueDate, kind],
        )
        emailClaimed = claim.affectedRows > 0
      }
      await connection.commit()
    } catch (error) { await connection.rollback(); throw error } finally { connection.release() }
    if (created) sent += 1
    if (emailClaimed) {
      let delivered = false
      let emailError: string | null = null
      try {
        delivered = await emailSender(email, fullName, { code: invoice.code, courseName: invoice.courseName,
          amount: Number(invoice.amount), dueDate: invoice.dueDate, overdue: kind === 'qua_han' })
      } catch { emailFailures += 1; emailError = 'Gửi email chưa thành công; hệ thống sẽ thử lại sau 1 giờ.' }
      if (delivered) emailed += 1
      else if (!emailError) { emailSkipped += 1; emailError = 'SMTP chưa cấu hình; thông báo trong hệ thống đã được lưu.' }
      await pool.execute(
        `UPDATE nhac_hoc_phi SET email_da_gui_luc = IF(?, NOW(), email_da_gui_luc), email_loi = ?
         WHERE hoa_don_id = ? AND han_thanh_toan = ? AND loai = ?`,
        [delivered, emailError, invoice.id, invoice.dueDate, kind],
      )
    }
  }
  return { sent, emailed, emailFailures, emailSkipped }
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
