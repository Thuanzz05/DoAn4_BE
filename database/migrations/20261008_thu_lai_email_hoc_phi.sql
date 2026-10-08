-- Chạy một lần trong doan4, hoặc dùng npm run migrate:academic-finance để tự bỏ qua cột đã có.
ALTER TABLE nhac_hoc_phi ADD COLUMN email_thu_luc DATETIME NULL;
ALTER TABLE nhac_hoc_phi ADD COLUMN email_da_gui_luc DATETIME NULL;
ALTER TABLE nhac_hoc_phi ADD COLUMN email_loi VARCHAR(255) NULL;
