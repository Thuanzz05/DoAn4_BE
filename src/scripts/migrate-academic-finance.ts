import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { RowDataPacket } from 'mysql2/promise'
import { database } from '../config/database'
import { env } from '../config/env'

async function main() {
  for (const filename of ['20261007_lich_su_ky_thi.sql', '20261007_nhac_hoc_phi.sql', '20261008_ngoai_le_hoc_vu.sql', '20261008_thu_lai_email_hoc_phi.sql']) {
    const sql = await readFile(join(process.cwd(), 'database/migrations', filename), 'utf8')
    // ponytail: các migration này chỉ dùng SQL đơn giản, không có dấu ; trong chuỗi hay stored procedure.
    for (const statement of sql.replace(/^--.*$/gm, '').split(';').map((part) => part.trim()).filter(Boolean)) {
      const addedColumn = statement.match(/^ALTER TABLE (\w+) ADD COLUMN (\w+) /i)
      if (addedColumn) {
        const [rows] = await database.query<RowDataPacket[]>(
          'SELECT 1 FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?',
          [addedColumn[1], addedColumn[2]],
        )
        if (rows.length) continue
      }
      await database.query(statement)
    }
    console.log(`${env.dbName}: đã kiểm tra/tạo bảng từ ${filename}`)
  }
}

main().catch((error: unknown) => {
  console.error('Không thể cập nhật bảng học vụ/học phí:', error)
  process.exitCode = 1
}).finally(() => database.end())
