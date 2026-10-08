-- Chọn database doan4 trước khi chạy. Không xóa dữ liệu hoặc sửa điểm danh cũ.
-- ADD COLUMN chỉ chạy một lần; npm run migrate:academic-finance tự bỏ qua cột đã tồn tại.
ALTER TABLE ky_thi ADD COLUMN da_huy BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE lich_su_ky_thi MODIFY COLUMN hanh_dong ENUM('tao', 'cap_nhat', 'gia_han', 'huy') NOT NULL;

CREATE TABLE IF NOT EXISTS lich_su_buoi_hoc (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  buoi_hoc_id BIGINT UNSIGNED NOT NULL,
  nguoi_thay_doi_id BIGINT UNSIGNED NOT NULL,
  hanh_dong VARCHAR(30) NOT NULL,
  ly_do VARCHAR(255) NOT NULL,
  du_lieu_truoc JSON NULL,
  du_lieu_sau JSON NOT NULL,
  ngay_thay_doi DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_lich_su_buoi_hoc (buoi_hoc_id, ngay_thay_doi),
  CONSTRAINT fk_lich_su_buoi_hoc FOREIGN KEY (buoi_hoc_id) REFERENCES buoi_hoc(id),
  CONSTRAINT fk_lich_su_buoi_hoc_nguoi_dung FOREIGN KEY (nguoi_thay_doi_id) REFERENCES nguoi_dung(id)
) ENGINE=InnoDB;
