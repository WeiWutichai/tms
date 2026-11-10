# เรียนรู้ API และ MCP จาก TRCloud แล้วปรับใช้กับ TMS

> ตรวจเมื่อ 4 พ.ย. 2569 จาก demo ที่ผู้ใช้ login ไว้ (demo.trcloud.co, บริษัท demo "รับจ้างผลิตยา")
> วิธีตรวจ: ใช้หลัก REA คือสังเกตอย่างเดียว ไม่สร้าง ไม่แก้ และไม่กด "Send Request" เพราะหน้าทดสอบยิงไปที่ข้อมูลจริง
> เครื่องมือ: Chrome extension (REA MCP ต่อ session ที่ login ไว้ไม่ได้ เพราะต้องเปิด Chrome ผ่าน CDP)
> หน้าที่เปิดดู: `/application/api-connector2/` (Dashboard, so.php, so-create.php แท็บ cURL / Test API, setting.php, sync.php), `/application/mcp/` (หน้าเชื่อมต่อ, tool-create-so.php, tool-ocr-to-so.php)
> ไม่ได้บันทึกค่า passkey หรือ secret ใด ๆ ลงไฟล์นี้

---

## 1. FACT: RESTful API ของ TRCloud

**โครงเมนู**
- แบ่งตามโมดูลบัญชีและ ERP: Accounting (GL, COA, Formula) · Revenue (QO, SO, BL, IV, CN) · Expenditure (PR, PO, AP, EXP, CNR) · Finance (BN, RV, BNR, PV, WHT, Bank Statement, Bank Account) · Contact · CRM · Inventory · Manufacturing · Category/Project · Other (Report, Sync, Ticket) · Datawarehouse · Setting (API Key)
- รวมประมาณ 50 resource

**Dashboard**
- API usage แสดงเป็นจำนวนที่ใช้เทียบกับโควตา (38,178 / 99,999,999)
- แยกนับตามประเภท Create / Edit / Read / Other
- มีกราฟรายปี และกราฟสัดส่วนตลอดอายุ

**หน้า resource (ตัวอย่าง SO)**
- มี 7 action ต่อ resource: Create, Read, Update, Delete, Search, Approve, Attach
- หน้า action มี 3 แท็บ:
  1. DATA DESCRIPTION: endpoint, method, type และตารางฟิลด์ (บังคับ, ชื่อ, ชนิด, ความยาว, คำอธิบายภาษาไทย, ตัวอย่าง) แบ่งกลุ่ม Authentication / Data / Customer (object) / Product (array) / Dropbox (array)
  2. cURL: โค้ดตัวอย่าง terminal และ PHP พร้อมปุ่ม "CURL to Any Language"
  3. TEST API: กรอก JSON แล้วเลือก API key จากนั้นกด Send Request มีคำเตือนว่า "การทดสอบนี้ยิง API จริง เอกสาร/ข้อมูลจะถูกสร้างหรือแก้ไขจริง และนับรวมใน API Usage"
- endpoint อยู่ในรูป `/end-point/so/create.php` ใช้ POST แบบ `x-www-form-urlencoded` โดยส่ง JSON ไว้ในฟิลด์ `json`

**การยืนยันตัวตน**
- ส่ง `company_id` + `passkey` + `securekey` + `timestamp` ไปในทุก request
- `securekey` คือ MD5 ของ (Encrypt Head + "t" + Unix time)

**หน้า API Key**
- ตาราง: Origin (เช่น ANY), Passkey (แสดงเต็ม), Encrypt Head, User ID และปุ่มลบ
- ปุ่ม "+ เพิ่มรายการ"

**การออกแบบฟิลด์**
- `document_number` ปล่อยว่างได้ ระบบจะออกเลขเอง
- `add_contact = 1` สร้างคู่ค้าใหม่ให้ถ้ายังไม่มี (upsert)
- มี `wht` (รับได้ทั้ง % และจำนวนเงิน), `tax_option` in/ex, `fx` / `rate`, `approve_status`, `anchor` สำหรับ reconcile
- ฟิลด์อิสระ `c1`–`c20` (Special Note) ทำหน้าที่แทน custom field

