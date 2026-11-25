# sign-offs
เก็บหลักฐานการเซ็นรับจากผู้ตรวจภายนอก (นักบัญชี: golden case ภาษี · ทนาย: ข้อความ PDPA · tenant นำร่อง: UAT) เป็น PDF/อีเมลที่ export แล้ว ตั้งชื่อ `YYYY-MM-DD-<ใคร>-<เรื่อง>.pdf` · ไม่เก็บข้อมูลส่วนบุคคลเกินจำเป็น

## แบบฟอร์มที่ต้องเซ็น (ร่าง 24 พ.ย. 2569)
| ไฟล์ | งาน | ใครเซ็น |
|---|---|---|
| `st5-t25-ar-ap-checklist.md` | ST5-T25 ชุดตรวจ AR/AP แบบเบา (รวม ST6-T12) — ชุดเอกสารจาก `pnpm --filter @tms/api uat:samples` | PO (รอบนี้) · นักบัญชี tenant นำร่อง (ก่อน go-live) |
| `st9-t22-uat-standalone.md` | ST9-T22 UAT (ข) Standalone | PO (รอบ 0) · PO + นักบัญชี tenant นำร่อง (รอบ 1) |
| `st4-t15-mobile-checklist.md` | ST4-T15 มือถือ 3 browser × 3 หน้า — ผลจำลอง (`pnpm e2e:mobile`) + ภาพใน `st4-t15/` · ช่องเครื่องจริงรอคนทดสอบ | ผู้ทดสอบเครื่องจริง (Android / iPhone / LINE) |
| `st9-t21-uat-krs.md` | ST9-T21 UAT (ก) KRS | PO (ซ้อม) · ผู้ใช้ KRS + PO (2 งวดจริง) |
| `st9-t18-restore-drill.md` | ST9-T18 บันทึกซ้อมกู้คืน (รอบ 1 ในเครื่อง 25 พ.ย.: RPO 41 วิ / RTO 3 นาที 17 วิ) · รอบ 2 บน cloud ก่อน go-live | DevOps + Tech lead |
| `../../docs/ops/st9-t23-go-live-runbook.md` §1 | ST9-T23 checklist ขึ้นใช้งานจริง | PO + Tech lead |
