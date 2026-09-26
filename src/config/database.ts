import mysql from 'mysql2/promise'
import { env } from './env'

export const database = mysql.createPool({
  host: env.dbHost,
  port: env.dbPort,
  user: env.dbUser,
  password: env.dbPassword,
  database: env.dbName,
  charset: 'utf8mb4',
  connectionLimit: 10,
  decimalNumbers: true,
})

export async function checkDatabase(): Promise<void> {
  await database.query('SELECT 1')
}
