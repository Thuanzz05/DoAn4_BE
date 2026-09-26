import bcrypt from 'bcryptjs'
import type { ResultSetHeader } from 'mysql2'
import { database } from '../config/database'

async function main(): Promise<void> {
  const name = process.env.ADMIN_NAME?.trim() || 'Quản trị viên'
  const email = process.env.ADMIN_EMAIL?.trim().toLowerCase()
  const password = process.env.ADMIN_PASSWORD
  if (!email || !password || password.length < 8) {
    throw new Error('Hãy đặt ADMIN_EMAIL và ADMIN_PASSWORD (ít nhất 8 ký tự) trong .env')
  }

  const passwordHash = await bcrypt.hash(password, 12)
  const [result] = await database.execute<ResultSetHeader>(
    `INSERT INTO nguoi_dung (ma_nguoi_dung, ho_ten, email, mat_khau_bam, vai_tro)
     VALUES ('QT-001', ?, ?, ?, 'quan_tri')`,
    [name, email, passwordHash],
  )
  console.log(`Đã tạo quản trị viên id=${result.insertId}, email=${email}`)
}

main()
  .catch((error: unknown) => {
    console.error(error)
    process.exitCode = 1
  })
  .finally(() => database.end())
