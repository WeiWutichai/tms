# เวอร์ชันของ API

เวอร์ชันมี 2 ชั้น: major ใน path และวันที่ของพฤติกรรมใน header `X-Api-Version`

- **major** อยู่ใน path (`/v1`) — การเปลี่ยนที่ไม่ compatible ออกเป็น `/v2`
- **พฤติกรรม** เลือกด้วย header `X-Api-Version: YYYY-MM-DD` — ได้ทุกการเปลี่ยนที่ออกในหรือก่อนวันนั้น · ไม่ส่ง = เวอร์ชันที่ pin ไว้บน API key → วันที่สร้างบริษัท · ผิดรูปแบบ/อนาคต = `400 invalid_api_version` · response บอกเวอร์ชันที่ใช้ใน header `X-Api-Version`
- เพิ่ม field / enum ใหม่ = ไม่ breaking — client ต้องไม่พังเมื่อเจอฟิลด์หรือค่าที่ไม่รู้จัก
- เลิกใช้ (deprecate) ประกาศล่วงหน้า ≥ 12 เดือน พร้อม header `Deprecation`, `Sunset`, `Link` และอีเมลถึงเจ้าของ key ที่ยังเรียก

ประวัติทุกเวอร์ชันอยู่ที่ [Changelog](changelog.md) · SDK ส่ง `X-Api-Version` ตรงกับเวอร์ชันที่ type ของ SDK สร้างจากเสมอ