**Sync**
- เป็นการดึงข้อมูลจาก marketplace ได้แก่ Lazada (Orders, Items), TikTok (Orders & Items), Shopee (Orders, Items, Full Tax, Status)

**ที่ไม่เห็นในเมนู**
- หน้าตั้งค่า webhook (ข้อมูลขาออกแบบ push)
- หน้า log การเรียกรายครั้ง
- การกำหนด scope ต่อ key
- เอกสาร rate limit

ข้อนี้คือ "ไม่เห็นในเมนูที่เปิด" ไม่ได้ยืนยันว่าไม่มีอยู่จริง

## 2. FACT: MCP ของ TRCloud

**หน้าเชื่อมต่อผู้ช่วย AI**
1. ก่อนเริ่มต้องมี API Key ที่ตั้ง Allow URL = ANY
   - หน้าระบุว่า "สิทธิ์การเข้าถึงเป็นไปตาม API Key ของบริษัท ไม่ใช่สิทธิ์ส่วนบุคคล"
2. Server URL รูปแบบ HTTP คือ `…/end-point/mcp/server.php?company=<id>&user=<id>` พร้อมปุ่มคัดลอก
3. วิธีเพิ่มการเชื่อมต่อแยกแท็บตามโปรแกรม: **Claude Code / Claude.ai (เว็บ) / Codex (ChatGPT) / ChatGPT**
   - แท็บ Claude Code มีคำสั่ง `claude mcp add --transport http …` และบอกให้รัน `/mcp` เพื่อยืนยันตัวตน
4. ครั้งแรกจะเปิดเบราว์เซอร์ให้ login แล้วกด **Allow** บนหน้ายืนยัน (OAuth)
   - หน้าระบุว่า "ผู้ช่วย AI จะถือ token โดยไม่เห็นรหัสผ่าน"

**แคตตาล็อก tool**
- มีประมาณ 130 เมนู แบ่งหมวดตามงาน:
  - สร้างรายการ: บัญชี / ขาย / ซื้อ / การเงิน / สินค้า / อื่น ๆ
    - รวม tool รวบงาน เช่น "เอกสารขายถึงกำหนด → BN / RV" และ "เอกสารถึงกำหนด → BNR / PV"
    - รวม `send_etax_invoice` และ `upload_attachment`
  - **OCR**: `ocr_to_qo`, `ocr_to_so`, `ocr_to_bl`, `ocr_to_iv`, `ocr_to_cn`, `ocr_to_pr`, `ocr_to_po`, `ocr_to_ap`, `ocr_to_exp`, `ocr_to_cnr`
  - ข้อมูลหลัก: ผังบัญชี, สินค้า, คู่ค้า, CRM, แผนก/คลัง/พนักงาน/โครงการ, ผู้ใช้
  - รายงานทั่วไป: รายงานขาย/ซื้อ, ธนาคาร (นำเข้า statement, จับคู่, กระทบยอด), บัญชีแยกประเภท, ความเคลื่อนไหวสินค้า, เงินเดือน, ตั๋วงาน, การประชุม
  - Data Warehouse: งบดุล, งบทดลอง, งบกำไรขาดทุน, กระแสเงินสด (รายเดือนและเปรียบเทียบ)
  - นำเข้าข้อมูล
- ชื่อ tool เป็น snake_case แบบ verb_entity เช่น `create_so`, `get_so`, `update_so`, `delete_so`, `approve_so`, `attach_so`, `search_so`

**หน้ารายละเอียด tool (ตัวอย่าง `create_so`, `ocr_to_so`)**
- "เครื่องมือนี้ทำอะไร": ชื่อ tool มีปุ่มคัดลอก, ป้าย "ฐานข้อมูลหลัก", คำอธิบาย 2–3 บรรทัด และหมายเหตุว่า "อ่านจากฐานข้อมูลจริง เห็นผลทันที"
- "วิธีเรียกใช้งาน": ตัวอย่างประโยคภาษาพูด เช่น "เปลี่ยนใบเสนอราคา QO23120001 เป็นใบสั่งขาย" หรือ "นี่ใบสั่งซื้อที่ลูกค้าส่งมา ช่วยบันทึกเป็นใบสั่งขายให้หน่อย"
- "พารามิเตอร์ที่รับได้": ตารางเดียวกับ REST API
  - หน้าระบุว่า "ผู้ช่วย AI จะกรอกค่าเหล่านี้ให้เอง ตารางนี้มีไว้ให้ท่านทราบว่าสั่งอะไรได้บ้าง"
