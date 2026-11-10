# การตรวจสอบเลขนิติบุคคล/เลขผู้เสียภาษี 13 หลัก ตอนลูกค้าสมัครใช้ TMS SaaS (ไทย)

วันที่ค้นคว้า: 2026-11-03
วิธี: ค้นเว็บ + เปิดหน้าจริงด้วย WebFetch ทุกลิงก์ที่ระบุว่า "เปิดได้" ลิงก์ที่ระบุว่า "เปิดไม่ได้จาก sandbox" คือโดเมนที่ proxy ของ session นี้บล็อก (เช่น `datawarehouse.dbd.go.th`, `bdex.dbd.go.th`, `vsinter.rd.go.th`, `rdws.rd.go.th`) — ไม่ได้แปลว่าเว็บล่ม ต้องทดสอบจากเครื่องจริงอีกครั้ง

สัญลักษณ์: **[FACT]** = ยืนยันจากหน้าที่เปิดได้จริง / **[OPINION]** = ข้อเสนอของผู้เขียน / **[ไม่พบข้อมูล]** = ค้นแล้วไม่พบแหล่งที่ยืนยันได้

---

## 0. สรุปสั้น (TL;DR)

- **[FACT]** กรมสรรพากรมี SOAP Web Service สาธารณะ 2 ตัวที่เกี่ยวตรง ๆ และใช้ username/password = `anonymous`: **TIN Service** (เช็กว่าเลข 13 หลักมีจริงในฐานสรรพากร) และ **VAT Service** (ค้นผู้จด VAT ด้วย TIN + BranchNumber ได้ชื่อ/ที่อยู่/สาขา/วันจด VAT) — นี่คือทางที่ PEAK ใช้ prefill ชื่อ-ที่อยู่บริษัทตอนสมัคร
- **[FACT]** กรมพัฒน์ (DBD) มี 3 ช่องทาง: (ก) DBD DataWarehouse+ เว็บค้นฟรี ไม่มี API ทางการ (ข) Open Data CSV รายเดือน "นิติบุคคลจดทะเบียนตั้งใหม่" (ค) **BDEX** API ทางการสำหรับหน่วยงานรัฐ/เอกชน ต้องสมัคร-อนุมัติ-จ่ายค่าธรรมเนียมตามกฎหมาย (ไม่พบตัวเลขค่าธรรมเนียมที่เปิดเผย)
- **[FACT]** มี endpoint `https://openapi.dbd.go.th/api/v1/juristic_person/{เลข13หลัก}` ที่โปรเจกต์ third-party หลายตัวใช้โดยไม่ต้องมี key — แต่ไม่พบเอกสารทางการจาก DBD ที่ประกาศ endpoint นี้ และ third-party รายงานว่าโดน WAF 403 ตั้งแต่ ก.ย. 2026 → **ห้ามใช้เป็น primary ใน production** (OPINION)
- **[FACT]** checksum mod 11 ของเลขบัตรประชาชนใช้กับเลขนิติบุคคล (0xxxxxxxxxxxx) ได้ — ทดสอบกับเลขนิติบุคคลจริง 5 เลข ผ่านทั้งหมด
- **[OPINION]** Flow แนะนำ: checksum ฝั่ง client → RD VAT Service (prefill) → ถ้าไม่จด VAT ใช้ RD TIN Service ยืนยันว่ามีจริง → ถ้าไม่พบ/API ล่ม เข้าคิว manual review พร้อมแนบหนังสือรับรอง → cache 24 ชม.–7 วัน

---

## 1. กรมพัฒนาธุรกิจการค้า (DBD)

### 1.1 DBD DataWarehouse+ (datawarehouse.dbd.go.th)

