-- Chạy sau khi chọn database doan4. Không đổi điểm hay thông tin kỳ thi hiện có.
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
