# BE_DoAn4

Backend Node.js + TypeScript + Express + MySQL cho hệ thống quản lý trung tâm ngoại ngữ.

## Chạy lần đầu

1. Chạy `database/schema.sql` trong MySQL Workbench để tạo database `doan4`.
2. Chạy `npm install`.
3. Sao chép `.env.example` thành `.env`, nhập `DB_PASSWORD` và các khóa cần dùng.
4. Đặt `ADMIN_PASSWORD` trong `.env`, sau đó chạy `npm run create-admin` đúng một lần.
5. Chạy `npm run dev`.

Nếu nâng cấp từ phiên bản cũ đã có dữ liệu, chạy một lần
`database/migrations/20261003_toan_ven_chung_chi.sql` trong MySQL Workbench trước khi khởi động backend.
Sau đó chạy một lần `database/migrations/20261007_chot_ho_so_chung_chi.sql` để chốt hồ sơ từ lúc duyệt.
Chạy `npm run migrate:academic-finance` để thêm lịch sử học vụ, bảng chống trùng thông báo và các cột theo dõi/thử lại email học phí.
Lệnh này tạo các bảng lịch sử/nhắc phí còn thiếu, thêm cột hủy kỳ thi nháp và lịch sử buổi học.
Có thể chạy lại an toàn; không xóa dữ liệu, không sửa điểm hoặc điểm danh hiện có.

Quản trị viên xử lý buổi học tồn đọng tại **Lớp học → Chi tiết → Buổi học**:
bổ sung điểm danh còn thiếu hoặc hủy buổi thực tế nghỉ khi chưa có điểm danh, rồi xếp học bù.
Mọi thao tác cần lý do và lưu lịch sử; không ghi đè điểm danh cũ hoặc đổi giáo viên của buổi quá khứ.
Không khóa giáo viên khi còn điểm danh tồn đọng. Kỳ thi nháp chỉ được hủy khi chưa có kết quả
và chưa chốt hồ sơ chứng chỉ; kỳ thi đã hủy vẫn giữ lịch sử, không tính vào nghĩa vụ thi.

Backend mặc định: `http://localhost:3000`. Kiểm tra bằng `GET /api/health`.

## Thử API bằng Swagger

Chạy `npm run dev`, mở `http://localhost:3000/api-docs/`.

1. Chọn `POST /auth/login`, bấm **Try it out**, nhập `account` (email/mã người dùng) và `password`, rồi **Execute**.
2. Sao chép `data.token` từ kết quả, bấm **Authorize** và dán JWT, không thêm chữ `Bearer`.
3. Thử `GET /auth/me` rồi chọn các API tương ứng vai trò quản trị viên, giáo viên hoặc học viên.

Các API tạo/sửa/xóa và gửi email tác động dữ liệu thật; ID ví dụ cần thay bằng ID từ API danh sách.
OpenAPI JSON: `http://localhost:3000/api-docs/openapi.json`.
Swagger chỉ được mở ở môi trường không phải production, không lưu JWT sau khi tải lại trang.

## API đã có

