# BE_DoAn4

Backend Node.js + TypeScript + Express + MySQL cho hệ thống quản lý trung tâm ngoại ngữ.

## Chạy lần đầu

1. Chạy `database/schema.sql` trong MySQL Workbench để tạo database `doan4`.
2. Chạy `npm install`.
3. Sao chép `.env.example` thành `.env`, nhập `DB_PASSWORD` và các khóa cần dùng.
4. Đặt `ADMIN_PASSWORD` trong `.env`, sau đó chạy `npm run create-admin` đúng một lần.
5. Chạy `npm run dev`.

Backend mặc định: `http://localhost:3000`. Kiểm tra bằng `GET /api/health`.

## API đã có

- `POST /api/auth/register`: đăng ký học viên.
- `POST /api/auth/login`: đăng nhập email/mã người dùng và mật khẩu.
- `POST /api/auth/google`: đăng nhập hoặc đăng ký bằng Google ID token.
- `POST /api/auth/google/link`: liên kết Google cho người dùng đã đăng nhập.
- `POST /api/auth/forgot-password`: gửi OTP đặt lại mật khẩu qua email.
- `POST /api/auth/reset-password`: xác nhận OTP và đổi mật khẩu.
- `GET /api/auth/me`: thông tin tài khoản hiện tại.
- `GET /api/courses`: danh sách khóa học đang mở.
- `GET /api/courses/all`: toàn bộ khóa học, chỉ quản trị viên.
- `POST/PATCH/DELETE /api/courses`: quản lý khóa học, chỉ quản trị viên.
- `POST /api/ai/tu-van-khoa-hoc`: AI tư vấn từ khóa học đang mở trong MySQL.

API cần đăng nhập sử dụng header `Authorization: Bearer <JWT>`.

## Gmail và Google login

- Gmail yêu cầu bật xác minh hai bước và tạo App Password, rồi điền `SMTP_USER`, `SMTP_PASSWORD`.
- Tạo OAuth Web Client ID trong Google Cloud và điền `GOOGLE_CLIENT_ID`.
- Khi chưa cấu hình SMTP ở môi trường development, API quên mật khẩu trả thêm `devCode` để kiểm thử.

## Kiểm tra và build

```bash
npm run type-check
npm run build
npm start
```
