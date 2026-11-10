# TMS Function Spec

> ⚠️ **ลำดับความสำคัญ (10 พ.ย. 2569):** ไฟล์นี้เขียนโดยไม่ได้อ่าน `docs/` (v2) เมื่อเนื้อหาขัดกับ `docs/` ให้ยึด `docs/` — ดู `plan/00-source-of-truth.md` และรายการจุดที่ขัดกันใน `plan/00a-reconcile-architecture.md`, `plan/00b-reconcile-requirements.md` · ป้าย P0/P1/P2 ในไฟล์นี้เป็นมาตราส่วนของ spec ไม่ใช่ "เฟส 0" ของแผนพัฒนา

> สถานะ: ร่าง v0.1 · เริ่มเขียน 9 พ.ย. 2569
> แหล่งที่มา: ต้นแบบใน Claude Design (TMS v4, Driver App, Subcon, Print, Tracking, Signup, Platform Console) รอบ 1–18 ตาม `research/design-briefs.md` และ research ใน `research/`
> ผู้อ่าน: ทีมพัฒนา (NestJS / Prisma / PostgreSQL + Angular หรือ React), QA, product owner

## โครงเอกสาร

| ไฟล์ | เนื้อหา |
|---|---|
| [00-overview.md](00-overview.md) | ขอบเขต, ผู้ใช้และ role, หลักการที่ห้ามย้อน, คำศัพท์, รูปแบบการเขียน spec |
| [01-platform.md](01-platform.md) | Tenant, สมัคร, แพ็กเกจ/entitlement, การเรียกเก็บเงิน, Platform Console, ผู้ใช้และสิทธิ์, ตั้งค่าองค์กร |
| [02-master-data.md](02-master-data.md) | ลูกค้า, สถานที่, สินค้า/หน่วย, ประเภทรถ, rate card, ค่าบริการเสริม, ผู้ขาย/อู่, ฟิลด์เพิ่มเติม (custom fields) |
| [03-orders-planning.md](03-orders-planning.md) | กล่องรับงาน, SO, DO, เที่ยวรถ, กระดานวางแผน, กฎห้ามจ่ายงาน, จ่ายงานรถร่วม |
| [04-execution.md](04-execution.md) | ติดตามรถ, แอปคนขับ (M1–M18), POD, ออฟไลน์, ศูนย์ข้อยกเว้น, แจ้งลูกค้า, หน้าติดตามผู้รับ, หน้ารถร่วม (LINE) |
| [05-billing.md](05-billing.md) | ใบวางบิล/ใบแจ้งหนี้, ใบกำกับภาษี/ใบเสร็จ, ใบลด/เพิ่มหนี้, รับชำระ, Settlement รถร่วม, เงินเบิกคนขับ, หัก ณ ที่จ่าย/50 ทวิ, VAT, เลขที่เอกสาร, เอกสารพิมพ์ |
| [06-fleet.md](06-fleet.md) | ทะเบียนรถ, หาง, เอกสารรถ, PM/ใบสั่งซ่อม, ผลตรวจรถ, ยาง, อะไหล่, น้ำมัน/ถังน้ำมัน, อุบัติเหตุ/เคลม, ค่าปรับ, คะแนนการขับ, ลีสซิ่ง, เลขไมล์ |
| [07-integration.md](07-integration.md) | Connector บัญชี/ERP, Open API, Webhook, Field mapping, MCP server |
| [08-ai.md](08-ai.md) | AI ระยะ 1 (รับงานจากข้อความ/ไฟล์, OCR, ตรวจ POD, แนะนำ mapping, ถามข้อมูล), ตั้งค่า AI, credit |
| [09-reports.md](09-reports.md) | ภาพรวม, รายงานกำไร, OTIF, ลูกหนี้/เจ้าหนี้, ภาษี, fleet, ตั้งเวลาส่งรายงาน |
| [10-data-model.md](10-data-model.md) | Entity หลัก, ความสัมพันธ์, enum สถานะ, กติกา multi-tenant |
| [11-nfr.md](11-nfr.md) | ความปลอดภัย, PDPA, audit, 3 ภาษา, ประสิทธิภาพ, มือถือ, ความพร้อมใช้งาน, การเก็บข้อมูล |
| [12-roadmap-open-questions.md](12-roadmap-open-questions.md) | ลำดับพัฒนา (เฟส), คำถามที่ยังรอตัดสินใจ, ความต่างระหว่างต้นแบบกับ spec |

## วิธีอ่าน

- **[FACT]** = มาจากกฎหมาย/research ที่มีแหล่งอ้างอิง · **[DECISION]** = ข้อตกลงที่ตัดสินแล้ว · **[PROPOSED]** = ข้อเสนอ รอยืนยัน · **[OPEN]** = ยังต้องตัดสินใจ (อยู่ใน 12-roadmap-open-questions.md)
- รหัสข้อกำหนด: `<โมดูล>-<เลข>` เช่น `ORD-012` ใช้อ้างอิงใน ticket, test case และ commit
- เฟส: **P0** = MVP ขายได้ · **P1** = หลังเปิดขาย · **P2** = ขยาย (ดู 12-roadmap)
- ต้นแบบ (`design/prototype/`) เป็นข้อกำหนดด้าน **หน้าตาและการใช้งาน** ต้องทำตามอย่างเคร่งครัด (PO สั่ง 10 พ.ย. 2569) — spec ชนะเฉพาะเรื่องกฎธุรกิจ/ภาษี/สถานะ/สิทธิ์/validation ดูรายการความต่างใน 12-roadmap §3 และกติกาใน `design/README.md`