- "ข้อควรรู้":
  - "เครื่องมือนี้บันทึกเอกสารจริง ผู้ช่วย AI จะทวนตัวเลขให้ก่อน"
  - คู่ค้าที่มีอยู่แล้วบอกแค่ชื่อก็พอ
  - ไม่ต้องบอกรหัสสินค้า ระบบจับคู่ให้ และถ้าจับคู่ไม่ได้จะถามกลับ
  - เอกสารเริ่มที่สถานะ New
  - แนบรูปได้ โดยเก็บใน Dropbox หรือ Google Drive ของลูกค้าเอง
  - ไฟล์ที่รองรับ: jpg/png/heic/pdf, ย่อรูปให้ ≤ 500 KB, ไฟล์เกิน 2 MB ไม่รับ
- แผงขวา "เครื่องมือในชุดนี้": รายการ tool ทั้ง 7 ตัวของ entity เดียวกัน

**ผู้ช่วย AI ในแอป**
- มี widget "ผู้ช่วย AI" ทุกหน้า ใช้ตอบคำถามการใช้งานทั่วไป

---

## 3. OPINION: ประเมิน

**สิ่งที่ TRCloud ทำได้ดี (ควรหยิบมาใช้)**
1. **API กับ MCP ใช้ข้อมูลฟิลด์ชุดเดียวกัน** ตารางพารามิเตอร์ของ MCP tool คือตารางเดียวกับ REST API เมื่อเพิ่มฟิลด์ในที่เดียว ทั้งสองฝั่งได้ตามทันที
2. **แต่ละ entity มี action ครบชุด** (create / get / update / delete / search / approve / attach) ตั้งชื่อคงที่และเดาได้
3. **มี tool แบบ "งานธุรกิจ" นอกเหนือจาก CRUD** เช่น "เอกสารถึงกำหนด → ใบวางบิล/ใบเสร็จ" ซึ่ง AI ใช้งานจริงได้ง่ายกว่าการเรียก CRUD หลายขั้น
4. **มี tool OCR แยกต่อเอกสาร** (`ocr_to_*`) รับรูปแล้วบันทึกเอกสาร ใช้ข้อมูลน้อยที่สุด และจับคู่รหัสสินค้าให้
5. **หน้าเชื่อมต่อทำตามได้ง่าย** มี URL เดียว แยกแท็บตามโปรแกรม AI มีคำสั่งให้คัดลอก และใช้ OAuth กด Allow โดยผู้ใช้ไม่ต้องจัดการ token เอง
6. **เอกสาร tool เขียนเพื่อผู้ใช้ทั่วไป** ใช้ตัวอย่างเป็นประโยคภาษาพูดและมีส่วน "ข้อควรรู้" ไม่เขียนแบบเอกสารสำหรับนักพัฒนาอย่างเดียว
7. **ตัวช่วยที่ลดภาระผู้เรียก** เช่น ออกเลขเอกสารให้เอง และสร้างคู่ค้าใหม่ให้ (upsert)
8. **Dashboard แยกนับ Create / Edit / Read** ทำให้เห็นรูปแบบการใช้งานของลูกค้า

**สิ่งที่ไม่ควรทำตาม**
1. **การยืนยันตัวตนแบบ passkey + MD5 securekey ใส่ไว้ใน body**
   - MD5 อ่อนแอ และ secret ถูกแสดงเต็มในตาราง API Key
   - เราใช้ Bearer token ใน header แสดง secret ครั้งเดียวตอนสร้าง กำหนด scope ต่อ key และหมุน key ได้ (ทำแล้วในรอบ 11)
