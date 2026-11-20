# golden ของ PDF engine (ST0-T17) และใบคุมรถ (ST3-T20)

| ไฟล์                                    | สร้างบน                                                                                                                         |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `sample-th.darwin.png`                  | macOS (เครื่องนักพัฒนา) — `UPDATE_GOLDEN=1 pnpm --filter @tms/api exec vitest run test/pdf.test.ts`                             |
| `sample-th.linux.png`                   | image `mcr.microsoft.com/playwright:v1.65.0-noble` แบบ **linux/amd64** (ตัวเดียวกับ CI)                                         |
| `trip-sheet-th.darwin.png`              | ใบคุมรถตัวอย่าง (`sampleTripSheet()`) — `UPDATE_GOLDEN=1 pnpm --filter @tms/api exec vitest run test/trip-sheet-pdf.test.ts`    |
| `trip-sheet-th.linux.png`               | เหมือน `sample-th.linux.png` แต่ dump HTML จาก `tripSheetDocument(sampleTripSheet())`                                           |
| `trip-sheet-long-th.{darwin,linux}.png` | เที่ยวยาวหลายหน้า (`sampleLongTripSheet()`, ภาพ fullPage) — Linux: render หลัง `html[data-paged]` เหมือน `PdfRenderer.withPage` |

สร้างของ Linux ใหม่ (เมื่อเปลี่ยน template ตัวอย่างหรืออัปเกรด Playwright):

1. dump HTML: `node -r @swc-node/register -e "…new PdfRenderer().html(sampleDocument(new Date('2026-11-03T03:00:00Z'),'BE'))…"` ลงไฟล์ `sample.html`
2. `docker run --rm --platform linux/amd64 -v $PWD:/work mcr.microsoft.com/playwright:v<version>-noble bash -c "cd /tmp && npm i playwright-core@<version> && cp /work/render.js . && node render.js /work/sample.html /work/sample-th.linux.png"` (`render.js` ใช้ค่าเดียวกับ `PdfRenderer.withPage`)
3. **เปิดภาพตรวจด้วยตาว่าสระ/วรรณยุกต์ไม่ลอยก่อน commit** — golden คือหลักฐานว่าเอกสารภาษีพิมพ์ภาษาไทยถูก

### ใบแจ้งหนี้ (ST5-T08)

| ไฟล์ | สร้างบน |
| --- | --- |
| `invoice-{exempt,mixed,long}-th.darwin.png` | ใบตัวอย่าง `sampleInvoiceExempt/Mixed/Long()` (`src/modules/invoices/invoice.sample.ts`, ภาพ fullPage) — `UPDATE_GOLDEN=1 pnpm --filter @tms/api exec vitest run test/invoice-pdf.test.ts` |
| `invoice-{exempt,mixed,long}-th.linux.png` | image `mcr.microsoft.com/playwright:v1.65.0-noble` แบบ **linux/amd64** — dump HTML จาก `new PdfRenderer().html(invoiceDocument(sampleInvoice…()))` แล้ว render หลัง `html[data-paged]` เหมือน `PdfRenderer.withPage` (viewport 794×1123, scale 1, th-TH, Asia/Bangkok, `--font-render-hinting=none`, ภาพ fullPage) |
