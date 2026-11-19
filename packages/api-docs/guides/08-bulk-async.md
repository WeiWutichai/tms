# ทำทีละหลายรายการและงานเบื้องหลัง

## Bulk

`POST /v1/orders:bulk` body `{ "items": [...] }` 1–200 ใบ (รูปเดียวกับ body ของ `POST /v1/orders`, body ≤ 1 MB) → `207 Multi-Status` ผลแยกต่อรายการเรียงตาม `items[]` (รายการที่ไม่ผ่านไม่ย้อนรายการอื่น · ใบที่มี `externalId` เดิม = อัปเดตใบเดิม) · รับ `Idempotency-Key` · นับเป็นคำขอหนักใน [rate limit](rate-limits.md)

ส่ง header `Prefer: respond-async` = ทำเป็นงานเบื้องหลัง → `202`

## งานเบื้องหลัง (jobs)

งานหนักตอบ `202` พร้อม `{ jobId, statusUrl }` → ดูสถานะที่ `GET /v1/jobs/{id}`: `pending` → `running` → `succeeded` / `succeeded_with_errors` / `failed` / `skipped` (มี progress — client ต้องรับสถานะที่ไม่รู้จักได้) และได้ webhook `job.completed` เมื่อจบ · เก็บผล 7 วัน
