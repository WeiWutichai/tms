# @tms/mock-accountsystem — mock ของ AccountSystem `ext/v1` (ST8-T16)

mock server จาก contract `packages/contracts/accountsystem/README.md` (อ่านจาก repo AccountSystem แบบอ่านอย่างเดียว) สำหรับ dev / test — **ไม่เรียก AccountSystem จริง ไม่ต่อเครือข่ายภายนอก** และ core ของ TMS ไม่อ้างถึง (AccountSystem เป็นแค่ adapter หนึ่งหลัง `ErpAdapter`)

| ใช้ที่ไหน | วิธี |
|---|---|
| server แยก | `pnpm --filter @tms/mock-accountsystem dev` → `http://127.0.0.1:4785` (env `MOCK_ACCOUNTSYSTEM_PORT` / `MOCK_ACCOUNTSYSTEM_HOST` / `MOCK_ACCOUNTSYSTEM_API_KEY` ต้องขึ้นต้น `inn_`) — ตั้งพอร์ตให้อยู่ในช่วงของ lane ตัวเอง |
| ใน test (in-process) | `const m = await startMockAccountSystem({ apiKey, webhookSecret, contacts })` → `m.url` (พอร์ตสุ่ม) … `await m.stop()` |

- endpoint: `POST/GET /ext/v1/documents`, `GET /ext/v1/documents/:id`, `PUT /ext/v1/contacts` — 401/403/400/422 + body `{error}` แบบตัวจริง
- จำลองช่องว่างของตัวจริง: ทิ้ง `vat_rate` รายบรรทัด, ไม่คำนวณ `amount`, ไม่เก็บ `discount`, หัวเอกสาร strict / บรรทัดตัดฟิลด์เกิน
- control ในโปรเซส (สิ่งที่ผู้ใช้ทำใน AccountSystem → webhook ที่เซ็นแบบตัวจริง): `post(id)`, `void(id, reason)`, `receive([...])`, `pay([...], certs)`, `webhook(type, data, at, {secret, timestamp})`
- ความผิดพลาด: `failNext(503 | 'reset')` · `setScopes([...])` · `requests` (log คำขอ) · `byRef(ref, source)`
