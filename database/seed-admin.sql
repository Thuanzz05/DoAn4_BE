USE doan4;

-- Tài khoản: admin@trungtam.vn
-- Mật khẩu ban đầu: Admin@123
-- Chạy đúng một lần, sau đó đổi mật khẩu khi đăng nhập.
INSERT INTO nguoi_dung (
  ma_nguoi_dung,
  ho_ten,
  email,
  mat_khau_bam,
  vai_tro,
  dang_hoat_dong
) VALUES (
  'QT-001',
  'Quản trị viên',
  'admin@trungtam.vn',
  '$2b$12$wyOmL54WUzbX5I8nx3RdGuT1I0xY.jk433wOVNsSu3BvwpclnM2FK',
  'quan_tri',
  TRUE
);

SELECT id, ma_nguoi_dung, ho_ten, email, vai_tro, dang_hoat_dong
FROM nguoi_dung
WHERE ma_nguoi_dung = 'QT-001';