2. **ส่ง JSON ห่อไว้ใน `x-www-form-urlencoded`**
   - เราใช้ `application/json` แบบตรง ๆ, REST + HTTP status ที่ถูกต้อง, error มาตรฐาน และไฟล์ OpenAPI spec
3. **ฟิลด์อิสระ `c1`–`c20`**
   - ไม่มีชื่อ ไม่มีชนิดข้อมูล และไม่มีกฎตรวจ
   - เราใช้ custom fields แบบตั้งชื่อ มีชนิดข้อมูลและกฎ (ทำแล้วในรอบ 12) ดีกว่าชัดเจน
4. **MCP URL ใส่ `company` และ `user` id ใน query string**
   - เดาได้ และรั่วผ่าน log ได้
   - เราให้ server ระบุ tenant และผู้ใช้จาก OAuth token อย่างเดียว ใช้ URL เดียวทุกลูกค้า หรือแยก subdomain ต่อ tenant
5. **MCP ใช้สิทธิ์ระดับบริษัท ไม่ใช่สิทธิ์ของผู้ใช้**
   - เรากำหนดสิทธิ์ MCP = สิทธิ์ของ role ผู้ใช้ ∩ scope ของการเชื่อมต่อ จะได้ไม่เกิดกรณีพนักงานทั่วไปลบเอกสารผ่าน AI ได้
6. **tool เขียนข้อมูลบันทึกจริงทันที** (มีแค่ให้ AI "ทวนตัวเลข")
   - งานที่กระทบเงิน เอกสารภาษี หรือการจ่ายงานรถ เราให้เป็น "ร่างรอยืนยันใน TMS"
   - หรืออย่างน้อยต้องมี confirmation token ที่ผู้ใช้กดยืนยันก่อน
7. **หน้า Test API ยิงข้อมูลจริง**
   - เรามี Sandbox แยกข้อมูล และให้ปุ่ม "ลองเรียก" ใช้ได้เฉพาะ Sandbox (ทำแล้วในรอบ 11)
8. **ไม่เห็น webhook** เรามีแล้ว (รอบ 11) และเป็นจุดที่ TMS ต้องมี เพราะลูกค้าอยากรู้สถานะการส่งแบบทันที

---

## 4. OPINION: ปรับใช้กับ TMS

### 4.1 โครง MCP tool ของ TMS (ตั้งชื่อ verb_entity เหมือน TRCloud)

| หมวด | Tools |
|---|---|
| งานขนส่ง | `create_order`, `get_order`, `update_order`, `cancel_order`, `search_orders`, `attach_order` · `get_shipment`, `search_shipments` · `get_trip`, `search_trips` |
| ติดตาม/POD | `get_vehicle_location`, `get_shipment_eta`, `get_pod`, `request_pod_resend` |
| วางแผน (ร่าง) | `suggest_vehicle_for_order`, `create_dispatch_draft` |
| OCR / จากเอกสาร | `order_from_text` (ข้อความ LINE/อีเมล), `order_from_document` (PDF/รูป/Excel), `expense_from_receipt`, `vehicle_document_from_file`, `pod_check` |
| บัญชี | `get_invoice`, `search_invoices`, `list_overdue_receivables`, `create_invoices_from_delivered` (งานธุรกิจ: DO ส่งแล้วและ POD ผ่าน → ร่างใบแจ้งหนี้), `get_subcontractor_settlement` |
| Fleet | `get_vehicle`, `list_expiring_documents`, `list_maintenance_due`, `get_fuel_anomalies`, `report_incident` |
| ข้อมูลหลัก | `search_customers`, `upsert_customer`, `search_locations`, `upsert_location`, `quote_rate` |
| รายงาน | `get_profit_by_trip`, `get_profit_by_customer`, `get_otif`, `get_fleet_cost_per_km` |
| ข้อยกเว้น | `list_exceptions`, `assign_exception`, `resolve_exception` |

