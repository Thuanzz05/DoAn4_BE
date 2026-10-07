USE doan4;

-- Chạy một lần, sau migration 20261003. Không ghi đè thông tin chứng chỉ đã cấp.
ALTER TABLE chung_chi ADD COLUMN ho_so_luc_duyet JSON NULL AFTER ten_lop_luc_cap;

-- Hồ sơ cũ chỉ có thể chốt theo dữ liệu hiện có, không thể phục hồi dữ liệu đã bị sửa trước đây.
UPDATE chung_chi cc
JOIN ghi_danh gd ON gd.id = cc.ghi_danh_id
JOIN nguoi_dung hv ON hv.id = gd.hoc_vien_id
JOIN khoa_hoc k ON k.id = gd.khoa_hoc_id
JOIN lop_hoc l ON l.id = gd.lop_hoc_id
SET cc.ma_hoc_vien_luc_cap = COALESCE(cc.ma_hoc_vien_luc_cap, hv.ma_nguoi_dung),
    cc.ten_hoc_vien_luc_cap = COALESCE(cc.ten_hoc_vien_luc_cap, hv.ho_ten),
    cc.ten_khoa_hoc_luc_cap = COALESCE(cc.ten_khoa_hoc_luc_cap, k.ten_khoa_hoc),
    cc.ngoai_ngu_luc_cap = COALESCE(cc.ngoai_ngu_luc_cap, k.ngoai_ngu),
    cc.ma_lop_luc_cap = COALESCE(cc.ma_lop_luc_cap, l.ma_lop),
    cc.ten_lop_luc_cap = COALESCE(cc.ten_lop_luc_cap, l.ten_lop),
    cc.ho_so_luc_duyet = JSON_OBJECT(
      'enrollmentStatus', gd.trang_thai,
      'paid', (EXISTS(SELECT 1 FROM hoa_don hd WHERE hd.ghi_danh_id = gd.id AND hd.trang_thai = 'da_thanh_toan')
        AND NOT EXISTS(SELECT 1 FROM hoa_don hd WHERE hd.ghi_danh_id = gd.id AND hd.trang_thai = 'chua_thanh_toan')),
      'average', (SELECT AVG((kq.nghe + kq.noi + kq.doc + kq.viet) / 4)
        FROM ket_qua_thi kq JOIN ky_thi kt ON kt.id = kq.ky_thi_id
        WHERE kq.ghi_danh_id = gd.id AND kt.lop_hoc_id = gd.lop_hoc_id
          AND kq.nghe IS NOT NULL AND kq.noi IS NOT NULL AND kq.doc IS NOT NULL AND kq.viet IS NOT NULL),
      'requiredExams', (SELECT COUNT(*) FROM ky_thi kt WHERE kt.lop_hoc_id = gd.lop_hoc_id),
      'completedExams', (SELECT COUNT(*) FROM ket_qua_thi kq JOIN ky_thi kt ON kt.id = kq.ky_thi_id
        WHERE kq.ghi_danh_id = gd.id AND kt.lop_hoc_id = gd.lop_hoc_id
          AND kq.nghe IS NOT NULL AND kq.noi IS NOT NULL AND kq.doc IS NOT NULL AND kq.viet IS NOT NULL),
      'expectedAttendance', (SELECT COUNT(*) FROM buoi_hoc bh
        WHERE bh.lop_hoc_id = gd.lop_hoc_id AND bh.bat_dau <= NOW() AND bh.trang_thai <> 'da_huy'),
      'recordedAttendance', (SELECT COUNT(*) FROM diem_danh dd JOIN buoi_hoc bh ON bh.id = dd.buoi_hoc_id
        WHERE dd.ghi_danh_id = gd.id AND bh.lop_hoc_id = gd.lop_hoc_id
          AND bh.bat_dau <= NOW() AND bh.trang_thai <> 'da_huy'),
      'presentAttendance', (SELECT COUNT(*) FROM diem_danh dd JOIN buoi_hoc bh ON bh.id = dd.buoi_hoc_id
        WHERE dd.ghi_danh_id = gd.id AND bh.lop_hoc_id = gd.lop_hoc_id
          AND bh.bat_dau <= NOW() AND bh.trang_thai <> 'da_huy' AND dd.trang_thai IN ('co_mat', 'di_muon')),
      'attendance', COALESCE(100 * (SELECT COUNT(*) FROM diem_danh dd JOIN buoi_hoc bh ON bh.id = dd.buoi_hoc_id
        WHERE dd.ghi_danh_id = gd.id AND bh.lop_hoc_id = gd.lop_hoc_id
          AND bh.bat_dau <= NOW() AND bh.trang_thai <> 'da_huy' AND dd.trang_thai IN ('co_mat', 'di_muon'))
        / NULLIF((SELECT COUNT(*) FROM buoi_hoc bh WHERE bh.lop_hoc_id = gd.lop_hoc_id
          AND bh.bat_dau <= NOW() AND bh.trang_thai <> 'da_huy'), 0), 0)
    )
WHERE cc.ho_so_luc_duyet IS NULL;

ALTER TABLE chung_chi MODIFY COLUMN ho_so_luc_duyet JSON NOT NULL,
  ADD CONSTRAINT chk_chung_chi_ho_so CHECK (
    ma_hoc_vien_luc_cap IS NOT NULL AND ten_hoc_vien_luc_cap IS NOT NULL
    AND ten_khoa_hoc_luc_cap IS NOT NULL AND ngoai_ngu_luc_cap IS NOT NULL
    AND ma_lop_luc_cap IS NOT NULL AND ten_lop_luc_cap IS NOT NULL
  );

-- Không sửa học phí của dữ liệu cũ. API chỉ cho tạo khóa với học phí nguyên dương.
