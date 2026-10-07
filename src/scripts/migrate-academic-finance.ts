import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { database } from '../config/database'
import { env } from '../config/env'

async function main() {
  for (const filename of ['20261007_lich_su_ky_thi.sql', '20261007_nhac_hoc_phi.sql']) {
    await database.query(await readFile(join(process.cwd(), 'database/migrations', filename), 'utf8'))
    console.log(`${env.dbName}: đã kiểm tra/tạo bảng từ ${filename}`)
  }
}

main().catch((error: unknown) => {
  console.error('Không thể cập nhật bảng học vụ/học phí:', error)
  process.exitCode = 1
}).finally(() => database.end())