- `POST /api/auth/register`: đăng ký học viên.
- `POST /api/auth/login`: đăng nhập email/mã người dùng và mật khẩu.
- `POST /api/auth/google`: đăng nhập hoặc đăng ký bằng Google ID token.
- `POST /api/auth/google/link`: liên kết Google cho người dùng đã đăng nhập.
- `POST /api/auth/forgot-password`: gửi OTP đặt lại mật khẩu qua email.
- `POST /api/auth/reset-password`: xác nhận OTP và đổi mật khẩu.
- `GET /api/auth/me`: thông tin tài khoản hiện tại.
- `PATCH /api/auth/me`: cập nhật họ tên, số điện thoại và ngày sinh.
- `PATCH /api/auth/password`: đổi hoặc đặt mật khẩu, đồng thời vô hiệu hóa JWT cũ.
- `POST /api/auth/logout`: đăng xuất và vô hiệu hóa các phiên đăng nhập hiện tại.
- `DELETE /api/auth/google/link`: gỡ liên kết Google khi tài khoản đã có mật khẩu.
- `GET /api/courses`: danh sách khóa học đang mở.
- `GET /api/courses/all`: toàn bộ khóa học, chỉ quản trị viên.
- `POST/PATCH/DELETE /api/courses`: quản lý khóa học, chỉ quản trị viên.
- `GET/POST/PATCH /api/users`: quản lý giáo viên, học viên và trạng thái tài khoản.
- `POST /api/users/:id/reset-password`: quản trị viên cấp mật khẩu tạm và vô hiệu hóa phiên đăng nhập cũ.
- `DELETE /api/users/:id`: xóa tài khoản giáo viên/học viên chưa phát sinh dữ liệu nghiệp vụ.
- `GET/POST/PATCH/DELETE /api/rooms`: quản lý phòng học.
- `GET/POST/PATCH /api/classes`: quản lý lớp và phân công giáo viên.
- `GET/POST/PATCH /api/enrollments`: ghi danh, xếp lớp và tự tạo hóa đơn.
- `GET /api/enrollments/import/template`: tải file Excel mẫu để import học viên.
- `POST /api/enrollments/import/preview?courseId=&classId=`: đọc file `.xlsx` và xem lỗi từng dòng.
- `POST /api/enrollments/import/confirm`: tạo hàng loạt tài khoản, ghi danh và hóa đơn; gửi thông tin đăng nhập qua email sau khi lưu thành công. Nếu không gửi được, trả mật khẩu tạm để quản trị viên bàn giao.
- `GET/POST/PATCH/DELETE /api/schedules`: xếp lịch, kiểm tra trùng phòng/giáo viên.
- `POST /api/classes/:id/generate-sessions`: sinh các buổi học từ lịch hàng tuần.
- `GET /api/classes/:id/academic` và `/export?section=all|attendance|grades`: danh sách học viên, chuyên cần, điểm danh thiếu và điểm toàn khóa; xuất Excel cùng nguồn dữ liệu.
- `GET/PUT /api/sessions/:id/attendance`: quản trị viên xem và bổ sung điểm danh còn thiếu, bắt buộc lý do, không ghi đè dữ liệu cũ.
- `PATCH /api/sessions/:id`, `POST /api/sessions/:id/cancel`: dời/xếp học bù hoặc hủy buổi chưa có điểm danh; lưu lý do và lịch sử trước/sau.
- `GET /api/sessions/:id/history`: lịch sử xử lý buổi học.
- `GET/POST /api/exams`, `PATCH /api/exams/:id`: quản trị viên quản lý kỳ thi và hạn sửa điểm; bắt buộc lý do, chặn thay đổi sau khi chốt chứng chỉ.
- `GET /api/exams/:id/history`: lịch sử thay đổi, người thực hiện, lý do và dữ liệu trước/sau.
- `POST /api/exams/:id/cancel`: hủy kỳ thi chưa có kết quả, giữ lịch sử và loại khỏi điều kiện chứng chỉ.
- `GET/POST/PATCH /api/invoices`: quản lý hóa đơn, thanh toán và hủy hóa đơn.
- `POST /api/invoices/reminders`: quét nhắc học phí đến hạn/quá hạn, không gửi thông báo trùng cho cùng hóa đơn, hạn và giai đoạn.
- `GET /api/certificates/candidates`: danh sách và điều kiện xét cấp chứng chỉ.
- `POST /api/certificates/approve`: phê duyệt học viên đủ điều kiện.
- `PATCH /api/certificates/:id/issue`: tự tạo PDF và phát hành chứng chỉ đã duyệt.
- `PATCH /api/certificates/:id/details`: đính chính thông tin hồ sơ **chưa phát hành**, bắt buộc lý do; lưu dấu vết trước/sau, không đổi điều kiện học tập.
- `POST /api/certificates/:id/reissue`: tạo lại PDF, giữ nguyên nội dung, mã xác thực và ngày cấp gốc.
- `GET /api/certificates/:id/corrections`: lịch sử đính chính dành cho quản trị viên.
- `GET /api/certificates/verify/:code`: tra cứu công khai mã xác thực chứng chỉ.
- `GET /api/reports`: báo cáo doanh thu, công nợ và đào tạo theo kỳ.
- `GET /api/reports/export?period=month|quarter|year&year=&unit=&format=xlsx|pdf`: xuất đầy đủ số liệu báo cáo theo tháng/quý/năm bất kỳ. Đạt/trượt xét học viên đã hoàn thành và đủ điểm tất cả kỳ thi; hồ sơ còn thiếu được ghi nhận riêng.
- `GET /api/admin/dashboard`: số liệu tổng quan dành cho quản trị viên.
- `GET/PATCH /api/notifications`: xem và đánh dấu thông báo đã đọc.
- `GET /api/notifications?paginated=true&page=&pageSize=`: phân trang thông báo và tổng số chưa đọc; `PATCH /api/notifications/read-all` với `{ "ids": [...] }` chỉ đánh dấu các thông báo đã tải.
- `POST /api/notifications`: quản trị viên gửi thông báo cho người dùng hoặc vai trò.
- `GET /api/teacher/dashboard|classes|sessions`: dữ liệu giảng dạy của giáo viên đăng nhập.
- `GET/PUT /api/teacher/sessions/:id/attendance`: xem và lưu điểm danh cả lớp.
- `GET/POST /api/teacher/classes/:id/exams`: xem và tạo kỳ thi cho lớp phụ trách.
- `GET /api/teacher/classes/:id/academic` và `/export?section=all|attendance|grades`: thống kê và Excel toàn khóa, chỉ cho lớp giáo viên phụ trách.
- `GET/PUT /api/teacher/exams/:id/results`: xem và lưu điểm bốn kỹ năng; chỉ học viên đã hoàn tất học phí được dự thi.
- `GET /api/student/dashboard|classes|sessions`: tổng quan và lịch học của học viên đăng nhập.
- `GET /api/student/results|invoices|certificates`: kết quả, học phí và chứng chỉ cá nhân.
- `GET /api/student/certificate-eligibility`: xem điều kiện và lý do chưa đủ điều kiện nhận chứng chỉ.
- `POST /api/student/certificates/:id/download`: ghi nhận và trả thông tin tải chứng chỉ PDF.
- `POST /api/ai/tu-van-khoa-hoc`: AI tư vấn từ khóa học đang mở trong MySQL.

