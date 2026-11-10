# Release checklist — v<X.Y.Z> วันที่ <…> ผู้รับผิดชอบ: <TL>

## ก่อนตัด tag
- [ ] ทุก PR ใน release ผ่าน QA บน staging (การ์ดอยู่ Done)
- [ ] E2E 8 เส้นทางเขียวบน staging รอบล่าสุด
- [ ] golden test ภาษีเขียว (ตั้งแต่ ST5)
- [ ] migration ใน release เป็น expand-only; รายการ: 
- [ ] ทดสอบ migration กับสำเนาฐานข้อมูล production (ปิดชื่อ) และ `down` 1 ขั้น
- [ ] release note ภาษาไทยเขียนแล้ว และ PO อ่านแล้ว
- [ ] ไม่ตรงวันปิดงวด/วันวางบิลของ tenant นำร่อง

## Deploy
- [ ] backup production สำเร็จ (เวลา: ) และตรวจว่า restore ได้ (ครั้งล่าสุดที่ซ้อม: )
- [ ] รัน migration → สำเร็จ
- [ ] deploy image `v<X.Y.Z>` → สำเร็จ
- [ ] smoke: `GET /v1/health` · login · เปิดกระดานวางแผน · สร้าง SO ใน tenant demo · ออก PDF 1 ใบ · webhook test ส่งถึง
- [ ] ดู error rate / latency 15 นาที ปกติ

## หลัง deploy
- [ ] ประกาศถึง tenant นำร่อง (ข้อความที่ PO อนุมัติ)
- [ ] ปิดการ์ด release; บันทึกใน PROGRESS.md
- [ ] ถ้า rollback: เวลา, เหตุ, ผลกระทบ → incident note
