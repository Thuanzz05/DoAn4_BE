-- Chạy trong database doan4 trước khi khởi động chức năng nhắc học phí.
CREATE TABLE IF NOT EXISTS nhac_hoc_phi (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  hoa_don_id BIGINT UNSIGNED NOT NULL,
  han_thanh_toan DATE NOT NULL,
  loai ENUM('sap_den_han', 'qua_han') NOT NULL,
  ngay_tao DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_nhac_hoc_phi (hoa_don_id, han_thanh_toan, loai),
  CONSTRAINT fk_nhac_hoc_phi_hoa_don FOREIGN KEY (hoa_don_id) REFERENCES hoa_don(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