API cần đăng nhập sử dụng header `Authorization: Bearer <JWT>`.

PDF chứng chỉ được lưu trong `STORAGE_DIR/certificates` và phục vụ qua `PUBLIC_URL`. Khi triển khai trên Linux, cấu hình `CERTIFICATE_FONT_PATH` tới một font `.ttf` hỗ trợ tiếng Việt.

## Chính sách nghiệp vụ

- Ghi danh học trọn khóa; xếp/chuyển lớp, bảo lưu hoặc hủy chỉ trước khi lớp bắt đầu học và chưa có lịch sử. Bảo lưu giải phóng chỗ, tiếp tục bằng một lớp chưa bắt đầu của cùng khóa.
- Buổi hủy không tính vào chuyên cần; học bù xếp lại chính buổi đã hủy. Chuyên cần lấy số buổi thực tế đã đến giờ làm mẫu số, không lấy số bản ghi điểm danh. Thiếu điểm danh thì chưa đủ điều kiện chứng chỉ.
- Bốn kỹ năng chấm 0–10; `null` là chưa nhập, `0` là điểm thật. Cho lưu bản nháp, chỉ kỳ thi đủ bốn điểm mới hoàn thành. Tất cả kỳ thi có trọng số bằng nhau; chuyên cần 80% là điều kiện chứng chỉ, không phải điều kiện dự thi.
- Thu trọn học phí bằng tiền mặt/chuyển khoản; chưa hỗ trợ miễn phí, trả góp hay hoàn tiền. Hóa đơn lập lại giữ số tiền đã chốt lúc ghi danh, không phụ thuộc học phí khóa được sửa sau đó.
- Duyệt chứng chỉ chốt tên/mã/khóa/lớp, điểm, chuyên cần và học phí; khóa thêm kỳ thi và sửa dữ liệu đã chốt. Đính chính thông tin chỉ trước phát hành; chứng chỉ đã cấp không sửa trực tiếp. Cấp lại là tạo lại PDF cùng thông tin, không phải đính chính hoặc cấp chứng chỉ mới.

## Gmail và Google login

- Gmail yêu cầu bật xác minh hai bước và tạo App Password, rồi điền `SMTP_USER`, `SMTP_PASSWORD`.
- Tạo OAuth Web Client ID trong Google Cloud và điền `GOOGLE_CLIENT_ID`.
- Khi chưa cấu hình SMTP ở môi trường development, API quên mật khẩu trả thêm `devCode` để kiểm thử.
- Tạo tài khoản giáo viên/học viên gửi email thông tin đăng nhập sau khi lưu; nếu SMTP chưa cấu hình hoặc lỗi, dữ liệu vẫn được giữ và quản trị viên nhận thông tin bàn giao một lần.
- Đặt `INVOICE_REMINDERS_ENABLED=true` để tự quét học phí lúc khởi động và mỗi giờ khi backend đang chạy. Nhắc một lần khi còn tối đa 3 ngày, một lần khi quá hạn; bỏ qua ghi danh đã hủy/bảo lưu và tài khoản bị khóa. Thông báo trong hệ thống hoạt động dù chưa cấu hình SMTP. Email chưa ghi nhận thành công được thử lại tối đa mỗi giờ, không tạo thêm thông báo; hóa đơn đã thanh toán/hủy không gửi lại. Đổi hạn thanh toán bắt đầu chu kỳ nhắc mới.
- Theo dõi email qua `nhac_hoc_phi.email_thu_luc`, `email_da_gui_luc`, `email_loi`. SMTP và database không có giao dịch chung: nếu SMTP đã nhận nhưng kết nối bị ngắt, lần thử lại có thể gửi trùng email. Lịch sử cũ chưa có dấu gửi thành công cũng có thể được thử lại một lần; thông báo trong hệ thống vẫn chống trùng.
- CORS development chấp nhận `localhost` và `127.0.0.1` trên đúng giao thức/port của `CLIENT_URL`; production chỉ chấp nhận origin đã cấu hình, không dùng wildcard.

## Kiểm tra và build

```bash
npm run type-check
npm test
npm run build
npm start
```

Kiểm thử luồng API đầy đủ trên **database tạm riêng** (cần quyền CREATE/DROP DATABASE của tài khoản MySQL):

```powershell
$env:RUN_BUSINESS_INTEGRATION='1'
npm run test:integration
Remove-Item Env:RUN_BUSINESS_INTEGRATION
```

Kiểm thử không ghi vào `doan4`, tự dọn database `doan4_test_<mã ngẫu nhiên>` và PDF tạm khi kết thúc.
Hai luồng mới có kiểm thử MySQL riêng: đặt `RUN_ACADEMIC_INTEGRATION=1` khi chạy `npx tsx --test src/academic-flow.test.ts`, hoặc `RUN_FINANCE_INTEGRATION=1` khi chạy `npx tsx --test src/services/finance-flow.test.ts`. Chúng cũng tạo và dọn database tạm, không gửi email thật.
