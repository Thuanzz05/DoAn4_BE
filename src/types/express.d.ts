type VaiTro = 'quan_tri' | 'giao_vien' | 'hoc_vien'

declare global {
  namespace Express {
    interface Request {
      auth?: {
        userId: number
        role: VaiTro
        sessionVersion: number
      }
    }
  }
}

export {}
