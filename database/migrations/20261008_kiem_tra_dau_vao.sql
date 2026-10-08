-- Kiểm tra đầu vào thủ công, độc lập với ghi danh và kỳ thi; giữ nguyên khóa học đề xuất lúc ghi nhận.
CREATE TABLE IF NOT EXISTS kiem_tra_dau_vao (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  hoc_vien_id BIGINT UNSIGNED NOT NULL,
  ngay_danh_gia DATE NOT NULL,
  ngoai_ngu VARCHAR(50) NOT NULL,
  diem DECIMAL(4,2) NOT NULL,
  trinh_do VARCHAR(50) NOT NULL,
  khoa_hoc_de_xuat_id BIGINT UNSIGNED NULL,
  ma_khoa_hoc_luc_de_xuat VARCHAR(30) NULL,
  ten_khoa_hoc_luc_de_xuat VARCHAR(150) NULL,
  ngoai_ngu_luc_de_xuat VARCHAR(50) NULL,
  trinh_do_luc_de_xuat VARCHAR(50) NULL,
  ghi_chu VARCHAR(1000) NULL,
  trang_thai ENUM('da_ghi_nhan', 'da_huy') NOT NULL DEFAULT 'da_ghi_nhan',
  nguoi_danh_gia_id BIGINT UNSIGNED NOT NULL,
  ngay_tao DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  nguoi_huy_id BIGINT UNSIGNED NULL,
  ngay_huy DATETIME NULL,
  ly_do_huy VARCHAR(255) NULL,
  KEY idx_kiem_tra_hoc_vien (hoc_vien_id, ngay_danh_gia, id),
  CONSTRAINT fk_kiem_tra_hoc_vien FOREIGN KEY (hoc_vien_id) REFERENCES nguoi_dung(id),
  CONSTRAINT fk_kiem_tra_nguoi_danh_gia FOREIGN KEY (nguoi_danh_gia_id) REFERENCES nguoi_dung(id),
  CONSTRAINT fk_kiem_tra_nguoi_huy FOREIGN KEY (nguoi_huy_id) REFERENCES nguoi_dung(id),
  CONSTRAINT fk_kiem_tra_khoa_de_xuat FOREIGN KEY (khoa_hoc_de_xuat_id) REFERENCES khoa_hoc(id) ON DELETE SET NULL,
  CONSTRAINT chk_kiem_tra_diem CHECK (diem BETWEEN 0 AND 10),
  CONSTRAINT chk_kiem_tra_khoa_snapshot CHECK (
    (ma_khoa_hoc_luc_de_xuat IS NULL AND ten_khoa_hoc_luc_de_xuat IS NULL
      AND ngoai_ngu_luc_de_xuat IS NULL AND trinh_do_luc_de_xuat IS NULL)
    OR (ma_khoa_hoc_luc_de_xuat IS NOT NULL AND ten_khoa_hoc_luc_de_xuat IS NOT NULL
      AND ngoai_ngu_luc_de_xuat IS NOT NULL AND trinh_do_luc_de_xuat IS NOT NULL)
  ),
  CONSTRAINT chk_kiem_tra_huy CHECK (
    (trang_thai = 'da_ghi_nhan' AND nguoi_huy_id IS NULL AND ngay_huy IS NULL AND ly_do_huy IS NULL)
    OR (trang_thai = 'da_huy' AND nguoi_huy_id IS NOT NULL AND ngay_huy IS NOT NULL AND ly_do_huy IS NOT NULL)
  )
) ENGINE=InnoDB;