- **[FACT]** เป็นเว็บค้นข้อมูลนิติบุคคลฟรี ("ไม่มีค่าใช้จ่าย") ใช้ได้ 24 ชม. ผ่าน dbd.go.th → Online Services หรือแอป DBD e-Service; ยอดใช้สะสม 84,454,294 ครั้ง ณ 2 ส.ค. 2026 — ที่มา: [ฐานเศรษฐกิจ 3 ส.ค. 2026](https://www.thansettakij.com/economy/665477) (เปิดได้)
- **[FACT]** ข้อมูลที่แสดงต่อนิติบุคคล: ข้อมูลทะเบียนปัจจุบัน, งบการเงิน (งบดุล/กำไรขาดทุน/อัตราส่วน เทียบปีก่อนและเทียบอุตสาหกรรม), สัดส่วนทุนตามสัญชาติ, ประวัติเปลี่ยนชื่อ/ทุน — ที่มาเดียวกัน
- **[FACT]** ที่อยู่สำนักงาน, **ข้อมูลสาขา**, ชื่อกรรมการและอำนาจลงนาม แสดงเฉพาะเมื่อค้นภาษาไทย; ดาวน์โหลด PDF/Excel ได้ — ที่มา: [Forvis Mazars, ก.ย. 2023](https://www.forvismazars.com/th/en/insights/doing-business-in-thailand/thai-legal-and-tax-updates-jp/datawarehouse) (เปิดได้)
- **[FACT]** บทความทั้งสองไม่กล่าวถึง API/bulk download/การต้อง login — ที่มา: สองลิงก์ด้านบน
- **[ไม่พบข้อมูล]** หน้า Terms of Use / เงื่อนไขการใช้ของ DataWarehouse+ (เปิด datawarehouse.dbd.go.th จาก sandbox ไม่ได้), rate limit, ความถี่อัปเดต
- **[FACT]** โปรเจกต์ third-party (`datawarehouse-dbd-mcp`) ระบุว่า DataWarehouse มี endpoint ภายใน `/api/v1/company-profiles/*` ฯลฯ ที่ต้องผ่าน Incapsula WAF ด้วย headless browser และใช้ JWT แบบ `ROLE_ANONYMOUS`; ผู้เขียนเตือนเองว่า "ไม่ใช่ API ทางการ อาจพังเมื่อ DBD เปลี่ยนเว็บ" — ที่มา: [glama.ai/datawarehouse-dbd-mcp](https://glama.ai/mcp/servers/sanookjung/datawarehouse-dbd-mcp/tree) (เปิดได้)
- **[FACT]** Apify actor `foxlabs/thailand-company-data` รายงานว่า host เดิม `datawarehouse2.dbd.go.th` ตอบ 504 เป็นช่วง ๆ และ **ปฏิเสธ IP นอกประเทศไทย**; host ใหม่ `datawarehouse.dbd.go.th` ล่มเมื่อ 26 ก.ย. 2026 — ที่มา: [apify.com/foxlabs/thailand-company-data](https://apify.com/foxlabs/thailand-company-data) (เปิดได้)
- **[OPINION]** การ scrape DataWarehouse ขัดกับประกาศ DBD เรื่องช่องทางที่ถูกต้อง (ดูข้อ 5) และเปราะบางเกินไปสำหรับ onboarding flow ที่ลูกค้ารอหน้าจอ → ไม่แนะนำ

### 1.2 DBD Open Data (opendata.dbd.go.th / bdex.dbd.go.th/opendata)

- **[FACT]** ชุด "นิติบุคคลจดทะเบียนตั้งใหม่" รายเดือน (dataset_11_01) เป็น CSV ต่อเดือน โหลดตรงจาก `https://openapi.dbd.go.th/juristic_person/registration/99_YYYYMM_1.csv` มี 11 คอลัมน์: เลขทะเบียน, ชื่อนิติบุคคล, วันที่จดทะเบียน, ทุนจดทะเบียน, รหัสวัตถุประสงค์, วัตถุประสงค์, ที่ตั้งสำนักงานใหญ่, ตำบล, อำเภอ, จังหวัด, รหัสไปรษณีย์ — ที่มา: [resource ม.ค. 2568](https://opendata.dbd.go.th/en/dataset/dataset_11_01/resource/b7670279-5a85-48b5-9cc0-93c77dac4ee5), [resource มี.ค. 2567](https://opendata.dbd.go.th/en/dataset/dataset_11_01/resource/1cc268fa-b468-4c62-8024-c87c8b7f875c) (เปิดได้ทั้งคู่)
- **[FACT]** **ไม่มีคอลัมน์ TSIC** ตรง ๆ (มีแค่รหัสวัตถุประสงค์), **ไม่มีสถานะ**, **ไม่มีสาขา**, และเป็นเฉพาะ "ตั้งใหม่" ในเดือนนั้น ไม่ใช่ทะเบียนทั้งหมด — ที่มาเดียวกัน
- **[FACT]** ชุดสถิติ (dataset_12_01 จำนวนจดใหม่รายจังหวัด, dataset_12_02 ทุนจดทะเบียนตั้งใหม่) ใช้ license **Open Data Common**, ไม่มีข้อจำกัดการเข้าถึง, อัปเดตรายเดือน, ติดต่อ กองข้อมูลธุรกิจ document@dbd.go.th — ที่มา: [dataset_12_01](https://opendata.dbd.go.th/en/dataset/dataset_12_01), [dataset_12_02](https://opendata.dbd.go.th/en/dataset/dataset_12_02) (เปิดได้)
- **[ไม่พบข้อมูล]** license ที่ระบุชัดบนหน้า dataset_11_01 (หน้า resource แสดง "Accessible Condition: ไม่มี" แต่ไม่ระบุชื่อ license), ขนาดไฟล์, จำนวนแถว, API key (ไม่มีการกล่าวถึง API/CKAN datastore เลย)
- **[OPINION]** ชุดนี้ใช้ทำ **cache เบื้องต้นสำหรับบริษัทจดใหม่** ได้ (โหลดย้อนหลังทุกเดือน) แต่ใช้แทน lookup แบบ real-time ไม่ได้ เพราะไม่มีสถานะ/สาขา/ทะเบียนเก่า

### 1.3 endpoint `openapi.dbd.go.th/api/v1/juristic_person/{id}` (ไม่พบเอกสารทางการ)

- **[FACT]** Third-party อย่างน้อย 3 ราย (Apify `foxlabs/thailand-company-data`, MCP `narinthon-so/thailand-data-mcp`, Apify `kindly_rafter/thailand-data-mcp`) ใช้ endpoint นี้โดย **ไม่ต้องมี API key** และได้ฟิลด์: ชื่อไทย/อังกฤษ, ประเภทนิติบุคคล, **สถานะ**, วันจดทะเบียน, **รหัส TSIC + คำอธิบาย TH/EN**, ทุนจดทะเบียน/ชำระแล้ว, ที่อยู่, ประเภทสำนักงาน (`branch`) — ที่มา: [apify foxlabs .md](https://apify.com/foxlabs/thailand-company-data.md), [glama thailand-data-mcp](https://glama.ai/mcp/servers/narinthon-so/thailand-data-mcp) (เปิดได้)
- **[FACT]** พฤติกรรมที่รายงาน: ตอบ JSON แต่ส่ง `Content-Type: text/html`; ไม่พบข้อมูล = status `"1004 No data available"`; 403/429 = WAF/rate-limit; **ตั้งแต่ 10 ก.ย. 2026 ตอบ 403 ให้ proxy นอกไทย** ต้องใช้ IP residential ไทย; MCP อ้างว่าอยู่ภายใต้ "DGA Open Government License" ที่ต้องให้ attribution — ที่มาเดียวกัน
- **[ไม่พบข้อมูล]** หน้าเอกสาร/ประกาศทางการของ DBD เกี่ยวกับ endpoint นี้, rate limit ที่เป็นตัวเลข, SLA, การรับประกันว่าจะคงอยู่
- **[OPINION]** ใช้ได้เป็น **secondary enrichment** (ดึง TSIC/ชื่ออังกฤษ/สถานะ) จาก server ที่อยู่ในไทย พร้อม timeout สั้นและ fallback ถ้าล้มเหลว ไม่ควรให้ flow สมัครขึ้นกับมัน

### 1.4 BDEX (Business Data Exchange) — API ทางการของ DBD

- **[FACT]** เปิดตัว เม.ย. 2024 ให้ทั้งหน่วยงานรัฐและ **เอกชนสมัครได้** ขั้นตอน: ลงทะเบียนที่ bdex.dbd.go.th → DBD อนุมัติ → ลงทะเบียนระบบ/ชุดข้อมูลที่จะเชื่อม → ทดสอบ → เรียกใช้ → **ชำระค่าธรรมเนียมและค่าบริการตามที่กฎหมายกำหนดก่อนรับบริการ**; ชุดข้อมูล: หนังสือรับรอง, บัญชีรายชื่อผู้ถือหุ้น, งบการเงิน, ทะเบียนพาณิชย์, การประกอบธุรกิจคนต่างด้าว, หลักประกันทางธุรกิจ, สมาคมการค้า/หอการค้า และ **Business Digital ID** (ตรวจผู้มีอำนาจกระทำการแทนนิติบุคคล) — ที่มา: [MGR Online 1 เม.ย. 2024](https://mgronline.com/smes/detail/9670000028494), [MGR Online](https://mgronline.com/business/detail/9670000028598) (เปิดได้)
- **[FACT]** ณ เม.ย. 2024 เชื่อมแล้ว 180 องค์กร (รัฐ 169 / **เอกชน 11**); Webservice เดิมใช้คู่ขนานถึง 30 ก.ย. 2568; ณ 14 ต.ค. 2025 มีหน่วยงานเชื่อม 155 แห่ง และเชิญเพิ่ม 226 แห่ง — ที่มา: ลิงก์ด้านบน + [MGR Online 14 ต.ค. 2025](https://mgronline.com/business/detail/9680000097966) (เปิดได้)
- **[ไม่พบข้อมูล]** อัตราค่าธรรมเนียมเป็นตัวเลข, rate limit, SLA, ระยะเวลาอนุมัติ, เงื่อนไขว่า SaaS เอกชนรายเล็กจะผ่านเกณฑ์ไหม (bdex.dbd.go.th เปิดจาก sandbox ไม่ได้)
- **[OPINION]** นี่คือทางที่ "ถูกต้องและยั่งยืน" ที่สุดสำหรับดึงข้อมูลนิติบุคคลเชิงพาณิชย์ แต่ต้องมีคนไปสมัครและรออนุมัติ → วางเป็น Phase 2; Phase 1 ใช้สรรพากร (ข้อ 2)

---

## 2. กรมสรรพากร (RD)

### 2.1 VAT INFO (เว็บค้นด้วยมือ)

- **[FACT]** URL `https://vsinter.rd.go.th/rd-webcontent-web/#/vatsearch` ฟรี ค้นด้วยเลข 13 หลัก (สาขาไม่บังคับ) หรือชื่อ; ผลลัพธ์: เลขผู้เสียภาษี, **สาขา**, ชื่อผู้ประกอบการ/สถานประกอบการ, ที่อยู่, วันจดทะเบียน VAT, ประวัติการจดทะเบียน; ไม่พบ = แสดงข้อความปฏิเสธ — ที่มา: [FlowAccount blog "VAT INFO"](https://flowaccount.com/blog/vat-info/) (เปิดได้; หน้า vsinter เปิดจาก sandbox ไม่ได้)
- **[FACT]** บทความ FlowAccount ไม่ได้บอกว่า FlowAccount เชื่อม VAT INFO ด้วย API — ที่มาเดียวกัน

### 2.2 RD Web Services (SOAP) — มี API สาธารณะจริง

- **[FACT] TIN Service** `https://rdws.rd.go.th/serviceRD3/checktinpinservice.asmx` — operations `ServiceTIN` (1 เลข) / `ServiceTINArr` (หลายเลข คั่น comma); input: username=`anonymous`, password=`anonymous`, TIN 13 หลัก; output: เลขที่ส่ง, ถูกต้อง/ไม่ถูกต้อง, **มีอยู่ในฐานสรรพากรหรือไม่**; วัตถุประสงค์ "ป้องกันการปลอมเลข"; อัปเดตหน้า 22-03-2025; ติดต่อ webservice@rd.go.th — ที่มา: [rd.go.th/42533.html](https://rd.go.th/42533.html) (เปิดได้)
- **[FACT] VAT Service** `https://rdws.rd.go.th/serviceRD3/vatserviceRD3.asmx` — operations `Service` / `ServiceArr`; input: username/password=`anonymous`, TIN 13 หลัก, **BranchNumber** (ใส่ 0 ถ้าไม่รู้), Name, ProvinceCode, AmphurCode (0 ถ้าไม่รู้); output: NID 13 หลัก, **BranchNumber**, คำนำหน้า+ชื่อสาขา, ที่อยู่แยกฟิลด์ (อาคาร ห้อง ชั้น หมู่บ้าน เลขที่ หมู่ ซอย ถนน ตำบล อำเภอ จังหวัด ไปรษณีย์), **BusinessFirstDate** (วันที่อนุมัติเป็นผู้จด VAT); หน้าเตือนว่าสถานะเปลี่ยนได้; อัปเดต 31-01-2025 — ที่มา: [rd.go.th/42535.html](https://rd.go.th/42535.html) (เปิดได้)
- **[FACT]** ตัวอย่าง request เป็น SOAP 1.2 `Content-Type: application/soap+xml; charset=utf-8` และ "เครื่องที่เรียกต้องติดตั้ง SSL certificate" — ที่มา: [Sample_SOAP_Request_V5.pdf](https://rd.go.th/fileadmin/webservice/Sample_SOAP_Request_V5.pdf) (เปิดได้)
- **[FACT]** บริการอื่นในชุดเดียวกัน: Common Service (รหัสจังหวัด/อำเภอ), VRT (ร้านคืน VAT นักท่องเที่ยว ค้นด้วยชื่อร้าน ไม่ใช่ TIN), TCL, CIT, Joint, ETAX; ส่วน "Datawarehouse: RDVATServices" เป็นสรุปยอด VAT รายพื้นที่ **สำหรับหน่วยงานรัฐ ต้องทำหนังสือถึงอธิบดีขอ username/password** — ที่มา: [rd.go.th/42534.html](https://rd.go.th/42534.html), [rd.go.th/43491.html](https://rd.go.th/43491.html) (เปิดได้)
- **[FACT]** Library โอเพนซอร์ส `borisat` (Python) ใช้ SOAP ของสรรพากรนี้และคืนฟิลด์ตรงกับ VAT Service (NID, BranchNumber, BranchName, BusinessFirstDate, ที่อยู่แยกฟิลด์) — ที่มา: [github.com/wasdee/borisat](https://github.com/wasdee/borisat) (เปิดได้)
- **[ไม่พบข้อมูล]** หน้า Terms of Use เฉพาะของ Web Service, rate limit, SLA, uptime (หน้าไม่ระบุ); ไม่สามารถ fetch WSDL จาก sandbox เพื่อยืนยันว่า endpoint ยัง live ณ วันนี้ — **ต้องทดสอบจริงก่อนตัดสินใจ**
- **[FACT]** PEAK ใช้วิธีนี้: ในขั้นสมัครกิจการ "หากเลข 13 หลักเป็นบริษัท ระบบจะค้นฐานข้อมูลกรมสรรพากรและกรอกชื่อ-ที่อยู่ให้อัตโนมัติ" — ที่มา: [PEAK Help NS001](https://intercom.help/peak/en/articles/6013772-สมัครและสร-างกิจการ-ใน-peak-เพื-อเริ-มต-นการใช-งาน-ns001) (เปิดได้)
- **[OPINION]** ข้อจำกัดสำคัญของ VAT Service: **บริษัทที่ไม่จด VAT จะไม่พบ** (รายได้ < 1.8 ล้าน/ปี) → ต้องใช้ TIN Service ยืนยัน "มีอยู่จริง" แล้วส่ง manual review; และ VAT Service ไม่ให้สถานะ "ร้าง/เลิก" ของนิติบุคคล (ให้แค่ข้อมูล VAT) → ถ้าต้องกันบริษัทเลิกกิจการ ต้องเสริมด้วย DBD

---

## 3. data.go.th (ศูนย์กลางข้อมูลเปิดภาครัฐ)

- **[FACT]** ชุดที่ชื่อ "ทะเบียนนิติบุคคล…" บน data.go.th / gdcc.data.go.th ส่วนใหญ่เป็น **สถิติรายจังหวัดที่สำนักงานจังหวัดอัปโหลด** (เช่น สระบุรี, ลพบุรี) ไม่ใช่รายชื่อนิติบุคคล: "ทะเบียนนิติบุคคลที่คงอยู่และทุนจดทะเบียน" (รายปี, CSV/XLSX, license ไม่ระบุ, ข้อมูลล่าสุด 31 พ.ค. 2023), "ทะเบียนนิติบุคคลใหม่" (รายปี, license ไม่ระบุ), "ทะเบียนนิติบุคคลตั้งใหม่" ลพบุรี (รายปี, Open Data Common, อัปเดต 2026-07-13) — ที่มา: [registration-type](https://gdcc.data.go.th/en/dataset/registration-type), [corporate-registration](https://gdcc.data.go.th/en/dataset/corporate-registration), [12_307](https://data.go.th/en/dataset/12_307) (เปิดได้ทั้งหมด; หน้ามี template placeholder ค้าง ทำให้ไม่เห็นขนาด/จำนวนแถว)
- **[FACT]** ไม่มีหน้าใดระบุ API endpoint; มีแค่ปุ่ม Download และ Data Key — ที่มาเดียวกัน
- **[ไม่พบข้อมูล]** ชุดข้อมูลบน data.go.th ที่เป็น "ทะเบียนนิติบุคคลทั้งประเทศรายบริษัท" พร้อม API (เปิดหน้า organization/dbd จาก sandbox ไม่ได้)
- **[OPINION]** data.go.th ไม่ใช่แหล่งที่ใช้งานได้สำหรับ lookup รายบริษัท; ชุดจริงอยู่ที่ opendata.dbd.go.th (ข้อ 1.2)

---

## 4. ผู้ให้บริการเอกชน

| ผู้ให้บริการ | มี API | ฟิลด์ที่ยืนยันได้ | ราคา | สมัคร | ที่มา |
|---|---|---|---|---|---|
| **Creden Data** (data.creden.co) | **[FACT]** มี API เชื่อมระบบองค์กร (ไม่มี doc สาธารณะ) | งบการเงิน, อัตราส่วน, กรรมการ/ผู้ถือหุ้น, จัดซื้อจัดจ้างภาครัฐ, อันดับ; ครอบคลุม ~1.7 ล้านบริษัท; **ไม่ระบุว่าค้นด้วยเลขผู้เสียภาษีผ่าน API ได้ไหม** | **[FACT]** Free trial (มูลค่า 1,500 บ.), แผน Point-based (จ่ายต่อบริษัทที่ดู) และ Time-based; **ไม่เปิดเผยตัวเลข** | ฟอร์ม data.creden.co/register ติดต่อกลับใน 2 วันทำการ; credendata@creden.co | [landing page](https://data.creden.co/landing-page) (เปิดได้) |
| **BOL Corpus X** (bol.co.th) | **[FACT]** มี API "แสดงข้อมูล Corpus X ในระบบของตนเองอัตโนมัติ" | ฐานข้อมูลย้อนหลัง 20 ปี มาตรฐานเดียวกับสถาบันการเงิน, Credit/Prospect Score, D&B; **ไม่ระบุรายฟิลด์ (สาขา/สถานะ)** | **[ไม่พบข้อมูล]** ราคา/SLA | free trial ที่ corpusx.bol.co.th; 02 657 3999 / info@bol.co.th | [bol.co.th/corpusx](https://bol.co.th/corpusx/) (เปิดได้) |
| **DATA for Thai** (dataforthai.com) | **[FACT]** Terms ระบุว่ามี API/dataset แบบเสียเงิน | ทะเบียน, งบ, จัดซื้อจัดจ้าง; ระบุชัดว่า "ไม่ใช่เอกสารทางราชการ อาจคลาดเคลื่อน" | **[ไม่พบข้อมูล]** ตัวเลข | — | [dataforthai.com/terms](https://www.dataforthai.com/terms) (เปิดได้) |
| **Apify foxlabs/thailand-company-data** | **[FACT]** REST ผ่าน Apify | ชื่อ TH/EN, สถานะ, วันจด, TSIC, ทุน, ที่อยู่, งบ 1–5 ปี, กรรมการ/อำนาจลงนาม | **[FACT]** $0.025/record (~$25/1,000) | บัญชี Apify | [apify.com/foxlabs](https://apify.com/foxlabs/thailand-company-data) (เปิดได้) |
| **Enlite / บริษัทข้อมูลเครดิต** | **[ไม่พบข้อมูล]** ค้นแล้วไม่พบบริการ API ตรวจนิติบุคคลสาธารณะในชื่อนี้ | — | — | — | — |
| **Thai-API** | **[ไม่พบข้อมูล]** ค้นแล้วไม่พบผู้ให้บริการชื่อนี้ที่ยืนยันได้ | — | — | — | — |

- **[FACT]** ไม่พบหลักฐานว่า FlowAccount ใช้ API ของใครในการ prefill; PEAK ระบุชัดว่าใช้ "ฐานข้อมูลกรมสรรพากร" (ข้อ 2.2)
- **[OPINION]** Apify actor เป็น scraper ของเอกชนต่างชาติที่ "อ่าน DBD live" — เรื่องความชอบด้วยกฎหมายต่อประกาศ DBD (ข้อ 5) และ PDPA เป็นภาระของผู้ใช้; ใช้ได้เฉพาะงาน enrichment ภายใน ไม่ควรเป็นเส้นทาง onboarding
- **[OPINION]** Creden/BOL เหมาะเมื่อต้องการ credit scoring ของลูกค้าขนส่ง (เช่น ให้เครดิตเทอม) มากกว่าแค่ยืนยันตัวตน; ราคาต้องขอใบเสนอราคา

---

## 5. ข้อกฎหมาย

### 5.1 ใช้ข้อมูล DBD เชิงพาณิชย์ได้ไหม

- **[FACT]** DBD ออกประกาศนโยบายการเปิดเผยข้อมูลนิติบุคคล แบ่ง 3 ระดับ: (1) **Government Open Data** — ฟรี ใช้ได้ทุกวัตถุประสงค์ ครอบคลุม **เลขทะเบียน, ประเภท, ชื่อ, วันจดทะเบียน, สถานะ, ทุนจดทะเบียน, ที่ตั้ง, วัตถุประสงค์**; (2) **Conditional Share Data** — ข้อมูลบริษัท/งบ/ผู้ถือหุ้น/ทะเบียนพาณิชย์ ฯลฯ ต้องปฏิบัติตามเงื่อนไข; (3) **Confidential** — เปิดไม่ได้ — ที่มา: [InfoQuest "พาณิชย์ ออกประกาศวิธีใช้บริการข้อมูลนิติบุคคลที่ถูกต้อง"](https://www.infoquest.co.th/?p=20170) (เปิดได้)
- **[FACT]** ประกาศเดียวกันเตือนว่า **ห้ามนำข้อมูลไปรวบรวม/วิเคราะห์เป็นชุดข้อมูลส่วนบุคคลใหม่** ที่ทำให้ค้นได้ว่าใครเป็นหุ้นส่วน/กรรมการ/ผู้ถือหุ้นของบริษัทใด มิฉะนั้นอาจถูกดำเนินคดีตาม PDPA 2562; ให้ใช้ตามวัตถุประสงค์ที่แจ้ง DBD และเข้าถึงผ่าน www.dbd.go.th หรือแอป DBD e-Service เท่านั้น — ที่มาเดียวกัน
- **[OPINION]** การใช้ **ชื่อ/ที่อยู่/สถานะ/ทุน/วันจด/วัตถุประสงค์ของนิติบุคคล** เพื่อ prefill และยืนยันตัวตนลูกค้า B2B อยู่ในระดับ Open Data และเป็น "ข้อมูลนิติบุคคล" ไม่ใช่ข้อมูลส่วนบุคคล → ทำได้ แต่ **อย่าเก็บชื่อกรรมการ/ผู้ถือหุ้นมาสร้างฐานค้นหา** และควรแสดง attribution "ที่มา: กรมพัฒนาธุรกิจการค้า"
- **[ไม่พบข้อมูล]** ข้อความประกาศฉบับเต็ม (ราชกิจจานุเบกษา/หน้า dbd.go.th) — ควรให้ฝ่ายกฎหมายดึงมาอ่านอีกครั้ง

### 5.2 PDPA กรณีเจ้าของกิจการบุคคลธรรมดา (เลขบัตรประชาชน = เลขผู้เสียภาษี)

- **[FACT]** PDPA มีฐานกฎหมายที่ไม่ต้องขอ consent ได้แก่ **ฐานสัญญา** (ใช้ข้อมูลเพื่อปฏิบัติตามสัญญาที่เจ้าของข้อมูลเป็นคู่สัญญา), **ฐานหน้าที่ตามกฎหมาย** (เช่น ส่งข้อมูลให้สรรพากร), **ฐานประโยชน์โดยชอบด้วยกฎหมาย**, ฐานช่วยชีวิต, ฐานภารกิจรัฐ; มาตรา 19 เป็นหลัก consent, มาตรา 4 เป็นข้อยกเว้นที่กฎหมายไม่ใช้บังคับ — ที่มา: [Thai PBS "PDPA กับ 6 ข้อยกเว้น"](https://www.thaipbs.or.th/now/content/3028) (เปิดได้; เป็นสื่อ ไม่ใช่ตัวบทกฎหมาย)
- **[OPINION]** สำหรับ TMS: เลขบัตรประชาชนของเจ้าของกิจการบุคคลธรรมดาเป็น "ข้อมูลส่วนบุคคล" → เก็บได้โดยอาศัย **ฐานสัญญา** (จำเป็นเพื่อออกใบกำกับภาษี/ทำสัญญาบริการ) และ **ฐานหน้าที่ตามกฎหมาย** (ประมวลรัษฎากรกำหนดให้ใบกำกับภาษีมีเลขผู้เสียภาษีผู้ซื้อ) **ไม่ต้องขอ consent แยก** แต่ต้อง (ก) แจ้ง Privacy Notice ตอนสมัคร (ข) เก็บแค่ที่จำเป็น (ค) เข้ารหัส/mask เลขในระบบ (ง) การส่งเลขไป RD Web Service เป็นการเปิดเผยต่อหน่วยงานรัฐเพื่อตรวจสอบ → ระบุไว้ใน Notice; ให้ฝ่ายกฎหมายยืนยัน
- **[OPINION]** ถ้าจะใช้ข้อมูลไปทำ marketing/credit scoring เพิ่ม → ต้องใช้ฐานอื่น (legitimate interest + opt-out หรือ consent)

---

## 6. ตรวจ checksum เลข 13 หลักฝั่ง client

- **[FACT]** เลขนิติบุคคลที่ DBD ออก (เริ่มด้วย 0) "ตามมาตรฐานเลขประจำตัวประชาชน (PIN)" และสรรพากรใช้เลขเดียวกันเป็น TIN ของนิติบุคคล; หลักที่ 13 เป็น check digit — ที่มา: [python-stdnum issue #118](https://github.com/arthurdejong/python-stdnum/issues/118) (เปิดได้; ไม่ได้ระบุสูตร)
- **[FACT]** ทดสอบสูตร mod 11 ของเลขบัตรประชาชนกับเลขนิติบุคคลจริงที่ปรากฏบนหน้าเว็บสาธารณะ 5 เลข (0105567153766, 0465566000581, 0105560098301, 0107536000633, 0105536092641) → **ผ่านทั้ง 5** (รันเองในรายงานนี้) → ใช้สูตรเดียวกันได้
- สูตร: ผลรวม(หลักที่ i × (14−i)) สำหรับ i=1..12 (น้ำหนัก 13,12,…,2) → `check = (11 − sum mod 11) mod 10` → ต้องเท่ากับหลักที่ 13

```ts
export function isValidThaiId13(s: string): boolean {
  if (!/^\d{13}$/.test(s)) return false;
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += Number(s[i]) * (13 - i);
  return (11 - (sum % 11)) % 10 === Number(s[12]);
}
// ประเภทจากหลักแรก (OPINION จากโครงสร้างเลข): '0' = นิติบุคคล (DBD), '1'-'8' = บุคคลธรรมดา
```

- **[OPINION]** checksum กันพิมพ์ผิดได้เท่านั้น กันเลขปลอมไม่ได้ (คนปลอมสร้างเลขที่ checksum ถูกได้ง่าย) → ต้องมี lookup จริงตามข้อ 2 เสมอ; ใช้ checksum เพื่อลด API call ที่เสียเปล่าและแสดง error ทันทีบน UI

---

## 7. แบบที่แนะนำ (OPINION ทั้งหมด)

### 7.1 Flow สมัคร

1. **UI**: กรอกเลข 13 หลัก + เลือก "สำนักงานใหญ่ (00000) / สาขา (xxxxx)"; validate checksum ทันทีฝั่ง client; ถ้าหลักแรก ≠ 0 แจ้งว่าเป็นบุคคลธรรมดา (เปิดเส้นทางสมัครแบบบุคคล + Privacy Notice)
2. **Dedup**: ก่อนเรียก API เช็ก `tenants` ว่ามี `(tax_id, branch_no)` อยู่แล้วไหม → ถ้ามี เสนอ "ขอเข้าร่วม organization เดิม" แทนสร้างใหม่ (unique index บน `(tax_id, branch_no)`)
3. **Lookup ชั้น 1 — RD VAT Service** (`Service` TIN+BranchNumber): ถ้าพบ → prefill ชื่อ, ที่อยู่แยกฟิลด์, สาขา, วันจด VAT; mark `verification = AUTO_VAT`
4. **Lookup ชั้น 2 — RD TIN Service**: ถ้า VAT ไม่พบแต่ TIN "exists" → ให้กรอกชื่อ/ที่อยู่เอง + อัปโหลดหนังสือรับรอง → `verification = PENDING_MANUAL`
5. **Enrichment (async, ไม่บล็อก UI)**: เรียก `openapi.dbd.go.th/api/v1/juristic_person/{id}` จาก server ในไทย timeout 3 วิ → เติม TSIC/ชื่ออังกฤษ/สถานะ/ทุน; ถ้าสถานะไม่ใช่ "ยังดำเนินกิจการอยู่" → flag ให้ admin ดู; ล้มเหลวก็ปล่อยผ่าน
6. **ไม่พบทั้ง VAT และ TIN** หรือ API ล่ม (timeout/403/5xx) → ไม่ปฏิเสธลูกค้า แต่สร้างบัญชีสถานะ `PENDING_MANUAL` ให้ใช้ trial ได้จำกัด; เข้าคิว admin ตรวจกับ DBD DataWarehouse+ ด้วยมือ (ฟรี) ภายใน 1 วันทำการ
7. **Phase 2**: สมัคร BDEX เพื่อแทนขั้น 5 ด้วย API ทางการ และดึง Business Digital ID ยืนยันผู้มีอำนาจลงนาม

### 7.2 Fallback และ caching

- Circuit breaker ต่อ upstream (RD SOAP, DBD openapi): ล้มเหลวติดกัน 5 ครั้ง → เปิดวงจร 5 นาที → ส่งทุกเคสเข้า PENDING_MANUAL อัตโนมัติ
- Cache ผล lookup ใน `company_lookups` (key = tax_id+branch) TTL **24 ชม.** สำหรับผล "พบ" (เพื่อให้ลูกค้ากด retry ไม่ยิงซ้ำ) และ **1 ชม.** สำหรับ "ไม่พบ"; เก็บ snapshot ถาวรใน tenant record พร้อม `verified_at`, `source`
- Re-verify ทุก 90 วัน (background job) เพื่อจับบริษัทเลิกกิจการ/เปลี่ยนที่อยู่
- โหลด CSV รายเดือนจาก opendata.dbd.go.th (ข้อ 1.2) เข้า `dbd_new_registrations` เพื่อใช้เป็น fallback เมื่อบริษัทจดใหม่ยังไม่จด VAT
- เก็บ raw response (XML/JSON) ไว้ 90 วันเพื่อ audit; log ทุก request ว่าส่งเลขอะไรไปหน่วยงานใด (รองรับ PDPA accountability)
- ส่ง SOAP จาก server ภายใน (ไม่ใช่ browser) และตั้ง concurrency ≤ 2 ต่อ upstream เพราะไม่มี rate limit ประกาศ

### 7.3 ตัวอย่าง response JSON ภายในที่คาดหวัง (normalized)

```json
{
  "taxId": "0105567153766",
  "branchNo": "00000",
  "checksumValid": true,
  "verification": {
    "status": "AUTO_VAT",
    "sources": ["RD_VAT_SERVICE", "DBD_OPENAPI"],
    "verifiedAt": "2026-11-03T09:12:44+07:00",
    "cacheTtlSec": 86400
  },
  "rd": {
    "exists": true,
    "vatRegistered": true,
    "vatFirstDate": "2024-05-02",
    "branchName": "สำนักงานใหญ่",
    "titleName": "บริษัท",
    "name": "ตัวอย่างขนส่ง จำกัด",
    "address": {
      "buildingName": null, "roomNo": null, "floor": null, "villageName": null,
      "houseNo": "99/1", "moo": "4", "soi": null, "street": "พระราม 2",
      "subDistrict": "แสมดำ", "district": "บางขุนเทียน",
      "province": "กรุงเทพมหานคร", "postCode": "10150"
    }
  },
  "dbd": {
    "fetched": true,
    "nameTh": "บริษัท ตัวอย่างขนส่ง จำกัด",
    "nameEn": "EXAMPLE TRANSPORT CO., LTD.",
    "entityType": "บริษัทจำกัด",
    "status": "ยังดำเนินกิจการอยู่",
    "registerDate": "2024-03-14",
    "registeredCapitalBaht": 1000000,
    "paidUpCapitalBaht": 1000000,
    "tsic": { "code": "49323", "textTh": "การขนส่งสินค้าอื่นๆ ทางถนน" },
    "attribution": "ที่มา: กรมพัฒนาธุรกิจการค้า (Open Data)"
  },
  "flags": [],
  "duplicateTenantId": null
}
```

กรณีไม่พบ / ต้องตรวจด้วยคน:

```json
{
  "taxId": "0105500000011",
  "branchNo": "00000",
  "checksumValid": true,
  "verification": { "status": "PENDING_MANUAL", "sources": [], "reason": "RD_VAT_NOT_FOUND_TIN_EXISTS" },
  "rd": { "exists": true, "vatRegistered": false },
  "dbd": { "fetched": false, "error": "UPSTREAM_403" },
  "flags": ["NEED_CERTIFICATE_UPLOAD"],
  "duplicateTenantId": null
}
```

---

## 8. สิ่งที่ต้องทำต่อ (action items)

1. ทดสอบจริงจากเครื่องในไทย: WSDL `https://rdws.rd.go.th/serviceRD3/vatserviceRD3.asmx?WSDL` และ `checktinpinservice.asmx?WSDL` + ยิง `Service` ด้วย TIN ของบริษัทตัวเองเพื่อยืนยันฟิลด์และ latency (sandbox นี้ถูก proxy บล็อก)
2. ทดสอบ `https://openapi.dbd.go.th/api/v1/juristic_person/{id}` จาก IP ไทย บันทึก response schema จริง และยืนยัน license/attribution ที่ DBD ระบุ
3. เปิด bdex.dbd.go.th อ่านเงื่อนไข/ค่าธรรมเนียมสำหรับเอกชน แล้วตัดสินใจเรื่อง Phase 2
4. ให้ฝ่ายกฎหมายอ่านประกาศ DBD ฉบับเต็มและร่าง Privacy Notice ข้อ 5.2
5. ติดต่อ Creden/BOL ขอใบเสนอราคาเฉพาะถ้าต้องการ credit scoring
