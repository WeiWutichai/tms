<!-- ชื่อ PR: <TASK-ID>: <สรุปสั้น> · ย้ายไฟล์นี้ไป .github/PULL_REQUEST_TEMPLATE.md ใน ST0-T02 -->

## Task
- Backlog: `ST?-T??` — <ชื่อ task>
- อ้างอิง docs/spec ที่ใช้: 
- แตะ billing / settlement / ภาษี / RLS / auth: ☐ ไม่ ☐ ใช่ → ต้องมี TL approve + golden test

## แผน (เขียนก่อนเริ่มโค้ด 5–10 บรรทัด)
- ตาราง/field: 
- endpoint: 
- UI: 
- test ที่จะมี: 

## สิ่งที่ทำ


## วิธีทดสอบด้วยมือบน staging
1. 

## Definition of Done
- [ ] CI เขียว (lint, typecheck, unit, integration, tenant-isolation, OpenAPI diff, build, CVE)
- [ ] เกณฑ์ตรวจรับของ task มี test อัตโนมัติ → ไฟล์: 
- [ ] ตาราง/field ใหม่มี `tenant_id` + RLS + อยู่ใน isolation suite; เงิน `numeric(14,2)`; เวลา `timestamptz`
- [ ] ยกเลิก/override/อนุมัติ มีเหตุผล + audit log
- [ ] ข้อความไทยครบ ผ่าน i18n key
- [ ] UI ตรงต้นแบบอย่างเคร่งครัด — ภาพเทียบด้านล่าง; ส่วนที่ต่าง (ถ้ามี) อ้างข้อยกเว้นใน `design/README.md`: 
- [ ] OpenAPI ไม่ breaking (หรือแนบเหตุผล)
- [ ] migration ย้อนกลับได้ ทดสอบ `down` แล้ว
- [ ] (ถ้าแตะเงิน/ภาษี) golden test เขียว + TL approve

## ข้อที่ยังค้าง / คำถาม
- 

## ภาพเทียบ ต้นแบบ | ของจริง (บังคับถ้ามี UI)
| ต้นแบบ (`design/prototype/<ไฟล์>` → หน้า) | ของจริง |
|---|---|
| | |
