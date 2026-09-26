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
- `GET/POST/PATCH /api/users`: quản lý giáo viên, học viên và trạng thái tài khoản.
- `GET/POST/PATCH/DELETE /api/rooms`: quản lý phòng học.
- `GET/POST/PATCH /api/classes`: quản lý lớp và phân công giáo viên.
- `GET/POST/PATCH /api/enrollments`: ghi danh, xếp lớp và tự tạo hóa đơn.
- `GET/POST/PATCH/DELETE /api/schedules`: xếp lịch, kiểm tra trùng phòng/giáo viên.
- `POST /api/classes/:id/generate-sessions`: sinh các buổi học từ lịch hàng tuần.
- `GET/POST/PATCH /api/invoices`: quản lý hóa đơn, thanh toán và hủy hóa đơn.
- `GET /api/certificates/candidates`: danh sách và điều kiện xét cấp chứng chỉ.
- `POST /api/certificates/approve`: phê duyệt học viên đủ điều kiện.
- `PATCH /api/certificates/:id/issue`: cấp chứng chỉ sau khi có tệp PDF.
- `GET /api/certificates/verify/:code`: tra cứu công khai mã xác thực chứng chỉ.
- `GET /api/reports`: báo cáo doanh thu, công nợ và đào tạo theo kỳ.
- `GET /api/teacher/dashboard|classes|sessions`: dữ liệu giảng dạy của giáo viên đăng nhập.
- `GET/PUT /api/teacher/sessions/:id/attendance`: xem và lưu điểm danh cả lớp.
- `GET/POST /api/teacher/classes/:id/exams`: xem và tạo kỳ thi cho lớp phụ trách.
- `GET/PUT /api/teacher/exams/:id/results`: xem và lưu điểm bốn kỹ năng.
- `GET /api/student/dashboard|classes|sessions`: tổng quan và lịch học của học viên đăng nhập.
- `GET /api/student/results|invoices|certificates`: kết quả, học phí và chứng chỉ cá nhân.
- `POST /api/student/certificates/:id/download`: ghi nhận và trả thông tin tải chứng chỉ PDF.
- `POST /api/ai/tu-van-khoa-hoc`: AI tư vấn từ khóa học đang mở trong MySQL.

API cần đăng nhập sử dụng header `Authorization: Bearer <JWT>`.

## Gmail và Google login

- Gmail yêu cầu bật xác minh hai bước và tạo App Password, rồi điền `SMTP_USER`, `SMTP_PASSWORD`.
- Tạo OAuth Web Client ID trong Google Cloud và điền `GOOGLE_CLIENT_ID`.
- Khi chưa cấu hình SMTP ở môi trường development, API quên mật khẩu trả thêm `devCode` để kiểm thử.

## Kiểm tra và build

```bash
npm run type-check
npm test
npm run build
npm start
```