### 4.2 กติกา
- **API กับ MCP ใช้ schema ชุดเดียว** สร้างจาก OpenAPI spec รวม custom fields ราย tenant เพิ่มฟิลด์ที่เดียวแล้วทั้ง REST, MCP, webhook และเอกสารอัปเดตตาม
- **ทุก tool มีป้ายระดับ:** อ่าน / ร่าง (ต้องยืนยันใน TMS) / เขียน (ต้องยืนยันใน AI client ผ่าน confirmation)
  - tool ที่กระทบเงิน ภาษี การจ่ายงาน หรือการลบ เป็นระดับร่างเสมอ
- **ตัวช่วยแบบ TRCloud:**
  - เลขเอกสารออกให้เอง
  - upsert ลูกค้าและสถานที่ด้วยชื่อหรือเลขผู้เสียภาษี
  - จับคู่สถานที่จากที่อยู่ข้อความ
  - ถ้าจับคู่ไม่ได้ให้ AI ถามกลับ
- **สิทธิ์ = role ผู้ใช้ ∩ scope ของการเชื่อมต่อ** server ระบุ tenant จาก OAuth token ไม่ใช่จาก query
- **ไฟล์แนบ:** เก็บใน storage ของ TMS (POD ต้องอยู่กับระบบเพื่อใช้วางบิล) จำกัดขนาด และย่อรูปฝั่ง client

### 4.3 หน้าในระบบที่ควรเพิ่มหรือปรับ (ต่อจากรอบ 11 และ 14)
1. **Open API → แท็บ MCP:** ทำแบบ 3 ขั้นตาม TRCloud
   - (1) Server URL พร้อมปุ่มคัดลอก
   - (2) แท็บตามโปรแกรม: Claude Code / Claude.ai / ChatGPT / Codex / อื่น ๆ (JSON config) พร้อมคำสั่งให้คัดลอก
   - (3) อธิบายว่าครั้งแรกต้อง login และกด Allow
   - เพิ่มส่วนที่ TRCloud ไม่มี: รายการการเชื่อมต่อที่ใช้งานอยู่ (client, ผู้ใช้, scope, ใช้ล่าสุด, เพิกถอน)
2. **แคตตาล็อก tool:** sidebar แบ่งหมวดตาม 4.1 ทุก tool มีหน้าแบบ TRCloud
   - ส่วน "เครื่องมือนี้ทำอะไร" มีชื่อ tool, ป้ายระดับ อ่าน/ร่าง/เขียน และ scope ที่ต้องใช้
   - ส่วน "วิธีเรียกใช้งาน" ใช้ประโยคตัวอย่างภาษาไทยแบบงานขนส่ง เช่น "พรุ่งนี้รับปูน 24 ตันที่อยุธยาส่งสระบุรี ขอรถพ่วง"
   - ส่วนพารามิเตอร์ใช้ตารางเดียวกับ API และรวม custom fields
   - มีส่วน "ข้อควรรู้" และแผงขวา "เครื่องมือในชุดนี้"
3. **เอกสาร REST API:** ทำ 3 แท็บต่อ endpoint แบบ TRCloud (คำอธิบายข้อมูล / ตัวอย่างโค้ด / ลองเรียก)
   - แท็บลองเรียกใช้ได้เฉพาะ Sandbox
   - ตารางฟิลด์แบ่งกลุ่ม Data / Object / Array และมีคอลัมน์ บังคับ, ชนิด, ความยาว, คำอธิบายไทย, ตัวอย่าง
4. **Dashboard การใช้ API:** แยกนับ Create / Read / Update / Other และ REST กับ MCP แยกกัน ดูรายปีได้ (ต่อยอดจากภาพรวม Open API รอบ 11)
5. **ช่องทางเชื่อมขาเข้าแบบ marketplace ของ TMS:**
   - TRCloud ดึงออเดอร์จาก Lazada, Shopee, TikTok
   - TMS ควรดึงงานจากระบบที่ลูกค้าของเราใช้ เช่น WMS, ERP ของผู้ส่งสินค้า, Shopee/Lazada (สำหรับขนส่งที่รับงาน e-commerce) และกล่องรับงาน LINE OA
   - ใช้ field mapping ที่ทำแล้วในรอบ 12
