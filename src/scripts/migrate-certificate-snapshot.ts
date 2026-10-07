import { readFileSync } from 'node:fs'
import { database } from '../config/database'
import { env } from '../config/env'

async function migrate(): Promise<void> {
  if (env.dbName !== 'doan4') throw new Error('Migration này chỉ dành cho database doan4')
  const connection = await database.getConnection()
  try {
    const [columns] = await connection.query(
      `SELECT COLUMN_NAME FROM information_schema.columns WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = 'chung_chi' AND COLUMN_NAME = 'ho_so_luc_duyet'`,
    )
    if ((columns as unknown[]).length) throw new Error('Cột hồ sơ đã có; không tự chạy lại migration. Kiểm tra trạng thái migration trước.')
    const source = readFileSync('database/migrations/20261007_chot_ho_so_chung_chi.sql', 'utf8')
    for (const sql of source.split(';').filter((value) => value.trim())) await connection.query(sql)
    const [counts] = await connection.query(
      'SELECT COUNT(*) AS certificates, SUM(ho_so_luc_duyet IS NOT NULL) AS frozen FROM chung_chi',
    )
    console.log('Đã chốt hồ sơ chứng chỉ, giữ nguyên dữ liệu và tệp PDF cũ:', counts)
  } finally { connection.release() }
}

migrate().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
}).finally(() => database.end())
