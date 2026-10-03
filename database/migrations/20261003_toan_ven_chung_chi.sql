USE doan4;

ALTER TABLE chung_chi
  ADD COLUMN ma_hoc_vien_luc_cap VARCHAR(20) NULL AFTER duong_dan_pdf,
  ADD COLUMN ten_hoc_vien_luc_cap VARCHAR(150) NULL AFTER ma_hoc_vien_luc_cap,
  ADD COLUMN ten_khoa_hoc_luc_cap VARCHAR(150) NULL AFTER ten_hoc_vien_luc_cap,
  ADD COLUMN ngoai_ngu_luc_cap VARCHAR(50) NULL AFTER ten_khoa_hoc_luc_cap,
  ADD COLUMN ma_lop_luc_cap VARCHAR(30) NULL AFTER ngoai_ngu_luc_cap,
  ADD COLUMN ten_lop_luc_cap VARCHAR(150) NULL AFTER ma_lop_luc_cap;

UPDATE chung_chi cc
JOIN ghi_danh gd ON gd.id = cc.ghi_danh_id
JOIN nguoi_dung hv ON hv.id = gd.hoc_vien_id
JOIN khoa_hoc k ON k.id = gd.khoa_hoc_id
JOIN lop_hoc l ON l.id = gd.lop_hoc_id
SET cc.ma_hoc_vien_luc_cap = hv.ma_nguoi_dung,
    cc.ten_hoc_vien_luc_cap = hv.ho_ten,
    cc.ten_khoa_hoc_luc_cap = k.ten_khoa_hoc,
    cc.ngoai_ngu_luc_cap = k.ngoai_ngu,
    cc.ma_lop_luc_cap = l.ma_lop,
    cc.ten_lop_luc_cap = l.ten_lop
WHERE cc.trang_thai = 'da_cap';

ALTER TABLE chung_chi
  DROP CHECK chk_chung_chi_da_cap,
  ADD CONSTRAINT chk_chung_chi_da_cap CHECK (
    trang_thai <> 'da_cap' OR
    (ma_chung_chi IS NOT NULL AND ma_xac_thuc IS NOT NULL
     AND ngay_cap IS NOT NULL AND duong_dan_pdf IS NOT NULL
     AND ma_hoc_vien_luc_cap IS NOT NULL AND ten_hoc_vien_luc_cap IS NOT NULL
     AND ten_khoa_hoc_luc_cap IS NOT NULL AND ngoai_ngu_luc_cap IS NOT NULL
     AND ma_lop_luc_cap IS NOT NULL AND ten_lop_luc_cap IS NOT NULL)
  );
