CREATE DATABASE IF NOT EXISTS doan4
  CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE doan4;

CREATE TABLE IF NOT EXISTS nguoi_dung (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  ma_nguoi_dung VARCHAR(20) NOT NULL UNIQUE,
  ho_ten VARCHAR(150) NOT NULL,
  email VARCHAR(255) NOT NULL UNIQUE,
  so_dien_thoai VARCHAR(20) UNIQUE,
  mat_khau_bam VARCHAR(255) NULL,
  google_sub VARCHAR(255) NULL UNIQUE,
  vai_tro ENUM('quan_tri', 'giao_vien', 'hoc_vien') NOT NULL,
  dang_hoat_dong BOOLEAN NOT NULL DEFAULT TRUE,
  phien_ban_dang_nhap INT UNSIGNED NOT NULL DEFAULT 0,
  ngay_sinh DATE NULL,
  ngon_ngu_giang_day VARCHAR(50) NULL,
  chuyen_mon VARCHAR(150) NULL,
  ngay_tao DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ngay_cap_nhat DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT chk_cach_dang_nhap CHECK (mat_khau_bam IS NOT NULL OR google_sub IS NOT NULL)
) ENGINE=InnoDB;

-- Mã OTP gửi qua email/Gmail, chỉ lưu mã HMAC-SHA256, không lưu mã gốc.
CREATE TABLE IF NOT EXISTS ma_dat_lai_mat_khau (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  nguoi_dung_id BIGINT UNSIGNED NOT NULL,
  ma_hmac CHAR(64) NOT NULL,
  het_han_luc DATETIME NOT NULL,
  so_lan_nhap_sai TINYINT UNSIGNED NOT NULL DEFAULT 0,
  da_dung_luc DATETIME NULL,
  ngay_tao DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_ma_dat_lai_nguoi_dung (nguoi_dung_id, ngay_tao),
  CONSTRAINT fk_ma_dat_lai_nguoi_dung FOREIGN KEY (nguoi_dung_id) REFERENCES nguoi_dung(id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS khoa_hoc (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  ma_khoa_hoc VARCHAR(30) NOT NULL UNIQUE,
  ten_khoa_hoc VARCHAR(150) NOT NULL,
  ngoai_ngu VARCHAR(50) NOT NULL,
  trinh_do VARCHAR(50) NOT NULL,
  so_buoi SMALLINT UNSIGNED NOT NULL,
  hoc_phi DECIMAL(12,0) NOT NULL,
  mo_ta TEXT NULL,
  trang_thai ENUM('dang_mo', 'tam_an') NOT NULL DEFAULT 'dang_mo',
  ngay_tao DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT chk_khoa_hoc_so_buoi CHECK (so_buoi > 0),
  CONSTRAINT chk_khoa_hoc_hoc_phi CHECK (hoc_phi > 0)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS phong_hoc (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  ma_phong VARCHAR(20) NOT NULL UNIQUE,
  suc_chua SMALLINT UNSIGNED NOT NULL,
  CONSTRAINT chk_phong_hoc_suc_chua CHECK (suc_chua > 0)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS lop_hoc (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  ma_lop VARCHAR(30) NOT NULL UNIQUE,
  ten_lop VARCHAR(150) NOT NULL,
  khoa_hoc_id BIGINT UNSIGNED NOT NULL,
  giao_vien_id BIGINT UNSIGNED NULL,
  ngay_khai_giang DATE NOT NULL,
  so_buoi SMALLINT UNSIGNED NOT NULL,
  si_so_toi_da SMALLINT UNSIGNED NOT NULL,
  trang_thai ENUM('sap_khai_giang', 'dang_hoc', 'da_ket_thuc', 'da_huy')
    NOT NULL DEFAULT 'sap_khai_giang',
  UNIQUE KEY uq_lop_khoa_hoc (id, khoa_hoc_id),
  CONSTRAINT fk_lop_khoa_hoc FOREIGN KEY (khoa_hoc_id) REFERENCES khoa_hoc(id),
  CONSTRAINT fk_lop_giao_vien FOREIGN KEY (giao_vien_id) REFERENCES nguoi_dung(id),
  CONSTRAINT chk_lop_so_buoi CHECK (so_buoi > 0),
  CONSTRAINT chk_lop_si_so CHECK (si_so_toi_da > 0)
) ENGINE=InnoDB;

-- lop_hoc_id NULL nghĩa là đã ghi danh nhưng chưa xếp lớp.
CREATE TABLE IF NOT EXISTS ghi_danh (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  hoc_vien_id BIGINT UNSIGNED NOT NULL,
  khoa_hoc_id BIGINT UNSIGNED NOT NULL,
  lop_hoc_id BIGINT UNSIGNED NULL,
  ngay_ghi_danh DATE NOT NULL,
  trang_thai ENUM('cho_xep_lop', 'dang_hoc', 'bao_luu', 'hoan_thanh', 'da_huy')
    NOT NULL DEFAULT 'cho_xep_lop',
  KEY idx_ghi_danh_hoc_vien (hoc_vien_id),
  KEY idx_ghi_danh_lop_khoa (lop_hoc_id, khoa_hoc_id),
  CONSTRAINT fk_ghi_danh_hoc_vien FOREIGN KEY (hoc_vien_id) REFERENCES nguoi_dung(id),
  CONSTRAINT fk_ghi_danh_khoa_hoc FOREIGN KEY (khoa_hoc_id) REFERENCES khoa_hoc(id),
  CONSTRAINT fk_ghi_danh_lop_khoa FOREIGN KEY (lop_hoc_id, khoa_hoc_id)
    REFERENCES lop_hoc(id, khoa_hoc_id)
) ENGINE=InnoDB;

-- Thứ trong tuần: 1 = Thứ hai, 7 = Chủ nhật.
CREATE TABLE IF NOT EXISTS lich_hang_tuan (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  lop_hoc_id BIGINT UNSIGNED NOT NULL,
  phong_hoc_id BIGINT UNSIGNED NOT NULL,
  thu_trong_tuan TINYINT UNSIGNED NOT NULL,
  gio_bat_dau TIME NOT NULL,
  gio_ket_thuc TIME NOT NULL,
  KEY idx_lich_phong_thu (phong_hoc_id, thu_trong_tuan),
  CONSTRAINT fk_lich_lop FOREIGN KEY (lop_hoc_id) REFERENCES lop_hoc(id),
  CONSTRAINT fk_lich_phong FOREIGN KEY (phong_hoc_id) REFERENCES phong_hoc(id),
  CONSTRAINT chk_lich_thu CHECK (thu_trong_tuan BETWEEN 1 AND 7),
  CONSTRAINT chk_lich_gio CHECK (gio_ket_thuc > gio_bat_dau)
) ENGINE=InnoDB;

-- Buổi học theo ngày; lưu giáo viên/phòng tại thời điểm diễn ra buổi học.
CREATE TABLE IF NOT EXISTS buoi_hoc (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  lop_hoc_id BIGINT UNSIGNED NOT NULL,
  giao_vien_id BIGINT UNSIGNED NOT NULL,
  phong_hoc_id BIGINT UNSIGNED NOT NULL,
  bat_dau DATETIME NOT NULL,
  ket_thuc DATETIME NOT NULL,
  trang_thai ENUM('da_len_lich', 'da_hoc', 'da_huy') NOT NULL DEFAULT 'da_len_lich',
  KEY idx_buoi_lop_ngay (lop_hoc_id, bat_dau),
  KEY idx_buoi_giao_vien_ngay (giao_vien_id, bat_dau),
  KEY idx_buoi_phong_ngay (phong_hoc_id, bat_dau),
  CONSTRAINT fk_buoi_lop FOREIGN KEY (lop_hoc_id) REFERENCES lop_hoc(id),
  CONSTRAINT fk_buoi_giao_vien FOREIGN KEY (giao_vien_id) REFERENCES nguoi_dung(id),
  CONSTRAINT fk_buoi_phong FOREIGN KEY (phong_hoc_id) REFERENCES phong_hoc(id),
  CONSTRAINT chk_buoi_gio CHECK (ket_thuc > bat_dau)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS diem_danh (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  buoi_hoc_id BIGINT UNSIGNED NOT NULL,
  ghi_danh_id BIGINT UNSIGNED NOT NULL,
  trang_thai ENUM('co_mat', 'di_muon', 'vang') NOT NULL,
  ghi_chu VARCHAR(255) NULL,
  thoi_gian_diem_danh DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_diem_danh_buoi_ghi_danh (buoi_hoc_id, ghi_danh_id),
  CONSTRAINT fk_diem_danh_buoi FOREIGN KEY (buoi_hoc_id) REFERENCES buoi_hoc(id),
  CONSTRAINT fk_diem_danh_ghi_danh FOREIGN KEY (ghi_danh_id) REFERENCES ghi_danh(id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS ky_thi (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  lop_hoc_id BIGINT UNSIGNED NOT NULL,
  ten_ky_thi VARCHAR(100) NOT NULL,
  ngay_thi DATE NULL,
  han_sua_diem DATETIME NULL,
  CONSTRAINT fk_ky_thi_lop FOREIGN KEY (lop_hoc_id) REFERENCES lop_hoc(id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS lich_su_ky_thi (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  ky_thi_id BIGINT UNSIGNED NOT NULL,
  nguoi_thay_doi_id BIGINT UNSIGNED NOT NULL,
  hanh_dong ENUM('tao', 'cap_nhat', 'gia_han') NOT NULL,
  ly_do VARCHAR(255) NOT NULL,
  du_lieu_truoc JSON NULL,
  du_lieu_sau JSON NOT NULL,
  ngay_thay_doi DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_lich_su_ky_thi (ky_thi_id, ngay_thay_doi),
  CONSTRAINT fk_lich_su_ky_thi FOREIGN KEY (ky_thi_id) REFERENCES ky_thi(id),
  CONSTRAINT fk_lich_su_ky_thi_nguoi_dung FOREIGN KEY (nguoi_thay_doi_id) REFERENCES nguoi_dung(id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS ket_qua_thi (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  ky_thi_id BIGINT UNSIGNED NOT NULL,
  ghi_danh_id BIGINT UNSIGNED NOT NULL,
  nghe DECIMAL(4,2) NULL,
  noi DECIMAL(4,2) NULL,
  doc DECIMAL(4,2) NULL,
  viet DECIMAL(4,2) NULL,
  ngay_cap_nhat DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_ket_qua_ky_thi_ghi_danh (ky_thi_id, ghi_danh_id),
  CONSTRAINT fk_ket_qua_ky_thi FOREIGN KEY (ky_thi_id) REFERENCES ky_thi(id),
  CONSTRAINT fk_ket_qua_ghi_danh FOREIGN KEY (ghi_danh_id) REFERENCES ghi_danh(id),
  CONSTRAINT chk_diem_nghe CHECK (nghe BETWEEN 0 AND 10),
  CONSTRAINT chk_diem_noi CHECK (noi BETWEEN 0 AND 10),
  CONSTRAINT chk_diem_doc CHECK (doc BETWEEN 0 AND 10),
  CONSTRAINT chk_diem_viet CHECK (viet BETWEEN 0 AND 10)
) ENGINE=InnoDB;

-- Quá hạn = chưa thanh toán và hạn thanh toán < ngày hiện tại.
CREATE TABLE IF NOT EXISTS hoa_don (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  ma_hoa_don VARCHAR(30) NOT NULL UNIQUE,
  ghi_danh_id BIGINT UNSIGNED NOT NULL,
  so_tien DECIMAL(12,0) NOT NULL,
  ngay_lap DATE NOT NULL,
  han_thanh_toan DATE NOT NULL,
  trang_thai ENUM('chua_thanh_toan', 'da_thanh_toan', 'da_huy')
    NOT NULL DEFAULT 'chua_thanh_toan',
  ngay_thanh_toan DATETIME NULL,
  phuong_thuc ENUM('tien_mat', 'chuyen_khoan') NULL,
  ly_do_huy VARCHAR(255) NULL,
  KEY idx_hoa_don_ghi_danh (ghi_danh_id),
  CONSTRAINT fk_hoa_don_ghi_danh FOREIGN KEY (ghi_danh_id) REFERENCES ghi_danh(id),
  CONSTRAINT chk_hoa_don_so_tien CHECK (so_tien > 0),
  CONSTRAINT chk_hoa_don_han CHECK (han_thanh_toan >= ngay_lap)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS nhac_hoc_phi (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  hoa_don_id BIGINT UNSIGNED NOT NULL,
  han_thanh_toan DATE NOT NULL,
  loai ENUM('sap_den_han', 'qua_han') NOT NULL,
  ngay_tao DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_nhac_hoc_phi (hoa_don_id, han_thanh_toan, loai),
  CONSTRAINT fk_nhac_hoc_phi_hoa_don FOREIGN KEY (hoa_don_id) REFERENCES hoa_don(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- Chưa có bản ghi: chờ xét. Đã duyệt: chưa sinh PDF. Đã cấp: có PDF.
CREATE TABLE IF NOT EXISTS chung_chi (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  ghi_danh_id BIGINT UNSIGNED NOT NULL UNIQUE,
  ma_chung_chi VARCHAR(30) UNIQUE,
  ma_xac_thuc VARCHAR(64) UNIQUE,
  trang_thai ENUM('da_duyet', 'da_cap') NOT NULL DEFAULT 'da_duyet',
  nguoi_duyet_id BIGINT UNSIGNED NOT NULL,
  ngay_duyet DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ngay_cap DATETIME NULL,
  duong_dan_pdf VARCHAR(500) NULL,
  ma_hoc_vien_luc_cap VARCHAR(20) NULL,
  ten_hoc_vien_luc_cap VARCHAR(150) NULL,
  ten_khoa_hoc_luc_cap VARCHAR(150) NULL,
  ngoai_ngu_luc_cap VARCHAR(50) NULL,
  ma_lop_luc_cap VARCHAR(30) NULL,
  ten_lop_luc_cap VARCHAR(150) NULL,
  ho_so_luc_duyet JSON NOT NULL,
  CONSTRAINT fk_chung_chi_ghi_danh FOREIGN KEY (ghi_danh_id) REFERENCES ghi_danh(id),
  CONSTRAINT fk_chung_chi_nguoi_duyet FOREIGN KEY (nguoi_duyet_id) REFERENCES nguoi_dung(id),
  CONSTRAINT chk_chung_chi_ho_so CHECK (
    ma_hoc_vien_luc_cap IS NOT NULL AND ten_hoc_vien_luc_cap IS NOT NULL
    AND ten_khoa_hoc_luc_cap IS NOT NULL AND ngoai_ngu_luc_cap IS NOT NULL
    AND ma_lop_luc_cap IS NOT NULL AND ten_lop_luc_cap IS NOT NULL
  ),
  CONSTRAINT chk_chung_chi_da_cap CHECK (
    trang_thai <> 'da_cap' OR
    (ma_chung_chi IS NOT NULL AND ma_xac_thuc IS NOT NULL
     AND ngay_cap IS NOT NULL AND duong_dan_pdf IS NOT NULL
     AND ma_hoc_vien_luc_cap IS NOT NULL AND ten_hoc_vien_luc_cap IS NOT NULL
     AND ten_khoa_hoc_luc_cap IS NOT NULL AND ngoai_ngu_luc_cap IS NOT NULL
     AND ma_lop_luc_cap IS NOT NULL AND ten_lop_luc_cap IS NOT NULL)
  )
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS luot_tai_chung_chi (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  chung_chi_id BIGINT UNSIGNED NOT NULL,
  thoi_gian_tai DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_luot_tai_chung_chi (chung_chi_id, thoi_gian_tai),
  CONSTRAINT fk_luot_tai_chung_chi FOREIGN KEY (chung_chi_id) REFERENCES chung_chi(id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS thong_bao (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  nguoi_dung_id BIGINT UNSIGNED NOT NULL,
  tieu_de VARCHAR(150) NOT NULL,
  noi_dung TEXT NOT NULL,
  da_doc_luc DATETIME NULL,
  ngay_tao DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_thong_bao_nguoi_dung (nguoi_dung_id, ngay_tao),
  CONSTRAINT fk_thong_bao_nguoi_dung FOREIGN KEY (nguoi_dung_id) REFERENCES nguoi_dung(id)
) ENGINE=InnoDB;

SHOW TABLES;
