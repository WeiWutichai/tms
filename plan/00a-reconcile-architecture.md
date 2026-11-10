# 00a — Reconcile ระดับสถาปัตยกรรม: docs v2 ↔ spec

> จัดทำ 10 พ.ย. 2569 · เทียบ `docs/01-tms-architecture-and-integration.md` (v2, เจ้าของเขียน 3–4 พ.ย.) กับ `spec/10`, `03`, `04`, `05`, `07`, `11` (เขียน 9 พ.ย. โดยไม่ได้อ่าน docs/)
> กติกาตัดสิน: **docs v2 เป็นฐาน** ของสถาปัตยกรรม / data model / state machine / มาตรฐาน API → ใช้ docs เป็นค่าเริ่มต้น; ใช้ spec เมื่อเป็นของใหม่กว่า (รอบออกแบบ 5–18: fleet เพิ่มเติม, custom fields, field mapping, Open API UI/MCP, AI, one-platform, exception center, แจ้งลูกค้า) หรือ docs ไม่ได้พูดถึง
> การอ้างอิง: `docs §x` = หัวข้อใน docs/01 (ถ้าเป็นไฟล์อื่นเขียน `docs/04 J`); `spec/10 DM-004` = ไฟล์ + รหัสข้อกำหนด
> ไฟล์นี้ไม่แก้ docs/ spec/ research/ — เป็นรายการให้เจ้าของและทีมใช้ตัดสินก่อนเขียน Prisma schema

## 1. สรุป

สองชุด **ตรงกันในระดับหลักการ** (standalone-first, ERP เป็น connector ไม่ hard-code, shared schema + RLS + 404 ข้าม tenant, TMS เป็น system of record, เอกสารภาษีอยู่ใน core, เลขออกตอน finalize, `vat_type`/`wht_rate` snapshot ต่อบรรทัด, มาตรฐาน API จาก benchmark §9) แต่ **ต่างกันมากในระดับ schema, ชื่อ, และ state machine** — เขียน Prisma จากสองชุดพร้อมกันไม่ได้ และ spec เองก็ขัดกันเองระหว่างไฟล์ (§2.9) ความขัดแย้งสำคัญ 10 ข้อ:

1. **API-first** — docs: UI เป็น client ของ `/v1` ตั้งแต่ sprint แรก (§1 #2, §8.3 ข้อ 2); spec: Open API เป็นฟีเจอร์ P1 และไม่ได้ระบุว่า UI ใช้ `/v1` (spec/07 §5, INT-002) → **ตาม docs**; entitlement `api.open_api` ของ spec ใช้คุม "การเปิดให้ลูกค้า" ไม่ใช่การมีอยู่ของ API
2. **ตารางเอกสาร AR** — docs: ตารางแยก `billing_note` / `invoice` / `adjustment_note` / `receipt` (§3.4); spec/10: ตารางเดียว `SalesDocument` + `docType` [PROPOSED] → **ตาม docs** (spec/05 เองก็เขียนเป็น entity แยก)
3. **ที่อยู่ของเลขใบกำกับภาษี** — docs: `invoice.tax_invoice_no` + `receipt.is_tax_invoice`; spec: เอกสาร RT แยกต่อการรับเงิน 1 ครั้ง (spec/05 BIL-053) → โครง docs รองรับรับชำระบางส่วนหลายครั้งไม่ได้ → **RA-1**
4. **แก้/ยกเลิกหลัง ISSUED** — docs: credit/debit note เท่านั้น + `VOIDED` (§4.4); spec: ยกเลิก INV ได้, มี ACN/ADN ภายใน, ยกเลิก RT แล้วออกใหม่ (spec/05 §6–7) → **RA-2**
5. **State machine ของ SO** — docs: `RECEIVED / ON_HOLD + reason_code …CLOSED` (§4.1); spec: `draft / confirmed / partially_planned …completed` ไม่มี ON_HOLD (spec/03 §2.6) → **ตาม docs + เพิ่ม `DRAFT`** (RA-3)
6. **DO** — docs: status แกนเดียวรวมการวางบิล, 1 DO อยู่ 1 trip (§3.3, §4.3); spec: 3 แกน (`status`/`podStatus`/`billingStatus`), มี `picked_up`/`arrived`, DO อยู่หลายเที่ยวได้ (spec/10 `TripStopDelivery`) → **RA-5**
7. **Trip** — docs: `PLANNING/OFFERED/ASSIGNED/…/COSTED/SETTLED` + ข้อเสนอรถร่วมเก็บบน trip (§4.2); spec: `draft/planned/dispatched/accepted/rejected/…/closed` + ตาราง `SubcontractOffer` → **ตาม docs + เพิ่ม ACCEPTED และตาราง offer** (RA-6)
8. **บรรทัดราคา/ต้นทุน** — docs: `delivery_order.sell_rate_snapshot` + `do_surcharge` + `trip_cost` (§3.3); spec: `ChargeLine` ตารางเดียวสองฝั่ง ผูก SO/DO/Trip (spec/10 §5.4) → **RA-7**
9. **ชื่อและ casing** — docs: snake_case, enum `UPPER_SNAKE` ใน DB / lowercase ใน API, `company`/`carrier`/`service_item`/`delivery-orders`; spec: enum lowercase (10) ปน UPPERCASE (05), `LegalEntity`/`Subcontractor`/`ChargeType`/`shipments` → **ตาม docs** (ชื่อ resource DO = RA-8)
10. **Integration layer** — docs: `ErpAdapter` + capabilities + ErrorClass 8 แบบ + outbox คิวเดียว + reconcile 4 รอบ + `taxDocumentOwner` (§6–7); spec: `SyncRecord`/`syncStatus` 3 เวอร์ชัน, retry คนละตาราง, เลขชั่วคราว `TMP-` เมื่อ ERP ออกเลข, operation `void` (spec/07 §1–2) → **ตาม docs**; โหมดเลข external = RA-9

## 2. ตารางเปรียบเทียบรายหัวข้อ

### 2.1 หลักการ

| หัวข้อ | docs v2 ระบุ | spec ระบุ | ประเภท | ข้อเสนอ |
|---|---|---|---|---|
| Standalone-first | §1 #1: ทุก flow จบได้โดยไม่มี connector; `StandaloneAdapter` (no-op) เป็น default ทุก tenant | spec/00 D1; spec/07 INT-010/011: การ์ด "ไม่เชื่อม" เป็นค่าเริ่มต้น connector ล่มแล้วออกเอกสารได้ปกติ | ตรงกัน | ใช้ทั้งคู่ — `StandaloneAdapter` คือ implementation ของการ์ด "ไม่เชื่อม" |
| ERP หลายตัว ไม่ผูก KRS | หน้าแรก + Appendix A: KRS = connector ตัวแรก ข้อเท็จจริง KRS อยู่ในภาคผนวกเท่านั้น | spec/00 D2; spec/07 INT-010: ห้ามมี connector เป็นค่าเริ่มต้น เรียงตามตัวอักษร | ตรงกัน (spec เพิ่มกติกา UI) | ตาม docs + กติกา UI ของ spec; "ตัวแรก" ของ docs หมายถึงลำดับ dev ไม่ใช่ค่าเริ่มต้นใน UI (ลำดับ = RA-13) |
| API-first / UI ใช้ `/v1` เดียวกัน | §1 #2, §2, §5.4: ไม่มี endpoint internal ยกเว้น auth; OpenAPI generate จาก code; CI ตรวจ breaking change; UI สร้างบน API ตั้งแต่ sprint แรก (§8.3 ข้อ 2) | spec/00 D6: REST/MCP/webhook/เอกสารใช้ schema เดียว; spec/07 INT-002: "ทุกช่องทางผ่าน application service เดียว"; Open API = ฟีเจอร์ตามแพ็กเกจ เฟส P1 (spec/07 §5 ข้อ 10) — ไม่มีข้อใดบอกว่า UI เรียก `/v1` | ขัดกัน | **ตาม docs**: `/v1` ต้องมีตั้งแต่ P0 เพราะ UI ใช้; `api.open_api` (spec/01, ใหม่กว่า) คุมเฉพาะการออก API key/webhook ให้ลูกค้า; D6 ของ spec เป็นผลพลอยได้ของหลักนี้ |
| Multi-tenant shared schema + RLS | §1 #3: `tenant_id` ทุกตาราง, Prisma extension, RLS ชั้นสอง, unique เริ่มด้วย `tenant_id`, ข้าม tenant = 404 | spec/10 DM-001/002, DM-020–028 (policy SQL, `SET LOCAL app.tenant_id`, fail-closed, role `tms_app` ไม่มี BYPASSRLS, test ทุกตาราง §2.5); spec/11 NFR-133 (404) | ตรงกัน (spec ละเอียดกว่า) | ตาม docs; รับรายละเอียด DM-020–028 เข้า docs |
| ชั้นตาราง platform ที่ไม่มี RLS | ไม่ระบุ ("ทุกตารางมี `tenant_id`" §3) | spec/10 §2.1, DM-003: Plan/Tenant/PlatformUser ฯลฯ ไม่มี RLS; `User` เป็น global identity ข้าม tenant | spec เพิ่ม | ตาม spec (one-platform รอบ 4/13 ใหม่กว่า) — docs ต้องเพิ่มข้อยกเว้นของ "ทุกตาราง" |
| TMS = system of record | §1 #4: แก้ใน TMS แล้ว sync ออก ห้ามแก้/ลบใน ERP; จับความต่างด้วย reconcile | spec/05 BIL-182: ไม่รับการแก้เอกสารจาก ERP รับกลับแค่สถานะรับชำระ; spec/07 INT-025; แต่ INT-012 ให้ master data sync `both` แบบ "แก้ล่าสุดชนะ" | ตรงกัน (เอกสาร) / spec เพิ่ม (master 2 ทาง) | ตาม docs; master `both` ไม่มีใน `ErpAdapter` (§6.1) → ไม่ทำใน P1 ถ้าจะทำต้องเพิ่ม capability ใหม่ |
| เอกสารภาษีไทยอยู่ใน core | §1 #5: BN/INV/ใบกำกับ/ใบเสร็จ/CN-DN/50 ทวิ + sequence เป็นของ TMS ไม่พึ่ง ERP | spec/00 D1, D4; spec/05 ทั้งไฟล์; แต่ spec/07 INT-013 มีโหมด `numberingOwner=external` ที่เอกสารพิมพ์ไม่ได้จนกว่า ERP ตอบเลข | ตรงกัน ยกเว้นโหมด external | ตาม docs (RA-9) |
| สถานะเอกสาร ≠ สถานะ sync | §4.4 หมายเหตุท้าย: `invoice.status` แยกจาก `external_mapping.status` + `integration_outbox.status`; API แสดง object `sync` แยก — **แต่ diagram §4.4 ยังมี `SENT/ACCEPTED/MISMATCH` อยู่ในสถานะ invoice** | spec/00 D3; spec/10 DM-010: ห้ามมีคอลัมน์ syncStatus ในตารางเอกสาร | ตรงกันในหลัก; docs ไม่คงเส้นคงวาใน diagram | ตามข้อความ docs + DM-010: ตัด `SENT/ACCEPTED/MISMATCH` ออกจาก enum ของ invoice (ดู §2.4.5) |
| AI เสนอ คนยืนยัน / แพ็กเกจจากข้อมูลชุดเดียว / ไม่ลบข้อมูลลูกค้าเอง | ไม่ระบุใน docs/01 | spec/00 D5, D7, D8 | spec เพิ่ม | ตาม spec (AI/one-platform ใหม่กว่า) |

### 2.2 Entity model และชื่อ

#### 2.2.1 องค์กรและ master

| หัวข้อ | docs v2 ระบุ | spec ระบุ | ประเภท | ข้อเสนอ |
|---|---|---|---|---|
| Tenant | `tenant` ใน ER (§3) ไม่มีตารางรายละเอียด | spec/10 §5.1 `Tenant`: status 7 ค่า, mode live/sandbox, verification, rateLimitProfile ฯลฯ | spec เพิ่ม | ตาม spec |
| นิติบุคคล | `company` (§3.1): `legal_name`, `tax_id`, `vat_registered`, `default_branch_id`, prefix `cmp_`; 1 tenant หลายบริษัท | `LegalEntity` (spec/10 §5.2): `nameTh/nameEn`, `isVatRegistered`, `stampFileId`; spec/12 Q-A11 ยังเปิดว่าหลายนิติบุคคลอยู่ tenant เดียวหรือไม่ | ต่างแค่ชื่อ | ใช้ `company` (API `companies`); ปิด Q-A11 ตาม docs (หลายนิติบุคคลใน tenant เดียว — §8.1 แถว multi-company) |
| สาขา | `branch` (§3.1): `branch_code`, `branch_label`, `hq_prints_for_all`, `is_default_issuer` | `Branch`: `isHeadOffice`, `pp20FileId` | ตรงกัน | ตาม docs + เพิ่ม `pp20_document_id` จาก spec |
| ลูกค้า | `customer` (§3.2): `tax_invoice_mode`, `billing_cycle` (PER_DO/WEEKLY/MONTHLY/MANUAL), `wht_expected_rate`, `pod_requirements`, `default_billing_company_id` | `Customer` (spec/10 §5.3): `documentFlow`, `freightTaxCategory`/`accessorialTaxCategory`, `expectsWht/whtRate`, `podProfile`, `creditLimit`, `notifyConfig`, `billingCycle` (per_trip/weekly/semi_monthly/monthly); spec/05 §1 ใช้ `taxInvoiceTiming` | ขัดกันบางฟิลด์ | ตาม docs สำหรับฟิลด์ที่ซ้ำ (`tax_invoice_mode`, `pod_requirements`, `wht_expected_rate`); เพิ่มจาก spec: `credit_limit`, `notify_config` (แจ้งลูกค้า — ใหม่กว่า), ค่ารอ; `documentFlow` ตัดทิ้ง (ซ้ำกับ `tax_invoice_mode`); VAT default ระดับลูกค้า = RA-10 |
| จุดรับ-ส่ง | `customer_site` (§3.2) ผูก `customer_id`, `aliases`, `free_time_min`, prefix `loc_` | `Location` (spec/10 §5.3): `customerId` nullable, `kind` (pickup/dropoff/depot/yard/workshop/fuel_station), PostGIS `geo`, `geofenceRadiusM` | ต่างชื่อ + spec เพิ่ม | คงโครง docs + ให้ `customer_id` เป็น null ได้และเพิ่ม `kind`, `geofence_radius_m` (docs §3.9 อ้าง `site.geofence_radius_m` อยู่แล้ว); คง `aliases` ของ docs (spec ไม่มี) |
| รถร่วม | `carrier` (§3.2) แยกจาก driver เด็ดขาด; `entity_type` INDIVIDUAL/JURISTIC, `require_pod_to_pay`, `score` | `Carrier` ใน spec/10 แต่ spec/03, 05 ใช้ `subcontractorId`/`Subcontractor`; เพิ่ม `parentCarrierId`, `tier`, `maxTripsPerDay` | ต่างแค่ชื่อ + spec เพิ่ม | ใช้ `carrier` ทุกที่; รับ `tier`, `max_trips_per_day` (cascade รถร่วม) |
| คนขับ | `driver` (§3.2): `employment_type` EMPLOYEE_SALARIED/EMPLOYEE_PER_TRIP/CARRIER_DRIVER; token `sub = driver_id` (§5.5) | `Driver`: salaried/per_trip/subcontract + `userId → User` (global identity, membership role driver) | ต่างชื่อ enum + spec เพิ่ม | enum ตาม docs; เพิ่ม `user_id` nullable ตาม spec (one-platform) — JWT ของ driver ต้องระบุว่า `sub` คือ user หรือ driver (แก้ใน docs §5.5) |
| ประเภทรถ | enum `vehicle_type` (PICKUP/6W/10W/TRAILER/REEFER/…) | ตาราง master `VehicleType` (class, maxPayload, `minLicenseClass`, `tyreLayoutCode`) | ขัดกัน | **ตาม spec** — กฎห้ามจ่ายงาน (รอบ 6) และผังยาง (รอบ fleet) ต้องมี attribute ต่อประเภท; คง enum ของ docs เป็นคอลัมน์ `class` |
| Rate card | `rate_card` แถวเดียวต่อราคา (§3.2): `side`, key เส้นทาง+ประเภทรถ, `service_item_id`, status DRAFT/APPROVED/EXPIRED, `PER_TRIP/PER_KM/PER_TON/PER_CBM/PER_DAY` | `RateCard` (หัว) + `RateCardLine`; `flat_trip/per_km/per_ton/per_m3/per_unit/per_day`; `fuelSurchargeRule` jsonb | ขัดกัน (โครง) | ต้องให้เจ้าของตัดสิน (รวมใน RA-11) — ค่าเริ่มต้น: หัว+บรรทัดแบบ spec (อนุมัติ/หมดอายุทั้งชุด) ใช้ชื่อ enum ของ docs และคง `service_item_id` ต่อบรรทัด |
| Catalog รายการบนเอกสาร | `service_item` (§3.2): `vat_type`, `wht_rate`, `is_surcharge`, `default_account_code` | `ChargeType` (spec/10), `accessorial` (spec/02, API `accessorials`) | ต่างแค่ชื่อ | ใช้ `service_item` / `service-items` |
| Reason code | `reason_code` (§3.2) category 8 + `etda_code`, `is_system` | `ReasonCode` category 11 คนละชุด (unplanned, dispatch_override, pod_rejected …) | ขัดกัน (ชุดค่า) | ตาม docs (state machine §4 ผูกกับ `ORDER_HOLD` ฯลฯ) + เพิ่ม category ที่ spec ใช้กับของใหม่: `DISPATCH_OVERRIDE`, `POD_REJECTED`, `EXCEPTION_CLOSE`, `ODOMETER_EDIT` |
| ไฟล์ | `document` (อ้างเป็น `*_document_id`, resource `documents` §5.2) — ไม่มีตารางรายละเอียด | `FileObject` (spec/10 §5.3): `kind`, `sha256`, `isImmutable`, `retentionClass` | ต่างชื่อ + spec เพิ่ม | ชื่อตาม docs (`document`), ฟิลด์ตาม spec |
| ผู้ขาย/อู่ | `vendor` อ้างใน `work_order.vendor_id` (§3.8) ไม่มีตาราง | `Vendor` (spec/10 §5.3) | spec เพิ่ม | ตาม spec |
| ผู้ใช้/สิทธิ์/อนุมัติ | ไม่อยู่ใน docs/01 (อยู่ docs/04 A) | spec/10 §5.2: User, Membership, Role, Permission, FieldPermission, ApprovalPolicy/Request, Session, RefreshToken | spec เพิ่ม | ตาม spec (เทียบกับ docs/04 A แยกอีกไฟล์) |

#### 2.2.2 SO / Trip / Stop / DO

| หัวข้อ | docs v2 ระบุ | spec ระบุ | ประเภท | ข้อเสนอ |
|---|---|---|---|---|
| SO | `sales_order` (§3.3): `so_no`, `source`, `external_id`, ต้นทาง/ปลายทาง **คู่เดียว** (`origin_site_id`,`dest_site_id` + `origin_text`,`dest_text`), `hold_reason_code_id`, `source_changed_after_plan`, `source_diff`, `raw_payload` | `SalesOrder` (spec/10 §5.4; spec/03 §2): `docNo`/`orderNo`, **หลายจุด** ผ่าน `Stop[]`, `serviceType`, `requestedVehicleCount`, `pricingMode`, ยอดเงินบนหัว, ไม่มี hold/source_diff/raw_payload | ขัดกัน | ฐาน docs (ต้องคง hold + source_diff + raw_payload เพื่อ connector); หลายจุดรับ-ส่ง = RA-4 |
| บรรทัด SO | `sales_order_line` (`qty_ordered`, `qty_delivered`, `is_dangerous`, `temp_min/max`) | `SOItem` (+ `pickupStopId`,`dropStopId`,`handling[]`) | ต่างแค่ชื่อ | ชื่อ docs; เพิ่ม FK จุดรับ/ส่งถ้ารับ RA-4 |
| กล่องรับงาน | ไม่มี (งานที่ map ไม่ได้ = SO `ON_HOLD`) | `InboxMessage` (spec/10 §5.4; spec/03 §1) ข้อความ LINE/อีเมล/MCP ก่อนเป็น SO | spec เพิ่ม | ตาม spec (รอบ 14) — ใช้กับ "ข้อความที่ยังไม่เป็น SO"; SO ที่มีโครงแล้วแต่จัดไม่ได้ยังใช้ `ON_HOLD` ของ docs |
| Trip | `trip` (§3.3): snapshot เป็นคอลัมน์ (`vehicle_plate_snapshot`…), `co_driver_ids[]`, `assignment_status/token/expires_at`, `buy_rate_snapshot`, `cost_allocation_method` | `Trip` (spec/10): `resourceSnapshot` jsonb, `trailerId`, `coDriverId`, `plannedStartAt/EndAt`, odometer, `routeTrack`; ประวัติทรัพยากรใน `Assignment`; ข้อเสนอใน `SubcontractOffer` | ขัดกันบางส่วน | ฐาน docs (snapshot เป็นคอลัมน์ query ง่ายกว่า, คง `cost_allocation_method`); เพิ่มจาก spec: `trailer_id` (docs §3.8 อ้างอยู่แล้ว), `planned_start_at/end_at` (กระดาน Gantt รอบ 9), odometer เริ่ม/จบ, ตาราง `trip_assignment` (override กฎห้ามจ่ายงาน รอบ 6) |
| ข้อเสนองานรถร่วม | อยู่บน trip: `assignment_status` OFFERED/ACCEPTED/REJECTED/EXPIRED + token 48 ชม. (§3.3) → เก็บได้ครั้งละ 1 ข้อเสนอ | `SubcontractOffer` 1 แถวต่อข้อเสนอ (cascadeLevel, offeredPrice, score, เหตุผล) + `AccessLink` (spec/10 §5.4; spec/03 PLN-133/135) | spec เพิ่ม | ตาม spec — docs เองระบุ "cascade รถร่วมรายถัดไป" (§4.1 `CARRIER_REJECTED`) ซึ่งต้องมีประวัติ; ตั้งชื่อ `carrier_offer`, `access_link`; token บน trip ย้ายไป `access_link` |
| Stop | `trip_stop` ตารางเดียว (§3.3): type PICKUP/DELIVERY/RETURN, `pod` jsonb, `last_event_id`; ค่าเวลา/สถานะเป็น projection ของ `stop_event` | `Stop` (ของ SO) + `TripStop` + `TripStopDelivery` (M:N กับ DO) + `PodRecord`/`PodPhoto`/`PodItem` | ขัดกัน | ตาม docs สำหรับ `trip_stop` + หลัก projection; POD: คง `stop_event` เป็นแหล่งความจริง แต่ **เพิ่มตาราง `pod_record`** ของ spec เป็น projection ที่ query ได้ (ต้องใช้กับการตรวจ POD/AI check `accepted/rejected` — ใหม่กว่า) แทน `trip_stop.pod` jsonb |
| DO | `delivery_order` (§3.3): 1 DO อยู่ 1 trip (`trip_id`, `trip_stop_id`), `sell_rate_snapshot`, `revenue_amount`, `allocated_cost_amount`, `invoice_line_id`, `pod_status` NONE/PARTIAL/COMPLETE; ส่งใหม่ = DO ใหม่อ้าง `redelivery_of` | `DeliveryOrder` (spec/10): 1 DO ต่อ 1 จุดส่งต่อ 1 คัน (ORD-080), `currentTripId` + หลายเที่ยวผ่าน `TripStopDelivery`, ส่งใหม่ = DO เดิมกลับ `pending` (ORD-087), `podStatus`, `billingStatus`, timestamp ต่อสถานะ, OTIF | ขัดกัน | RA-5 |
| บรรทัด DO | `delivery_order_line` (`qty_planned`,`qty_actual`,`reject_qty`) | `DOItem` | ต่างแค่ชื่อ | ชื่อ docs |

#### 2.2.3 บรรทัดราคา/ต้นทุน และเอกสาร AR

| หัวข้อ | docs v2 ระบุ | spec ระบุ | ประเภท | ข้อเสนอ |
|---|---|---|---|---|
| รายได้ต่อ DO | `sell_rate_snapshot` jsonb + `revenue_amount` บน DO; ค่าเพิ่มหน้างานใน `do_surcharge` (§3.3) | `ChargeLine` side=revenue ผูก SO/DO ตั้งแต่ร่าง (DM-009) | ขัดกัน | RA-7 |
| ต้นทุนเที่ยว | `trip_cost` (cost_type, source, `settlement_line_id` unique, `allocated` jsonb) | `ChargeLine` side=cost + `settledLineId` | ขัดกัน | RA-7 (ค่าเริ่มต้น: คง `trip_cost`) |
| ใบวางบิล | ตาราง `billing_note` (§3.4): DRAFT/ISSUED/COLLECTED/CANCELLED | spec/10: `SalesDocument.docType=billing_note` + `SalesDocumentLink`; spec/05 §3: DRAFT/ISSUED/ACKNOWLEDGED/CLOSED/CANCELLED | ขัดกัน | ตารางแยกตาม docs; `ACKNOWLEDGED` ≈ ลูกค้ารับวางบิล (กระทบ `dueDate` BIL-031) → เพิ่มเป็น `acknowledged_at` ไม่เพิ่มสถานะ |
| ใบแจ้งหนี้ | ตาราง `invoice` + `invoice_line` (§3.4) | spec/10: `SalesDocument` + `SalesDocumentLine`; spec/05: `Invoice`/`InvoiceLine` | ขัดกัน (spec/10) | ตาม docs |
| ใบกำกับภาษี | ไม่ใช่ตาราง: คือ `invoice.tax_invoice_no` (sequence `TXINV`) + `tax_point_at` | docType `invoice_tax_invoice` และ `tax_invoice_receipt` (spec/10) / เอกสาร `RT` (spec/05 §5) | ขัดกัน | RA-1 |
| ใบเสร็จ | ตาราง `receipt` 1:1 กับ `payment`, `is_tax_invoice` | docType `receipt` / `RC`; โหมด SPLIT ออก RC (ส่วนยกเว้น) + RT (ส่วน VAT) ต่อ payment (BIL-004, BIL-053) | ขัดกัน | RA-1 |
| ใบลด/เพิ่มหนี้ | ตาราง `adjustment_note` + `adjustment_note_line`, `kind` CREDIT/DEBIT, อ้าง `original_invoice_id` บังคับ | docType `credit_note`/`debit_note` อ้าง `refDocumentId`; spec/05 BIL-090: CN/DN อ้าง **RT** เท่านั้น + ACN/ADN ภายในอ้าง INV (BIL-093) | ขัดกัน | ตารางตาม docs; ชนิดภายใน = RA-2 |
| กันวางบิลซ้ำ | unique partial บน `invoice_line.delivery_order_id` where invoice ≠ CANCELLED | unique `(tenantId, chargeLineId)` บน `SalesDocumentLine` (spec/10); spec/05 BIL-022 | ตรงกันในหลัก | ตาม docs (key ขึ้นกับ RA-7) |
| รับชำระ | `payment` (gross/wht/net_received, RECORDED/REVERSED, source MANUAL/CONNECTOR) + `payment_allocation` | `Payment` (amountReceived/whtAmount/feeAmount, draft/posted/voided, method เพิ่ม promptpay/offset) + `PaymentAllocation`; spec/05 เพิ่ม `unappliedAmount` (เครดิตลูกค้า), `chequeStatus` | ต่างชื่อ + spec เพิ่ม | ชื่อ/สถานะตาม docs; เพิ่ม `unapplied_amount`, สถานะเช็ค, method `PROMPTPAY`/`OFFSET` จาก spec |
| 50 ทวิ | `wht_certificate` ตารางเดียว 2 ทิศ `direction` ISSUED/RECEIVED (§3.6) | `WhtCertificate` เฉพาะที่เราออก; ที่ได้รับเก็บบน `Payment` (`whtCertNo`, ไฟล์) + สถานะ 4 ค่า (BIL-057) | ขัดกัน | ตาม docs (ตารางเดียว) + เพิ่มสถานะติดตามฝั่งรับ `PENDING/RECEIVED/VERIFIED` จาก spec |
| Document sequence | `document_sequence` (§3.5): unique `(tenant_id, doc_type, branch_id, period_key)`; doc_type `SO/TRIP/DO/BN/INV/TXINV/RCP/CN/DN/STL/WHT/WO/INC`; `prefix_template`, `reset_policy` | `DocumentSequence` (spec/10): + `legalEntityId`, `yearEra`, `numberingAuthority`; spec/05 §8 เรียก `NumberSeries` รหัส `INV/BN/RC/RT/CN/DN/ACN/ADN/PV/WHT/CA/SET` | ต่างชื่อ + ขัดกันบางรหัส | ตาม docs; รับ `year_era` และกฎ "วันที่ใน series ไม่ถอยหลัง" (BIL-084) จาก spec; รหัส doc_type ใช้ของ docs (`RCP`, `STL`) — `RT`/`ACN`/`ADN`/`PV`/`CA` ขึ้นกับ RA-1/RA-2; `numberingAuthority` = RA-9 |

#### 2.2.4 AP, เงินเบิก

| หัวข้อ | docs v2 ระบุ | spec ระบุ | ประเภท | ข้อเสนอ |
|---|---|---|---|---|
| Settlement รถร่วม | `carrier_settlement` + `settlement_line` (`trip_cost_id` unique, `line_type` FREIGHT/SURCHARGE/DEDUCTION, `dispute_status`, `pod_verified`) (§3.6) | `SubconSettlement` (spec/10) / `Settlement` (spec/05 §11): `claimedAmount`, `checklist`, VAT ซื้อ, `SettlementLine.kind`+`sourceType` 8 แบบ | ต่างชื่อ + spec เพิ่ม | ชื่อ docs; รับ `claimed_amount`, `checklist`, ภาษีซื้อของรถร่วมจด VAT (BIL-139) |
| ใบสำคัญจ่าย (PV) | ไม่มีเอกสารแยก: `paid_at`, `payment_reference` บน settlement | `PV` มีเลข series, จ่ายหลาย settlement, จ่ายบางส่วน (spec/05 §11.7) | spec เพิ่ม | ค่าเริ่มต้นตาม docs (จ่ายครั้งเดียวต่อใบ); PV + แบ่งจ่ายเลื่อนไปหลัง P0 (spec เองยัง [OPEN] Q23) |
| เส้นทางเดียวสู่ AP | §2 "สิ่งที่ตั้งใจไม่ทำ", §8.1 | spec/05 BIL-132, BIL-186 | ตรงกัน | — |
| เงินเบิกคนขับ | อ้าง `cash_advance_id` (§3.8 `fuel_log`), `/driver/expenses/advance-requests` (§5.5) — ไม่มีตาราง | `CashAdvance` + `Expense` (spec/10 §5.6; spec/05 §12): สถานะ requested→…→cleared | spec เพิ่ม | ตาม spec สำหรับ `cash_advance`; `Expense` ดู §2.2.6 (ชนกับ `fuel_log`) |
| AP ผู้ขาย (อู่) | `work_order.ap_bill_id` (§3.8) — ไม่มีตาราง `ap_bill` | spec/06 FLT-087: ส่งออกเป็น "ค่าใช้จ่ายรอบันทึก"; ทำ AP เต็มรูปหรือไม่ยัง [OPEN] FLT-Q2 | ทั้งคู่ไม่ครบ | ต้องให้เจ้าของตัดสิน (อยู่ใน spec/12 Q-A13 แล้ว) — ค่าเริ่มต้น: ไม่ทำ `ap_bill` ใน P0 |

#### 2.2.5 ตาราง integration

| หัวข้อ | docs v2 ระบุ | spec ระบุ | ประเภท | ข้อเสนอ |
|---|---|---|---|---|
| Connector config | `connector` (§3.7): `adapter_key`, `company_id` null, `capabilities_enabled[]`, `config` (encrypted), `sync_from_date`, ACTIVE/PAUSED/ERROR | spec/10: `Connector` (catalog) + `ConnectorConfig`; spec/07: `ConnectorDefinition` + `ConnectorInstance` + `ConnectorDocTypeConfig` + `ConnectorMapping` | ต่างชื่อ + spec เพิ่ม | ชื่อ docs (`connector`); catalog ของ adapter อยู่ใน code (`ErpAdapter.key`) ไม่ต้องเป็นตาราง; toggle ต่อประเภทเอกสารของ spec map ลง `capabilities_enabled` |
| External mapping | `external_mapping`: entity 10 ชนิด, `last_synced_hash`, status SYNCED/PENDING/FAILED/MISMATCH/RETIRED, `last_error` problem+json | `ExternalMapping` (spec/10): status เพิ่ม rejected/awaiting_approval + `attempts/nextRetryAt` | ตรงกันเกือบหมด | ตาม docs — retry อยู่ที่ outbox ไม่ใช่ mapping |
| Outbox | `integration_outbox` คิวเดียวทั้ง ADAPTER และ WEBHOOK, `idempotency_key` unique, lease, `error_class` | spec/10: `OutboxEvent` (กระจายต่อ) + `WebhookEvent` + `SyncJob`; spec/07: `SyncRecord` + `SyncAttempt` | ขัดกัน | ตาม docs (คิวเดียว + lease + idempotency key) |
| Domain event | `domain_event` แหล่งเดียวของ webhook payload และ audit timeline | `WebhookEvent` + `StatusHistory` + `AuditLog` แยกกัน | ขัดกัน | ตาม docs สำหรับ `domain_event`; **คง `AuditLog` ของ spec เป็นตารางแยก** (login, สิทธิ์, impersonate, hash chain — docs/01 ไม่ครอบคลุม) |
| ประวัติสถานะ | `doc_status_history` | `StatusHistory` | ต่างแค่ชื่อ | ชื่อ docs |
| Sync log | `integration_sync_log` 1 แถวต่อ HTTP call, เก็บ 24 เดือน | `SyncLogEntry` / `SyncAttempt` เก็บ 90 วัน | ขัดกัน (retention) | ตาม docs (RA-14) |
| Reconcile | `reconcile_result` (diff รายบรรทัด, severity, ack) | ไม่มี — มีแค่สถานะ `mismatch` | docs เพิ่ม | ตาม docs |
| รหัส master ฝั่ง ERP | `erp_master_code` ต่อ connector (§7.4) | `ConnectorMapping(kind, tmsValue, externalValue)` (spec/07 §1) | ต่างแค่ชื่อ | ชื่อ docs |
| Webhook | `webhook_endpoint` (`secret_hash`, ACTIVE/DISABLED/AUTO_DISABLED) + `webhook_delivery` (30 วัน) | `WebhookEndpoint` (`secretEnc`, `extraHeadersEnc`, `mappingProfileId`) + `WebhookDelivery` | ขัดกัน 1 จุด | ตาม docs ยกเว้น **secret ต้องเก็บแบบเข้ารหัสถอดได้ตาม spec** — hash ใช้เซ็น HMAC ไม่ได้ |
| API key | `api_key` prefix `tk_live_/tk_test_`, `revoke_at` ≤ 7 วัน, `environment` | `ApiKey` (spec/10) + `customerId` (shipper key), `mappingProfileId`, `rateLimitPerMin`; spec/07 §6 เขียน prefix เป็น `tms_live_` | ตรงกัน + spec เพิ่ม | ตาม docs (`tk_`); รับฟิลด์เพิ่มของ spec |
| Idempotency | `idempotency_key` PK `(tenant_id, key, path)` 24 ชม. | `IdempotencyRecord` unique เพิ่ม `method`, สถานะ in_progress | ตรงกัน | ตาม docs + สถานะ in_progress (ตอบ 409) |
| Field mapping, API log, MCP | ไม่มี (docs §7 = mapping ใน code ของ adapter) | `MappingProfile`/`MappingRule`/`MappingFailure`, `ApiRequestLog`, `McpConnection`/`McpToolSetting`/`OAuthClient`/`OAuthGrant` | spec เพิ่ม | ตาม spec (รอบ 11, 12, 14) |

#### 2.2.6 Fleet และ driver app

| หัวข้อ | docs v2 ระบุ | spec ระบุ | ประเภท | ข้อเสนอ |
|---|---|---|---|---|
| รถ/หาง | `vehicle` ตารางเดียว `unit_role` SINGLE/TRACTOR/TRAILER + `paired_vehicle_id`; ownership OWN/SUBCONTRACT; status READY/MAINTENANCE/PARKED/RETIRED (§3.2, §3.8) | `Vehicle` + `Trailer` แยกตาราง + `Coupling` (ประวัติพ่วง, exclusion constraint); ownership เพิ่ม leased/rented; status active/in_repair/parked/disposed | ขัดกัน | RA-11 (ค่าเริ่มต้น: ตารางเดียวตาม docs + เพิ่ม `coupling`) ; enum status ตาม docs |
| เอกสารรถ | `vehicle_document`: status เก็บจริง (EXPIRING ตั้งโดย job), `renews_document_id`, `is_required_for_dispatch`, `cost_amount` → `vehicle_cost` | `VehicleDocument`: `assetType/assetId`, สถานะคำนวณไม่เก็บ, `reminderDays[]` | ขัดกันเล็กน้อย | ตาม docs |
| PM | `maintenance_plan` (template) + `maintenance_schedule` (ต่อคัน) | `MaintenancePlan` ตารางเดียว | ขัดกัน | ตาม docs |
| ใบสั่งซ่อม | `work_order` + `work_order_line` (§3.8) | `WorkOrder` + `WorkOrderLine` (+ `tyreId`, `approvalRequestId`) | ตรงกัน + spec เพิ่ม | ตาม docs; สถานะดู §2.4.7 |
| อะไหล่ | `part` (`last_price` ไม่ทำต้นทุนถัวเฉลี่ย) + `part_stock_movement` (P2) | `Part` (`avgCost` moving average) + `StockMovement` | ขัดกัน (วิธีต้นทุน) | ตาม docs (`last_price`) |
| น้ำมัน/ค่าใช้จ่ายเดินรถ | `fuel_log` ตารางเดียว `entry_type` FUEL/TOLL/FINE/PARKING/OTHER (§3.8) | `FuelEntry` (น้ำมันอย่างเดียว) + `Expense` (ค่าใช้จ่ายหน้างานทุกชนิด, rebill ลูกค้า) + `Fine` | ขัดกัน | RA-11 (ค่าเริ่มต้น: แยกแบบ spec เพราะถังน้ำมัน/ค่าปรับ/rebill เป็นของใหม่) |
| Ledger ต้นทุนรถ | `vehicle_cost` append-only ทุกแหล่งเขียน 1 แถว (§3.8) | ไม่มีตาราง — spec/06 FLT-003 คำนวณสดจากหลายตาราง | docs เพิ่ม | **ตาม docs** — spec/10 ต้องเพิ่ม `vehicle_cost` |
| อุบัติเหตุ/เคลม | `incident` ตารางเดียว (claim_status ในตัว) | `Accident` + `Claim` (หลายเคลมต่อเคส) | ขัดกัน | ชื่อ `incident` ตาม docs + ตาราง `incident_claim` ตาม spec (รอบ 8) |
| ยาง, ถังน้ำมัน, ค่าปรับ, คะแนนการขับ, ลีสซิ่ง, เลขไมล์ | ไม่มีตาราง (ยาง = `work_order_line.position`; เลขไมล์ = คอลัมน์บน vehicle) | `Tyre`/`TyreEvent`, `FuelTank`/`TankMovement`, `Fine`, `DrivingEvent`/`DrivingScore`, `Lease`, `OdometerReading` | spec เพิ่ม | ตาม spec (ของใหม่) — แต่ทุกตารางที่เกิดเงินต้องเขียน `vehicle_cost` ตามหลัก docs |
| ตำแหน่ง GPS | นอกขอบเขต docs/01 | `VehiclePosition` (partition รายเดือน) + `VehicleLastPosition` | spec เพิ่ม | ตาม spec |
| เครื่องคนขับ | `driver_device` (§3.9): FK driver, หลายเครื่องต่อคน, `trusted_until` 30 วัน, `refresh_token_hash` | `UserDevice` FK user; active ได้ 1 เครื่อง (spec/11 NFR-121); refresh 90 วัน (NFR-123) หรือ 30 วัน (spec/04 DRV-102) | ขัดกัน | RA-12 (ค่าเริ่มต้น: docs) |
| Event จากอุปกรณ์ | `stop_event` (§3.9) เฉพาะ event ต่อจุดแวะ 7 ชนิด; DVIR/ค่าใช้จ่าย/ปัญหา เขียนตารางของตัวเองโดยมี `client_event_id` | `DriverEvent` กล่องรวมทุกการกระทำ (17–18 ชนิด) + `seqOnDevice`, `baseVersion`, `processingStatus` | ขัดกัน | ตาม docs (`stop_event` เป็นแหล่งความจริงของจุดแวะ); รับ `seq_on_device`, `base_version`, `device_clock_offset_ms` จาก spec |
| ตรวจรถก่อนออก | `dvir_report` + `dvir_item` (P2, ไม่บล็อก — `override_reason`) | `Inspection` + `InspectionItem` + `InspectionTemplate` (P0, `criticalFail` → กฎห้ามจ่ายงาน) | ต่างชื่อ + ขัดกัน (พฤติกรรม/เฟส) | ชื่อ docs; พฤติกรรม = RA-12 |
| ค่ารอ | `trip_stop.detention_min` (คำนวณ) + `customer_site.free_time_min` | `WaitingTime` (อนุมัติ/ยกเว้น/วางบิล) | spec เพิ่ม | ตาม spec — มีขั้นอนุมัติก่อนกลายเป็นรายได้ |

#### 2.2.7 กลุ่มที่มีเฉพาะ spec (docs/01 ไม่ได้พูดถึง → ตาม spec)

| กลุ่ม | spec | หมายเหตุสำหรับการรวม |
|---|---|---|
| Platform และการเก็บเงินของแพลตฟอร์ม | spec/10 §5.1: Plan, PlanVersion, Feature, PlanEntitlement, AddOn, Subscription, UsageRecord, UsageVehicle, PlatformInvoice, PlatformPayment, PlatformUser, ImpersonationLog | ตารางชั้น platform ไม่มี RLS (DM-003) |
| Custom fields | spec/10 §5.9: `CustomFieldDefinition`, คอลัมน์ `customFields jsonb`, `CustomFieldValueIndex` | canonical payload ของ docs §7 ต้องมี `customFields` |
| AI | spec/10 §5.10: `AiSuggestion`, `AiUsage`, `AiQueryLog` | — |
| ศูนย์ข้อยกเว้น | spec/10 §5.5 `Exception` (`dedupeKey`, SLA) | ใช้เป็นที่แสดง `stop_event.sequence_conflict` ของ docs |
| แจ้งเตือน/แจ้งลูกค้า | `NotificationRule`, `Notification` | trigger จาก `domain_event` ของ docs |
| ระบบ | `Job`, `ImportBatch`, `ReportSchedule`, `SavedView`, `DataSubjectRequest` | docs มี resource `jobs` (§5.2) อยู่แล้ว |

### 2.3 Naming conventions และชนิดข้อมูล

| หัวข้อ | docs v2 ระบุ | spec ระบุ | ประเภท | ข้อเสนอ |
|---|---|---|---|---|
| ชื่อตาราง/คอลัมน์ | snake_case (`sales_order.so_no`) | camelCase ใน Prisma, map เป็น snake_case ด้วย `@map/@@map` (spec/10 หัวไฟล์) | ตรงกัน (DB เดียวกัน) | ใช้วิธีของ spec แต่ **ชื่อ model/field ต้องเป็นชื่อของ docs** (เช่น `soNo` ไม่ใช่ `docNo`/`orderNo`) |
| ค่า enum | `UPPER_SNAKE` ใน DB (`ISSUED`, `ON_HOLD`); API แสดง lowercase (`status: issued` §4.4, `?status=on_hold` §5.4) | spec/10 lowercase snake (`issued`); spec/05 UPPERCASE (`ISSUED`, `ON_PAYMENT`) | ขัดกัน | ตาม docs: DB/Prisma `UPPER_SNAKE`, serializer แปลงเป็น lowercase snake ใน API/webhook |
| Error code | lowercase snake (`invalid_state_transition`, `pod_incomplete`) | spec/07 lowercase; spec/05 UPPERCASE (`VAT_NOT_REGISTERED`, `DO_ALREADY_DRAFTED`) | ขัดกัน (ภายใน spec) | lowercase snake |
| Primary key | `uuid PK` + prefix ใน API; `bigserial` สำหรับ `vehicle_cost`, `integration_sync_log` | UUIDv7 สร้างฝั่ง app, API = prefix + base32 (DM-004 [PROPOSED]) | spec เพิ่ม | รับ UUIDv7 (docs ไม่ได้กำหนดเวอร์ชัน); คง `bigserial` ของ docs สำหรับ ledger/log |
| ID prefix | `cmp_ brn_ cus_ loc_ car_ veh_ drv_ ord_ trp_ stp_ do_ bn_ inv_ cn_ dn_ pay_ rcp_ stl_ wht_ con_ whe_ evt_ dev_ dvir_ wo_ inc_ …` | spec/07 INT-052: `shp_` (DO), `doc_`, `whk_`, `job_`; spec/10 DM-004 ใช้ `do_` | ขัดกัน (`do_` vs `shp_`, `whe_` vs `whk_`) | ตาม docs; `shp_` ขึ้นกับ RA-8 |
| เงิน | `numeric` ไม่ระบุ precision; API `{amount:"1250.00", currency:"THB"}` (§5.1) | `numeric(14,2)`, ราคาต่อหน่วย `numeric(14,4)`, ห้าม float (DM-005); API เหมือนกัน | spec เพิ่ม | ตาม spec |
| ปริมาณ | `numeric` | precision ต่อชนิด (DM-006) | spec เพิ่ม | ตาม spec |
| การปัดเศษ VAT/WHT | ไม่ระบุ | ตั้งต่อ tenant `taxRounding = line\|document` ค่าเริ่ม document (spec/10 §4; spec/05 BIL-032) | spec เพิ่ม | ตาม spec — ให้นักบัญชียืนยัน |
| เวลา | `timestamptz`; API "ISO 8601 UTC" (§5.1) | เก็บ UTC (DM-007); API "ISO 8601 พร้อม offset `+07:00` ใน response" (INT-052) | ขัดกัน (รูปแบบ response) | ตาม docs (UTC `Z`) — ตรงกับ benchmark §9.4 ตัวอย่าง envelope |
| เวลา 2 ชุดจากอุปกรณ์ | `occurred_at` / `received_at` (§3.9) | DM-008, spec/04 §0.2 | ตรงกัน | — |
| คอลัมน์มาตรฐาน | `tenant_id` + `created_at/updated_at`; `version` เฉพาะบางตาราง | ชุด STD: + `createdBy/updatedBy`, `deletedAt/deletedBy`, `version` ทุกตารางที่แก้ได้ (spec/10 §3) | spec เพิ่ม | ตาม spec; เอกสารที่ออกเลขแล้วห้าม soft-delete (docs §3.5) |
| รหัสภายนอก | `external_id` unique `(tenant_id, external_id)` | spec/10 `externalRef`; spec/07 `externalId`; spec/03 unique ต่อ `(tenant, source)` | ต่างแค่ชื่อ | `external_id` / `externalId` unique ต่อ tenant ตาม docs |
| ที่มาของข้อมูล | `source` MANUAL/IMPORT/API/PORTAL/CONNECTOR | `record_source` 10 ค่า (เพิ่ม ai_inbox, mcp, driver_app, carrier_link, system) | spec เพิ่ม | ชื่อค่าตาม docs + เพิ่มค่าของช่องทางใหม่ |
| พิกัด | `lat`, `lng` numeric | PostGIS `geography(Point,4326)` (spec/10 §4 [PROPOSED]) | ขัดกัน | ตาม spec ถ้าใช้ PostGIS ได้ในโครงสร้างที่เลือก — ตัดสินใน tech decisions; API ยังเป็น `lat/lng` |

### 2.4 State machines

#### 2.4.1 Sales Order

- **docs §4.1:** `RECEIVED → ON_HOLD ⇄ RECEIVED`, `RECEIVED/ON_HOLD → PLANNED`, `PLANNED → ON_HOLD`, `PLANNED → IN_TRANSIT ⇄ PARTIALLY_DELIVERED → DELIVERED → CLOSED`, `RECEIVED/ON_HOLD/PLANNED → CANCELLED` (8 สถานะ)
- **spec/03 §2.6, spec/10 §6:** `draft ⇄ confirmed → partially_planned ⇄ planned → in_transit → delivered ⇄ completed`, `→ cancelled` (8 สถานะ) + `billingStatus` แยก (not_ready/ready/partially_billed/billed)

| ประเด็น | docs | spec | ประเภท | ข้อเสนอ |
|---|---|---|---|---|
| ร่าง | ไม่มี — สร้างแล้วเป็น `RECEIVED` | `draft` (แก้ได้หมด ยังไม่มี DO); AI/MCP/shipper สร้างได้แค่ร่าง (D5, INT-133) | spec เพิ่ม | เพิ่ม `DRAFT` ก่อน `RECEIVED` (D5 ใหม่กว่า) |
| ยืนยัน | `RECEIVED` | `confirmed` (สร้าง DO ตอนนี้ ORD-081) | ต่างแค่ชื่อ | ใช้ `RECEIVED`; DO สร้างตอน DRAFT→RECEIVED |
| งานค้าง | `ON_HOLD` + `reason_code` 8 รหัส; หน้า "งานค้าง" ตารางเดียว | ไม่มี — ใช้ Inbox + ป้ายบน DO ("รถร่วมปฏิเสธ") + Exception | docs เพิ่ม | **ตาม docs** — จำเป็นกับ connector (`CUSTOMER_UNMAPPED`, `SOURCE_ERROR`) |
| จัดรถบางส่วน | ไม่มี (PLANNED เมื่อ "ลง trip") | `partially_planned` | spec เพิ่ม | ไม่เพิ่มสถานะ; แสดงเป็นตัวนับ DO ที่จัดแล้ว/ทั้งหมด |
| ส่งบางส่วน | `PARTIALLY_DELIVERED` | ไม่มี (`in_transit` จนครบ) | docs เพิ่ม | ตาม docs |
| ปิดงาน | `CLOSED` = ทุก DO ถูกวางบิลแล้ว | `completed` = POD ผ่าน + ค่าใช้จ่ายยืนยัน (พร้อมวางบิล); การวางบิลอยู่ที่ `billingStatus` | ขัดกัน (ความหมาย) | RA-3 |
| ย้อนสถานะ | ไม่มีทางย้อนจาก DELIVERED | `completed → delivered` (manager เปิดใหม่), `confirmed → draft` | spec เพิ่ม | ไม่รับ `confirmed → draft`; "เปิดงานใหม่" ทำผ่าน DO |
| ยกเลิก | เฉพาะก่อนมี DO ที่วิ่ง (ต้องยกเลิก DO ก่อน) | เหมือนกัน + แบ่งสิทธิ์ dispatcher/manager (ORD-034) | ตรงกัน | ตาม docs + กติกาสิทธิ์ของ spec |

#### 2.4.2 Trip

- **docs §4.2:** `PLANNING → OFFERED → ASSIGNED` (รถร่วม) หรือ `PLANNING → ASSIGNED` (รถบริษัท) `→ DISPATCHED → IN_PROGRESS → COMPLETED → COSTED → SETTLED`; `OFFERED → PLANNING`; `PLANNING/ASSIGNED → CANCELLED`
- **spec/03 §4.6 + spec/04 §0.1:** `draft ⇄ planned → dispatched → accepted | rejected → in_progress → completed ⇄ closed`; `→ cancelled` (spec/03 เขียน `dispatched → in_progress` ตรง และปฏิเสธแล้วกลับ `planned` — ขัดกับ spec/04 ที่มีสถานะ `accepted`/`rejected`)

| ประเด็น | docs | spec | ประเภท | ข้อเสนอ |
|---|---|---|---|---|
| ร่าง / จัดครบ | `PLANNING` / `ASSIGNED` | `draft` / `planned` | ต่างแค่ชื่อ | ชื่อ docs |
| เสนอรถร่วม | สถานะ `OFFERED` บน trip | trip ค้าง `draft`; สถานะอยู่ที่ `SubcontractOffer` (draft/sent/viewed/accepted/rejected/expired/withdrawn) | ขัดกัน | คง `OFFERED` บน trip (เห็นบนกระดาน) + ตาราง `carrier_offer` เก็บรายข้อเสนอ (RA-6) |
| คนขับกดรับ/ปฏิเสธ | ไม่มี | `accepted` / `rejected` (M11, `requireAcceptance` ตั้งได้) | spec เพิ่ม | เพิ่ม `ACCEPTED` ระหว่าง `DISPATCHED` กับ `IN_PROGRESS` (ข้ามได้เมื่อ tenant ปิด); ปฏิเสธ = กลับ `ASSIGNED` + exception ไม่ต้องมีสถานะ `REJECTED` (RA-6) |
| เริ่มวิ่ง | `DISPATCHED → IN_PROGRESS` เมื่อ stop แรก ARRIVED | คนขับกด "ออกรถ" หลังตรวจรถผ่าน | ขัดกัน | รับทั้งสอง trigger (event `DEPART` แรกหรือ `ARRIVE` แรก — docs มี `DEPART` ใน `stop_event` อยู่แล้ว) |
| ปิดต้นทุน | `COSTED` (ต้นทุนครบ + ปันลง DO) | `closed` (เลขไมล์ + เงินเบิกเคลียร์ + ค่าใช้จ่ายยืนยัน PLN-011) | ต่างชื่อ ความหมายใกล้กัน | ใช้ `COSTED` โดยรวมเงื่อนไข PLN-011 |
| จ่ายรถร่วมแล้ว | `SETTLED` | ไม่มี (ดูจาก `settledLineId`) | docs เพิ่ม | ตาม docs |
| ยกเลิกหลังส่งงาน | ไม่ได้ (เฉพาะ PLANNING/ASSIGNED) | `dispatched → cancelled` ได้ + ระบุค่าชดเชยรถร่วม (PLN-012) | ขัดกัน | รับของ spec (เหตุเกิดจริง) — เพิ่ม `DISPATCHED → CANCELLED` |
| เปลี่ยนรถกลางทาง | ปิด trip เดิม เปิด trip ใหม่ให้ DO ที่เหลือ (§4.2 ท้าย) | เหมือนกัน (PLN-008) + stop "ถ่ายของ" | ตรงกัน | — |

#### 2.4.3 Trip stop

| docs §3.3 | spec | ประเภท | ข้อเสนอ |
|---|---|---|---|
| `status` PENDING/ARRIVED/COMPLETED/FAILED/SKIPPED + `outcome` DELIVERED/PARTIAL/FAILED | 3 เวอร์ชัน: spec/10 `pending/arrived/departed/skipped/failed`; spec/03 `pending/arrived/done/skipped/failed`; spec/04 §0.1 `pending/en_route/arrived/working/completed/partial/failed/skipped` | ขัดกัน (และ spec ขัดกันเอง) | ตาม docs; `en_route`/`working` ไม่เป็นสถานะ — ดูได้จาก `stop_event` (`DEPART`, `LOADED`); ถ้าต้องการ "เริ่มลงของ" ให้เพิ่ม event type ไม่ใช่สถานะ |

#### 2.4.4 Delivery Order

- **docs §4.3:** `DRAFT ⇄ PLANNED → DISPATCHED → DELIVERED | FAILED`; `FAILED → DRAFT (DO ใหม่อ้าง redelivery_of) | RETURNED`; `DELIVERED → POD_PENDING → UNBILLED` หรือ `DELIVERED → UNBILLED`; `UNBILLED ⇄ BILLED`; `DRAFT → CANCELLED`
- **spec/03 §3.6, spec/10 §6:** `pending ⇄ assigned → picked_up → arrived → delivered | partially_delivered | failed`; `failed → pending | failed_closed`; `→ cancelled` + `podStatus` (none/submitted/accepted/rejected) + `billingStatus` (not_ready/ready/billed/not_billable; spec/05 §2 เขียน NOT_READY/READY/DRAFTED/INVOICED)

| ประเด็น | docs | spec | ประเภท | ข้อเสนอ |
|---|---|---|---|---|
| แกนสถานะ | แกนเดียว รวม POD ค้างและการวางบิล | 3 แกน | ขัดกัน | RA-5 |
| รับของแล้ว / ถึงจุดส่ง | ไม่มี (`DISPATCHED` จนส่ง) | `picked_up`, `arrived` (M12, webhook `shipment.picked_up`) | spec เพิ่ม | เพิ่ม `PICKED_UP` (จุดที่ยกเลิก SO ไม่ได้อีก — ORD-034); `arrived` ไม่ต้องเป็นสถานะ DO (เป็นของ stop) |
| ส่งบางส่วน | `DELIVERED` + `outcome = PARTIAL` | สถานะ `partially_delivered` | ต่างแค่รูปแบบ | ตาม docs |
| ส่งไม่สำเร็จ → ส่งใหม่ | DO เดิม `CANCELLED`, DO ใหม่อ้าง `redelivery_of` | DO เดิมกลับ `pending` (leg ใหม่) | ขัดกัน | RA-5 |
| ตีกลับ / ปิดไม่สำเร็จ | `RETURNED` | `failed_closed` (+ ตีกลับ = stop คืนของ) | ต่างแค่ชื่อ | `RETURNED` |
| รอ POD | `POD_PENDING` ตาม `customer.pod_requirements` | `podStatus` + การตรวจ POD โดยคน/AI (`accepted/rejected`) | spec เพิ่ม | คง `pod_status` เป็นคอลัมน์แยก (docs มีอยู่แล้ว) ขยายค่าเป็น `NONE/PARTIAL/COMPLETE/REJECTED` |
| วางบิล | `UNBILLED ⇄ BILLED` ในสถานะหลัก; DO ในร่าง invoice ถูกล็อก (§4.4 ตาราง DRAFT) | `billingStatus` + `not_billable`, `DRAFTED` | ขัดกัน | RA-5 |

#### 2.4.5 Invoice, ใบลด/เพิ่มหนี้, ใบวางบิล, รับชำระ

- **docs §4.4 invoice:** `DRAFT → ISSUED → (SENT → ACCEPTED ⇄ MISMATCH) → PARTIALLY_PAID → PAID`; `ISSUED/ACCEPTED → ADJUSTED → PAID`; `ISSUED → VOIDED` (credit note เต็มใบ); `DRAFT → CANCELLED` เท่านั้น
- **spec invoice:** spec/10 `draft → issued → partially_paid → paid; cancelled`; spec/05 §3.6 เพิ่ม `OVERDUE` เป็นสถานะ และ `ISSUED/OVERDUE → CANCELLED`, `PAID → ISSUED/PARTIALLY_PAID` (payment ถูก void)

| ประเด็น | docs | spec | ประเภท | ข้อเสนอ |
|---|---|---|---|---|
| `SENT/ACCEPTED/MISMATCH` | อยู่ใน diagram แต่ข้อความบอกให้แยกเป็น `sync` | ไม่อยู่ในสถานะเอกสาร (D3, DM-010) | docs ขัดกันเอง | ตัดออกจาก enum invoice; อยู่ที่ `external_mapping.status` |
| เกินกำหนด | ไม่มี | spec/05 เป็นสถานะ `OVERDUE` (job รายวัน BIL-040); spec/10 DM-051 เป็นค่าคำนวณ | spec ขัดกันเอง | ค่าคำนวณ (DM-051) — ไม่เป็นสถานะ |
| ปรับยอดแล้ว | `ADJUSTED` (+ `adjustments[]`) | ไม่มี | docs เพิ่ม | ตาม docs |
| ยกเลิกหลังออกเลข | ไม่ได้ — `VOIDED` ผ่าน credit note เต็มใบเท่านั้น; ยกเลิกแล้วออกใหม่เป็นคำถามเปิด §8.2 ข้อ 8 | `ISSUED → CANCELLED` ได้ถ้าไม่มี payment/RT active (spec/05 §3.6); RT ยกเลิกแล้วออกใหม่อ้างเดิม (BIL-101) | ขัดกัน | RA-2 |
| ย้อนจาก PAID | "ทำ reversal payment" (§4.4 ตาราง) แต่ไม่มี transition ใน diagram | `PAID → ISSUED/PARTIALLY_PAID` | spec เพิ่ม | รับ transition ของ spec (สอดคล้องกับ `payment.REVERSED` ของ docs) |
| ผู้สร้าง ≠ ผู้ออก | `created_by` ≠ `issued_by` (owner ปิดได้) (§3.4) | ไม่มีใน spec/05 | docs เพิ่ม | ตาม docs |
| Credit/debit note | `DRAFT → ISSUED`; `CANCELLED` ได้เฉพาะ DRAFT (§4.4 ท้าย) | `DRAFT → PENDING_APPROVAL → ISSUED → CANCELLED` (spec/05 §6.6) | ขัดกัน | ตาม docs; การอนุมัติใช้ `ApprovalRequest` ไม่เพิ่มสถานะ; ยกเลิกหลังออก = RA-2 |
| ใบวางบิล | `DRAFT/ISSUED/COLLECTED/CANCELLED` (§3.4) | `DRAFT/ISSUED/ACKNOWLEDGED/CLOSED/CANCELLED` (spec/05 §3) | ต่างชื่อ | ตาม docs + `acknowledged_at` |
| รับชำระ | `RECORDED → REVERSED` | `draft → posted → voided` (spec/10); `POSTED → VOIDED` (spec/05) | ต่างแค่ชื่อ | ตาม docs (ไม่มีร่าง — ใบเสร็จออกทันทีที่บันทึก) |

#### 2.4.6 Carrier settlement

- **docs §4.5:** `DRAFT → SENT_TO_CARRIER → DISPUTED → DRAFT`; `SENT_TO_CARRIER → APPROVED` (ออก `settlement_no`); `DRAFT → APPROVED` (ปิดขั้นให้รถร่วมตรวจ); `APPROVED → PAID` (ออก 50 ทวิ + outbox); `DRAFT → CANCELLED`
- **spec/10 §6:** เหมือน docs · **spec/05 §11.6:** เพิ่ม `CONFIRMED`, `PARTIALLY_PAID`; เลขออกตอนส่งตรวจ; `DISPUTED → SENT_TO_SUBCON`; ยกเลิกได้ถึง `APPROVED`

| ประเด็น | docs | spec/05 | ประเภท | ข้อเสนอ |
|---|---|---|---|---|
| รถร่วมยืนยัน | ไม่มีสถานะ (ไป `APPROVED` เลย) | `CONFIRMED` + ยืนยันอัตโนมัติ N วัน (BIL-138) | spec เพิ่ม | ตาม docs (= spec/10); เก็บ `carrier_confirmed_at` เป็นคอลัมน์ |
| เลขเอกสารออกเมื่อ | `APPROVED` | `SENT_TO_SUBCON` | ขัดกัน | ตาม docs |
| หลังโต้แย้ง | กลับ `DRAFT` | กลับ `SENT_TO_SUBCON` (version +1) | ขัดกัน | ตาม docs |
| จ่ายบางส่วน | ไม่มี | `PARTIALLY_PAID` + PV | spec เพิ่ม | ไม่รับใน P0 (ดู §2.2.4) |
| ยกเลิก | เฉพาะ `DRAFT` | `DRAFT…APPROVED` (ยังไม่จ่าย) | ขัดกัน | รับของ spec — ต้องยกเลิกใบที่อนุมัติผิดได้ก่อนจ่าย (เลขคงอยู่ตามหลัก docs §3.5) |

#### 2.4.7 Work order

- **docs §4.6:** `REPORTED → APPROVED → IN_PROGRESS → DONE → CLOSED`; `REPORTED → REJECTED`; `DONE → IN_PROGRESS`; `REPORTED/APPROVED → CANCELLED`; `CLOSED` immutable
- **spec/06 §สถานะ WO:** `reported → pending_approval → approved (ภายใน) → in_progress → completed → closed`; `pending_approval → reported` (ไม่อนุมัติ); `in_progress → pending_approval` (ยอดจริงเกิน FLT-082); `closed → completed` (เปิดใหม่ FLT-088); spec/10 §6 เขียน `draft → pending_approval → approved → in_progress → completed; cancelled` (ไม่มี reported/closed)

| ประเด็น | docs | spec | ประเภท | ข้อเสนอ |
|---|---|---|---|---|
| รออนุมัติ | `REPORTED` คือรออนุมัติ | แยก `reported` กับ `pending_approval` | ขัดกัน | ตาม docs; การส่งอนุมัติตามวงเงินใช้ `ApprovalRequest` |
| ไม่อนุมัติ | `REJECTED` (สถานะจบ + reason_code) | กลับ `reported` | ขัดกัน | ตาม docs ("ไม่มีสถานะปฏิเสธแล้วหาย" §4) |
| ยอดจริงเกินประมาณการ | ไม่ระบุ | กลับไปรออนุมัติ | spec เพิ่ม | รับกติกา แต่ทำเป็น `ApprovalRequest` ใหม่โดย WO ยัง `IN_PROGRESS` |
| ซ่อมเสร็จ | `DONE` | `completed` | ต่างแค่ชื่อ | `DONE` |
| เปิดใหม่หลังปิด | ไม่ได้ — WO ใหม่หรือแถวกลับรายการใน `vehicle_cost` | `closed → completed` ภายในเดือนเดียวกัน | ขัดกัน | ตาม docs (ledger append-only) |

### 2.5 การออกแบบภาษี

| หัวข้อ | docs v2 ระบุ | spec ระบุ | ประเภท | ข้อเสนอ |
|---|---|---|---|---|
| VAT ต่อบรรทัด | `vat_type` ที่บรรทัด "ไม่ใช่ที่ลูกค้าหรือที่หัวเอกสาร" (§1 ตาราง [ภาษี]); enum `VAT_7 / EXEMPT_TRANSPORT / ZERO_RATED`; snapshot จาก `service_item` | snapshot ต่อบรรทัดเหมือนกัน (DM-009, BIL-002) แต่ชื่อ 3 แบบ: `tax_category` vat7/vat0/exempt/out_of_scope (spec/10), `vatTreatment` exempt_transport/vat7/follow_customer_*/none (spec/02 MD-150), EXEMPT/VAT7 (spec/05); ค่า default มาจาก **ลูกค้า** ได้ (`freightTaxCategory`) | ตรงกันในหลัก; ขัดกันเรื่องชื่อและ default ระดับลูกค้า | ชื่อ/ค่า ตาม docs + เพิ่ม `NONE` สำหรับผู้ออกที่ไม่จด VAT (docs ไม่ได้ระบุค่าของบรรทัดกรณี `vat_registered=false`); default ระดับลูกค้า = RA-10 |
| ผู้ออกไม่จด VAT | `company.vat_registered=false` → ออกได้แค่ใบแจ้งหนี้/ใบเสร็จ (§3.1) | BIL-001: ปิด RT/CN/DN, API 422 | ตรงกัน | — |
| เอกสารปน ยกเว้น + 7% | ตัวเลือก tenant: 2 เอกสาร (ปลอดภัย) หรือใบเดียวแยกบรรทัด (§8.1) | `mixedVatDocMode = SPLIT \| SINGLE` ค่าเริ่ม SPLIT (BIL-004) | ตรงกัน | ใช้ชื่อ setting ของ spec; ค่าเริ่ม SPLIT |
| สัญญาราคาเดียว | คำถามเปิด §8.2 ข้อ 1 → อาจเพิ่ม `invoice.vat_mode = WHOLE_CONTRACT` | BIL-006: บังคับแยกบรรทัดก่อนออก INV; [OPEN] Q1 | ตรงกัน (ยังเปิดทั้งคู่) | รอนักบัญชี |
| โหมดออกใบกำกับภาษี | `customer.tax_invoice_mode = ON_PAYMENT` (default) `/ ON_ISSUE` (§3.2) | `taxInvoiceTiming = ON_PAYMENT / ON_INVOICE` ระดับนิติบุคคล + override ต่อลูกค้า (spec/05 §1); spec/10 `Customer.documentFlow` 3 ค่า | ต่างแค่ชื่อ + spec เพิ่ม (ค่า default ระดับนิติบุคคล) | ชื่อ/ค่า ตาม docs; รับ default ระดับ `company` |
| ใบกำกับภาษีเมื่อ ON_PAYMENT | `receipt.is_tax_invoice=true` → ออก `tax_invoice_no` ให้ invoice ที่ถูกตัดชำระ + `tax_point_at = paid_at` | ออกเอกสาร RT ต่อ payment ลงวันที่รับเงิน; แบ่งยอดยกเว้น/VAT ตามสัดส่วนเมื่อรับบางส่วน (BIL-053/054/055) | ขัดกัน | RA-1 |
| ใบกำกับภาษีเมื่อ ON_ISSUE | `tax_invoice_no` ออกตอน ISSUED บน invoice ใบเดียวกัน | ออก RT พร้อม INV หัว "ใบแจ้งหนี้/ใบกำกับภาษี" แล้วออก RC ตอนรับเงิน (BIL-035) | ต่างแค่รูปแบบ | ตาม docs (ใบเดียว 2 เลข) |
| ค่าขนส่งล้วน | `tax_invoice_no` = null ถ้าทุกบรรทัด `EXEMPT_TRANSPORT` | ออก RC เท่านั้น ห้ามมีคำว่า "ใบกำกับภาษี" (BIL-073) | ตรงกัน | — |
| WHT ต่อบรรทัด | `wht_rate` ต่อบรรทัดทั้ง AR และ AP; `customer.wht_expected_rate`; `carrier.wht_rate_default` (§3.2–3.6) | `whtRate` + `whtCategory` FREIGHT/SERVICE/NONE; เกณฑ์ขั้นต่ำ `whtMinPerContract` 1,000 + `whtThresholdBasis` (BIL-112); ฐาน = ก่อน VAT (BIL-113) | ตรงกัน + spec เพิ่ม | ตาม docs; รับเกณฑ์ขั้นต่ำของ spec (docs §8.2 ข้อ 7 ยังเปิด — โครง spec รองรับทั้งสองคำตอบ) |
| แก้หลังออกเลข | credit/debit note เท่านั้น อ้าง invoice + `reason_code` (ETDA code) (§1, §3.4) | CN/DN อ้าง RT เฉพาะส่วน VAT7 (BIL-090); ACN/ADN ภายในสำหรับ INV ที่ยังไม่มี RT (BIL-093); ส่วนลดที่ไม่เข้า ม.82/10 ห้ามออก CN (BIL-091) | ขัดกัน | RA-2 (docs §8.2 ข้อ 5 เปิดทางไว้ด้วย `kind = INTERNAL_DISCOUNT`) |
| ยกเลิกแล้วออกใหม่ | ยังไม่รองรับ — §8.2 ข้อ 8 (`CANCELLED_REISSUED` + `reissued_from_id` ถ้านักบัญชีตอบว่าต้อง) | รองรับเต็ม: BIL-101/102 [FACT ป.86/2542], `replacesDocumentId`, `originalRecalled` | spec เพิ่ม | RA-2 |
| ใบแทน | `POST /invoices/{id}/replacement`, `replacement_issued_at[]`, ออกจาก PDF เดิม + watermark | BIL-105 เหมือนกัน + ใช้กับ 50 ทวิ | ตรงกัน | — |
| ช่วงเวลาออก CN/DN | เตือนถ้าเกินเดือนภาษีที่เกิดเหตุ (§3.4) | บล็อกถ้าเกิน 1 เดือน, เดือนถัดไปต้องมีเหตุผล (BIL-092) | ขัดกัน (เตือน vs บล็อก) | ตาม spec ([FACT] ที่อ้าง) — ให้นักบัญชียืนยัน |
| เลขออกตอน finalize | `SELECT … FOR UPDATE` ใน transaction เดียวกับ ISSUED; draft ไม่กินเลข; ยกเลิกคงเลข (§3.5) | DM-052, BIL-081–083 เหมือนกัน + วันที่ไม่ถอยหลัง (BIL-084) | ตรงกัน + spec เพิ่ม | ตาม docs + BIL-084 |
| Series | ต่อ (tenant, doc_type, branch, period); ทั้งบริษัทได้ด้วย `branch_id = null` (§8.2 ข้อ 4) | ต่อ (นิติบุคคล × สาขา × ประเภท × งวด) (DM-053, BIL-080/087) | ตรงกัน | — |
| e-Tax | seam `invoice.etax_status` NONE/PENDING/SENT/FAILED; นอกขอบเขต | spec/05 §17 P2: `etaxStatus` NOT_SENT/SENT/ACCEPTED/REJECTED ผ่าน service provider | ต่างชื่อค่า | ค่าของ docs + เพิ่ม `ACCEPTED/REJECTED` |

### 2.6 มาตรฐาน Open API

| หัวข้อ | docs v2 ระบุ | spec ระบุ | ประเภท | ข้อเสนอ |
|---|---|---|---|---|
| ที่มาของมาตรฐาน | benchmark §9 ทั้งชุด (§5) | เหมือนกัน (spec/07 §5 ข้อ 5) | ตรงกัน | — |
| Auth ของ UI | Authorization Code + PKCE ได้ JWT เดียวกับลูกค้า (§2, §5.1); JWT RS256 1 ชม. | รหัสผ่าน/OTP/Google → access JWT **ES256 15 นาที** + refresh cookie (spec/11 NFR-108); ไม่กล่าวถึง PKCE สำหรับ UI ของเรา | ขัดกัน | ตาม docs (Auth Code + PKCE) — spec ต้องสร้าง authorization server OAuth 2.1 + PKCE สำหรับ MCP อยู่แล้ว (NFR-145) ใช้ตัวเดียวกัน; อายุ access token 15 นาทีของ spec รับได้สำหรับ UI; alg เลือกใน tech decisions |
| Auth ของลูกค้า | OAuth2 client credentials + API key `tk_live_/tk_test_` เป็น principal เดียวกัน; scope `resource:verb` | API key เป็นหลัก; client credentials [PROPOSED P1] (INT-062); scope เหมือนกัน | ตรงกัน (ต่างเฟส) | ตาม docs; client credentials ต้องมีก่อน connector ภายนอกตัวแรก |
| Auth ของ driver | `POST /oauth/token grant_type=otp`; access 15 นาที, scope `driver`, refresh 30 วันผูก `driver_device`; OTP 3 ครั้ง/10 นาที | access 1 ชม. + refresh 30 วัน (spec/04 DRV-102) หรือ 90 วัน sliding (spec/11 NFR-123); OTP 5 ครั้ง/ชม. | ขัดกัน | ตาม docs (RA-12 เรื่องจำนวนเครื่อง) |
| Auth ของ MCP | ไม่มี | OAuth 2.1 + PKCE + DCR, audience ผูก `mcp.<domain>` (NFR-145) | spec เพิ่ม | ตาม spec |
| Idempotency | `Idempotency-Key` scope (tenant, key, path) 24 ชม.; replay header; 422 `idempotency_mismatch` | INT-054 เหมือนกัน + 409 เมื่อกำลังทำ | ตรงกัน | — |
| Upsert ด้วย id ภายนอก | `PUT/PATCH /{resource}/external/{externalId}`; `{id}` รับ `ext:{externalId}` | INT-053 เหมือนกัน; แต่ spec/03 ORD-020/023 เขียน `PUT /orders/{externalId}` | ตรงกัน (spec/03 เขียนผิด path) | ตาม docs |
| Error | RFC 9457 + `code`, `requestId`, `errors[]`; 404 ข้าม tenant; 409 `invalid_state_transition` | INT-056 เหมือนกัน | ตรงกัน | — |
| Pagination | cursor `{data, nextCursor, hasMore}`; `updatedAfter`; sort เสถียร; `totalCount` ใน meta (§5.4) | INT-057 เหมือนกัน + limit เริ่ม 25 สูงสุด 200 + filter `custom_fields.{key}` | ตรงกัน + spec เพิ่ม | รวมกัน |
| Concurrency | `ETag` = `version`; `If-Match` → 412 | INT-055, DM-013 | ตรงกัน | — |
| Versioning | major ใน path; `X-Api-Version` default = **วันสร้าง tenant**; deprecation ≥ 12 เดือน | default = **วันสร้าง key** (INT-050) | ขัดกัน | ตาม docs (UI ไม่มี key) |
| Rate limit | 50 req/s ต่อ tenant (burst 100), 20 ต่อ key, 5 สำหรับ write หนัก | เพดานระบบเหมือนกัน (INT-081, NFR-1104); ต่อ key ตามแพ็กเกจ 60/300/1,000 ต่อนาที (INT-080); UI 20 req/s ต่อผู้ใช้ | ตรงกัน + spec เพิ่ม | เพดานระบบตาม docs; ต่อ key ตามแพ็กเกจ (ใหม่กว่า) |
| Sandbox | tenant mode `test` ใน cluster เดียว; `POST /v1/test/events/trigger` | tenant คู่ (`mode='sandbox'` spec/10 DM-029 หรือ `mode=test` spec/07 INT-061) + base URL `sandbox.api.` [PROPOSED] | ตรงกันในหลัก | ตาม docs (host เดียว แยกด้วย key) — ใช้คำว่า `test` |
| ลายเซ็น webhook | `X-TMS-Signature: t=,v1=`; HMAC ตาม benchmark 9.4 | INT-101/102 เหมือนกัน + tolerance 300 วิ + กัน SSRF (NFR-147) | ตรงกัน + spec เพิ่ม | รวมกัน |
| Retry webhook | 8 ครั้ง ตาม benchmark 9.4 = 1m, 5m, 30m, 2h, 6h, 12h, 24h, 24h (~3 วัน); auto-disable หลัง 50 event | spec/10 ตรงกับ benchmark; **spec/07 INT-103** 8 ครั้งใน 24 ชม. (ต้นแบบ) [OPEN O-INT-6]; auto-disable 50 event หรือ 72 ชม. (INT-105) | ขัดกัน (spec/07) | ตาม docs/benchmark |
| ชื่อ event | `invoice.finalized`, `credit_note.finalized`, `payment.recorded/reversed`, `delivery_order.status_changed`, `pod.captured`, `order.held/released`, `trip.assigned`, `stop.completed/failed`, `invoice.adjusted/voided` (§5.3) | `invoice.issued`, `credit_note.issued`, `payment.received`, `shipment.*` (7 event), `pod.uploaded/verified`, `trip.started/cancelled`, `invoice.cancelled`, `exception.*`, `webhook.test` (spec/07 §10) | ขัดกัน | ชื่อของ docs เมื่อซ้ำความหมาย; เพิ่มจาก spec: `trip.started`, `trip.cancelled`, `pod.verified`, `exception.created/resolved`, `shipment.eta_changed`→`delivery_order.eta_changed`, `webhook.test` |
| รายการ resource | 16 กลุ่ม (§5.2) รวม billing-notes, credit/debit-notes, payments, receipts, settlements, wht-certificates, connectors, outbox, reconcile-results, companies, branches | 18 แถว (spec/07 §5.1): ไม่มี billing-notes/credit-notes/receipts/settlements/wht/connectors/companies; มี `shipments`, `pod`, `locations`, `products`, `rate-quotes`, `custom-fields`; invoices เขียนได้แค่ P2 | ขัดกัน | รายการของ docs เป็นฐาน (UI ต้องใช้ครบ); เพิ่ม `rate-quotes`, `custom-fields`, `products` จาก spec; ชื่อ DO = RA-8 |
| API เขียนเอกสารบัญชี | `POST /invoices`, `/finalize`, `POST /payments` ฯลฯ ใช้ได้ทุก client ตาม scope | INT-063: API สร้างใบแจ้งหนี้ได้แค่ร่าง; `invoices:write` ต้องมี `api.write` (INT-064) | ขัดกัน | UI ต้อง finalize ผ่าน `/v1` ได้ (docs) — ข้อจำกัด "ร่างเท่านั้น" ใช้กับ **API key ของลูกค้าและ MCP** (D5) โดยคุมด้วย scope `invoices:finalize` |
| Endpoint ของ driver | `/v1/driver/*` 16 endpoint; `POST /driver/events` batch ≤ 100 ตอบ 207 รายรายการ (§5.5) | `/driver/v1/sync` batch ≤ 50 (spec/04 §7, DRV-063); `/sync/upload` (NFR-122) — ไม่มีรายการ endpoint | docs เพิ่ม | ตาม docs |
| ลิงก์ไม่ต้อง login | `/public/offers/{token}`, `/public/pod/{token}`, `GET /delivery-orders/{id}/tracking` (public token); offer 48 ชม., POD จนปิด trip + 7 วัน | `AccessLink` 4 purpose, เก็บ hash, อายุตาม purpose, ใบจ่ายเงินต้อง OTP (NFR-135); หน้าติดตาม `/t/{token}` | ตรงกัน + spec เพิ่ม | path ตาม docs, ตาราง `access_link` ตาม spec |
| Realtime ของ UI | SSE `GET /v1/events/stream` (§5.4) | ไม่ระบุ | docs เพิ่ม | ตาม docs |
| Impersonate | claim `act` ใน token (§5.4) | `ImpersonationLog` + กติกา (NFR-136) | ตรงกัน + spec เพิ่ม | รวมกัน |
| Shipper-scoped key, OpenAPI ต่อ tenant, "ลองเรียก" เฉพาะ sandbox, API request log | ไม่มี | spec/07 §8, §9, §12 | spec เพิ่ม | ตาม spec |

### 2.7 Integration layer

| หัวข้อ | docs v2 ระบุ | spec ระบุ | ประเภท | ข้อเสนอ |
|---|---|---|---|---|
| สัญญา adapter | `ErpAdapter` 8 method + `capabilities()` 10 ค่า + `PushResult` (§6.1) | ไม่มี interface; `ConnectorDefinition.capabilities` json + transport `api/file_drop/db_bridge` (spec/07 §1) | docs เพิ่ม | ตาม docs |
| รายชื่อ adapter | krs, flowaccount, peak, file_export, standalone | express, flowaccount, krs, peak, sap_b1, generic_api, file_export, none | spec เพิ่ม | รายชื่อเป็นข้อมูล ไม่ใช่สถาปัตยกรรม; Express ตาม docs = `FileExportAdapter` |
| Outbox + idempotency | 3 ชั้น: คำสั่ง (key = connector:entity:id:hash) / worker (`SKIP LOCKED` + lease + serialize ต่อลูกค้า) / ERP (ref ของเรา) (§6.2) | INT-021 outbox, INT-023 ตรวจ `ExternalMapping` + ส่ง `tmsId` เป็น reference, INT-024 master ก่อนเอกสาร | ตรงกันในหลัก; docs ละเอียดกว่า | ตาม docs + INT-024 |
| Transaction | status + `domain_event` + outbox ใน transaction เดียว (§6.2) | INT-021, INT-108, NFR-406 | ตรงกัน | — |
| Error class | 8 class: TRANSIENT, AMBIGUOUS, DUPLICATE, VALIDATION, AUTH, NOT_FOUND, PERIOD_CLOSED, CAPABILITY (§6.3) | ชั่วคราว vs ถาวร (`rejected`) + `needs_mapping`, `awaiting_approval`, code `period_closed` (spec/07 §2) | docs เพิ่ม | ตาม docs; คิว UI ของ spec (ไม่ตรง/รอส่งซ้ำ/ถูกปฏิเสธ/รออนุมัติ) จัดกลุ่มจาก ErrorClass |
| Retry adapter | 1, 2, 5, 15, 30, 60 นาที (6 ครั้ง) + หยุดคิวเมื่อ health ล้ม | spec/07 INT-022: 1, 5, 15, 60 นาที, 4, 12 ชม. (6 ครั้ง); spec/05 BIL-184: 1, 5, 15, 60 นาที สูงสุด 5 ครั้ง | ขัดกัน (และ spec ขัดกันเอง) | ตาม docs |
| สถานะ sync | `external_mapping.status` 5 ค่า + `integration_outbox.status` 6 ค่า | 3 ชุด: spec/10 `sync_status` 7 ค่า; spec/07 §2 เพิ่ม retrying/needs_mapping/resolved_manually; spec/05 BIL-180 9 ค่า (NOT_APPLICABLE…VOIDED) | ขัดกัน | ตาม docs — ค่าที่ UI แสดงเป็น projection จาก 2 enum ของ docs |
| Reconcile | 4 รอบ (AFTER_PUSH, NIGHTLY 02:00, PRE_CLOSE, MANUAL) เทียบ 6 ระดับ จับคู่ด้วยเลข DO; ปิด mismatch 3 ทาง (§6.5) | INT-025: "ดึงกลับพบความต่าง" → `mismatch` ให้คนตัดสิน — ไม่มีรอบ/ระดับ | docs เพิ่ม | ตาม docs |
| ดึงสถานะรับชำระ | `fetchPaymentStatus` รายวัน → `payment.source = CONNECTOR` | INT-026: รอบ 15–1440 นาที; สร้าง payment อัตโนมัติเฉพาะจับคู่ 1:1 และยอดไม่เกินค้าง ไม่เช่นนั้นรออนุมัติ | ตรงกัน + spec เพิ่ม | ตาม docs + เงื่อนไขกันของ INT-026 |
| ยกเลิกเอกสารที่ sync แล้ว | ไม่มี operation ยกเลิก — `pushCreditNote` หรือ fallback `replaceDocument` (§6.1) | operation `void` หรือใบลดหนี้ตามความสามารถปลายทาง (INT-028) | ขัดกัน | ตาม docs; `void` จะมีได้ต่อเมื่อ RA-2 เลือกให้ยกเลิก INV ได้ → ต้องเพิ่ม capability `voidDocument` |
| เจ้าของเอกสารภาษี / ผู้ออกเลข | `connector.config.taxDocumentOwner = TMS \| ERP` (ERP → TMS ออกแค่ใบแจ้งหนี้/ใบวางบิล ซ่อน `tax_invoice_no`) (§8.1); capability `ownsDocumentNumber` = รับ `external_doc_no` กลับมาเก็บคู่ | `numberingOwner/numberingAuthority = tms \| external`: external → เลขชั่วคราว `TMP-…` พิมพ์/ส่งไม่ได้จนได้เลขจริง (INT-013/014) | ขัดกัน | RA-9 |
| `syncFromDate` | `connector.sync_from_date` (§6.4) | INT-027, BIL-183 | ตรงกัน | — |
| Canonical payload | `CanonicalInvoice/Line/Adjustment/Settlement` = response ของ `GET /v1/…?expand=`; adapter whitelist ฟิลด์ (§7.1–7.3) | INT-001 schema กลางเดียว; "ดูตัวอย่าง payload" ใน log | ตรงกัน | ตาม docs — เพิ่ม `customFields` ใน canonical |
| Validation ก่อนเข้า outbox | mapping `SYNCED` ครบ, JSON schema ของ adapter, `erp_master_code` (§7.4) | INT-015 (ตรวจ mapping 90 วันย้อนหลังก่อนเปิด), `needs_mapping`, BIL-185 | ตรงกัน + spec เพิ่ม | รวมกัน |
| Field mapping ที่ผู้ใช้ตั้งเอง | ไม่มี (mapping อยู่ใน code + `config` overrides) | `MappingProfile` ผูก API key / CSV / connector / webhook ขาออก + transform 12 แบบ + AI แนะนำ (spec/07 §11) | spec เพิ่ม | ตาม spec — วางเป็นชั้น **หน้า** `/v1` (แปลง payload ก่อน validate) ไม่แตะ `ErpAdapter`; profile ที่ทับ mapping ของ connector (P2) ต้องไม่ข้าม whitelist ของ adapter |
| ส่งออกไฟล์ให้นักบัญชี | `FileExportAdapter` ผ่าน outbox อัตโนมัติ (§6.1) | หน้าจอ export ตามช่วงวันที่ + `ExportTemplate` (spec/07 §4) | ต่างกลไก | มีทั้งสอง: export มือ = รายงาน (P0), adapter = อัตโนมัติ; ต้องไม่กลายเป็น 2 เส้นทางสู่ AP |
| KRS | Appendix A ครบ: endpoint, 409/503, `tmsVoucherNo`, capabilities, field mapping, SO poller, คำถาม 17 ข้อ | มีแค่ชื่อในรายการ connector | docs เพิ่ม | ตาม docs — spec ไม่ต้องคัดลอก ให้อ้าง |
| Inbound จาก ERP | connector แบบ pull เรียก `PUT /v1/orders/external/{id}` เหมือน client ภายนอก (§2) | INT-002 (ไม่ต่อ DB ตรง) | ตรงกัน | — |
| Webhook ขาเข้า | ไม่ระบุ | ledger `(provider, eventKey)` กันซ้ำ (NFR-148) | spec เพิ่ม | ตาม spec |
| MCP server | ไม่มี | spec/07 §13: URL เดียว, สิทธิ์ = role ∩ scope, ระดับ อ่าน/ร่าง/เขียน | spec เพิ่ม | ตาม spec — เป็น client อีกตัวของ `/v1` ตามหลัก API-first |
| Offline ePOD: ลำดับสลับ | เก็บทั้งคู่ + `sequence_conflict = true` ให้ dispatcher ตัดสิน (§3.9) | สร้าง event อนุมาน `inferred=true` (DRV-067); DO ถูกยกเลิกก่อน → `OFFLINE_CONFLICT` (DRV-072) | ขัดกัน | RA-12 |
| Offline ePOD: นาฬิกาเพี้ยน | flag `clock_skew` เมื่อ > 24 ชม. (ไม่แก้ค่า) | แก้ `occurredAt` เมื่อ offset > 5 นาที + ธง `clock_adjusted` (DRV-066) | ขัดกัน | ตาม spec (ค่ารอ/OTIF ใช้ `occurredAt`) แต่เก็บค่าเดิมไว้ด้วย |

### 2.8 NFR ที่ docs/01 ระบุ

| หัวข้อ | docs v2 ระบุ | spec ระบุ | ประเภท | ข้อเสนอ |
|---|---|---|---|---|
| เก็บเอกสารภาษี | soft-delete + retention 7 ปี; PDF render ณ วันออก immutable (§1) | ไม่ลบตลอดที่ใช้งาน; tenant ยกเลิก → export แล้ว purge วันที่ 90 (spec/10 §7, NFR-1202/1203); PDF object lock | ตรงกันระหว่างใช้งาน | รวมกัน: 7 ปีขณะเป็นลูกค้า; หลังยกเลิกตาม spec (docs/04 J ก็เขียน 90 วัน → export → purge) |
| Sync log | 24 เดือนแล้ว archive (§3.7, §6.4) | 90 วัน (spec/10 §7) | ขัดกัน | RA-14 (ค่าเริ่มต้น docs) |
| Webhook delivery / idempotency | 30 วัน / 24 ชม. | 30 วัน / 24 ชม. | ตรงกัน | — |
| Event จากอุปกรณ์ | แถว `stop_event` เก็บเท่าเอกสาร; ไฟล์ POD 2 ปี (§3.9 → docs/04 J) | `DriverEvent` 180 วัน; ข้อมูลปฏิบัติการ + รูป POD ตามแพ็กเกจ 2/5/7 ปี | ขัดกัน | RA-14 — `stop_event` เป็นแหล่งความจริงของเวลา จึงลบก่อนเอกสารไม่ได้ |
| Audit log | `domain_event` เป็น audit timeline (§3.7); 5 ปี (docs/04 A7) | `AuditLog` 2 ปี + เหตุการณ์เอกสารภาษีเก็บเท่าเอกสาร + hash chain (NFR-403/404) | ขัดกัน (ระยะ) | RA-14 |
| GPS log | 90 วัน (docs/04 J; §8.1 "retention แยกจาก GPS log") | [OPEN] DM-OPEN-1 เสนอ 180 วัน | ขัดกัน | RA-14 |
| Field-level encryption | `carrier.tax_id` (บุคคล), `bank_account`, `connector.config` ด้วย KMS (§3.2, §3.7, §8.1) | DM-018, NFR-153: AES-256-GCM envelope, data key ต่อ tenant, `…Last4`, การถอดรหัสเขียน audit; credential ของ connector อยู่ secret manager (NFR-154) | ตรงกัน + spec เพิ่ม | รวมกัน |
| PDPA | เลขบัตรใน 50 ทวิ: ฐานหน้าที่ตามกฎหมาย, access audit, retention แยก (§8.1) | spec/11 §4: บทบาท, inventory + ฐาน, NFR-301–312 (privacy notice, track เฉพาะเวลางาน, DSR, sub-processor) | ตรงกัน + spec เพิ่ม | ตาม spec |
| ข้าม tenant = 404 | §1 #3, §5.1 | NFR-133 | ตรงกัน | — |
| เก็บเอกสารบน cloud (ท.ป.116/ป.121) | คำถามเปิด §8.2 ข้อ 10 | DM-OPEN-2 | ตรงกัน (ยังเปิด) | รอนักบัญชี |

### 2.9 ความไม่สอดคล้องภายในแต่ละชุด (ต้องแก้ก่อนใช้เป็นฐาน)

| ชุด | จุด | รายละเอียด |
|---|---|---|
| spec | casing ของ enum | spec/10 lowercase; spec/05 UPPERCASE ทั้งไฟล์ |
| spec | ชื่อ entity | spec/10 `SalesDocument`/`DocumentSequence`/`SubconSettlement`/`Carrier`/`ConnectorConfig`/`SyncJob`; spec/05 `Invoice`/`NumberSeries`/`Settlement`/`Subcontractor`/`DocumentSync`; spec/07 `ConnectorInstance`/`SyncRecord`/`SyncAttempt`; spec/03 `orderNo`/`OrderCharge` |
| spec | invoice `OVERDUE` | สถานะจริง (spec/05 §3.6) vs ค่าคำนวณ (spec/10 DM-051) |
| spec | สถานะ trip stop / WO / POD / DO billing / sync | อย่างละ 2–3 เวอร์ชันต่างไฟล์ (ดู §2.4.3, §2.4.7, §2.4.4, §2.7) |
| spec | trip หลังส่งงาน | spec/03 §4.6 ไม่มี transition ผ่าน `accepted`; spec/04 §0.1 มี |
| spec | prefix API key | `tms_live_` (spec/07 §6) vs `tk_live_` (spec/10, spec/11 NFR-141) |
| spec | retry | adapter: INT-022 vs BIL-184; webhook: INT-103 vs spec/10 `WebhookDelivery` |
| spec | token ของ driver | refresh 30 วัน + access 1 ชม. (DRV-102) vs refresh 90 วัน (NFR-123) |
| spec | เฟสของ Open API | P1 (spec/07 §5) vs P0 "อ่าน + key + log + sandbox" (spec/12 §1) |
| docs | สถานะ invoice | diagram §4.4 มี `SENT/ACCEPTED/MISMATCH` แต่ข้อความท้ายหัวข้อบอกว่าแยกเป็น `sync` |
| docs | ตารางที่ถูกอ้างแต่ไม่ได้นิยามใน §3 | `vendor`, `ap_bill`, `cash_advance`, `erp_master_code`, `document`, `tenant_settings`, ตารางผู้ใช้ |
| docs | คนขับคนที่สอง | `trip.co_driver_ids[]` (§3.3) vs `secondary_driver_id` (§5.5) |
| docs | `PATCH /driver/today/vehicle` | อ้าง trip "ยังไม่ `IN_TRANSIT`" (§5.5) แต่ trip ไม่มีสถานะนี้ (ควรเป็น `DISPATCHED`/`IN_PROGRESS`) |
| docs | เลขหัวข้ออ้างอิงใน §1 | อ้าง "หัวข้อ 3.6" สำหรับ `vat_type` และ "3.7" สำหรับ `wht_rate` แต่เนื้อหาอยู่ §3.2/§3.4 และ §3.6 |
| docs | prefix `evt_` | ใช้ทั้ง `domain_event` และ `stop_event` |
| docs | `webhook_endpoint.secret_hash` | hash เซ็น HMAC ไม่ได้ (ดู §2.2.5) |

## 3. รายการที่ต้องแก้ใน spec/ เพื่อให้ตรง docs v2

ข้อที่ขึ้นกับ RA ให้รอผลตัดสินก่อน (วงเล็บท้ายข้อ)

- [ ] **spec/00-overview.md** — เพิ่มหลัก "UI เป็น client ของ `/v1` เดียวกับลูกค้า" (docs §1 #2); คำศัพท์: ใช้ `company`, `carrier`, `service item`, `delivery order`
- [ ] **spec/10-data-model.md §5.6** — แทน `SalesDocument`/`SalesDocumentLine`/`SalesDocumentLink` ด้วยตารางแยก `billing_note`, `invoice`, `invoice_line`, `adjustment_note`, `adjustment_note_line`, `receipt` (docs §3.4); เพิ่ม `wht_certificate.direction`; ย้ายข้อมูล 50 ทวิ ฝั่งรับออกจาก `Payment` (RA-1, RA-2)
- [ ] **spec/10 §5.2–5.3** — เปลี่ยนชื่อ: `LegalEntity`→`Company`, `ChargeType`→`ServiceItem`, `Location`→ตามข้อเสนอ §2.2.1, `FileObject`→`Document`, `StatusHistory`→`DocStatusHistory`, `externalRef`→`externalId`; `tax_category`→`vat_type` ค่า `VAT_7/EXEMPT_TRANSPORT/ZERO_RATED/NONE`
- [ ] **spec/10 §5.4** — SO: เพิ่ม `ON_HOLD` + `holdReasonCodeId`, `sourceChangedAfterPlan`, `sourceDiff`, `rawPayload`; ปรับ `so_status`, `do_status`, `trip_status`, `trip_stop_status` ตาม §2.4 (RA-3, RA-5, RA-6); `ChargeLine` (RA-7)
- [ ] **spec/10 §5.5** — `DriverEvent`→`stop_event` ตาม docs §3.9 (คง `seqOnDevice`, `baseVersion`); เพิ่ม `sequence_conflict`, `attachments_pending`, `applied_at`; `UserDevice`→`driver_device` (RA-12)
- [ ] **spec/10 §5.7** — เพิ่มตาราง `vehicle_cost` (ledger, docs §3.8) และให้ `FuelEntry`/`WorkOrder`/`VehicleDocument`/`Fine`/`Tyre`/`Lease`/`Claim` เขียน ledger; `MaintenancePlan` แยกเป็น plan + schedule; `Part.avgCost`→`last_price`; `Inspection*`→`dvir_report`/`dvir_item`; `Accident`→`incident`; ปรับ `wo_status`, `vehicle_status` ตาม docs (RA-11)
- [ ] **spec/10 §5.8** — แทน `ConnectorConfig`/`SyncJob`/`SyncLogEntry`/`OutboxEvent`/`WebhookEvent` ด้วย `connector`, `integration_outbox`, `integration_sync_log`, `domain_event`, `reconcile_result`, `erp_master_code` (docs §3.7); `sync_status` ตาม docs; ตัด `numberingAuthority` (RA-9)
- [ ] **spec/10 §6** — enum ทุกตัวเป็น `UPPER_SNAKE` + ระบุว่า API แสดง lowercase; ปรับ `payment_status` เป็น `RECORDED/REVERSED`
- [ ] **spec/10 §7 + spec/11 §13, NFR-404** — sync log 24 เดือน, audit, GPS, `stop_event` (RA-14)
- [ ] **spec/03-orders-planning.md §2.6, §3.6, §4.6** — state machine ของ SO/DO/Trip ตาม docs §4.1–4.3 + ส่วนที่รับจาก spec (`DRAFT`, `PICKED_UP`, `ACCEPTED`, `DISPATCHED → CANCELLED`); ORD-020/023 แก้ path เป็น `PUT /orders/external/{externalId}`; ชื่อฟิลด์ `orderNo`→`soNo`, `subcontractorId`→`carrierId`; §0 "API naming" (RA-8)
- [ ] **spec/04-execution.md §0.1, §7** — สถานะ stop ตาม docs §3.3; endpoint `/driver/v1/sync` → `POST /v1/driver/events` (≤ 100, ตอบ 207) + รายการ endpoint docs §5.5; DRV-067/072 (RA-12); DRV-102 อายุ token ตาม docs §5.5; §23 ชื่อ webhook ตาม docs §5.3
- [ ] **spec/05-billing.md** — ทั้งไฟล์: enum/error code เป็นรูปแบบเดียวกับ spec/10 ที่แก้แล้ว; §0.1 รหัสเอกสารให้ตรง `document_sequence.doc_type` ของ docs; §3.6 ตัด `OVERDUE` ออกจากสถานะ, เพิ่ม `ADJUSTED`/`VOIDED`, เพิ่มกติกาผู้สร้าง ≠ ผู้ออก; §4 `Payment` เป็น `RECORDED/REVERSED`; §6–7 (RA-2); §11.6 สถานะ settlement ตาม docs §4.5; §15 แทน `DocumentSync` + BIL-180/184 ด้วยการอ้าง docs §6.2–6.3; `Subcontractor`→`carrier`, `NumberSeries`→`document_sequence`
- [ ] **spec/06-fleet.md** — สถานะ WO ตาม docs §4.6 (ตัด `pending_approval`, เพิ่ม `REJECTED`, ตัด FLT-088 เปิดใหม่หลังปิด); FLT-003 อ่านจาก `vehicle_cost`
- [ ] **spec/07-integration.md §1–3** — เขียนใหม่ให้อ้าง `ErpAdapter`/capabilities/ErrorClass/reconcile ของ docs §6; INT-013/014 (RA-9); INT-022 retry ตาม docs §6.3; INT-028 `void` (RA-2); INT-012 ตัด `both`
- [ ] **spec/07 §5–10** — เฟส: `/v1` plumbing = P0; INT-050 default version = วันสร้าง tenant; INT-052 prefix ตาม docs + เวลาเป็น UTC; INT-062 client credentials; INT-063 เปลี่ยนเป็นข้อจำกัดตาม scope; §5.1 รายการ resource ตาม docs §5.2; §6 prefix `tk_`; INT-103 retry ตาม benchmark 9.4; ตาราง event ตาม §2.6
- [ ] **spec/11-nfr.md** — NFR-108 ระบุ Auth Code + PKCE สำหรับ UI; NFR-121–123 (RA-12)
- [ ] **spec/12-roadmap-open-questions.md** — ปิด Q-A11 (หลายนิติบุคคลใน tenant เดียว ตาม docs); ย้าย Open API plumbing เข้า P0 ให้ตรงกันทุกไฟล์; เพิ่ม RA ของไฟล์นี้

## 4. รายการที่ควรเพิ่มใน docs v2

- [ ] **§1 / §3 หัวข้อ** — ข้อยกเว้นของ "ทุกตารางมี `tenant_id` + RLS": ชั้น platform และ global identity (spec/10 §2.1, DM-003); รายละเอียด RLS DM-020–028 และ test แยก tenant (spec/10 §2.5)
- [ ] **§3 คอลัมน์มาตรฐานและชนิดข้อมูล** — ชุด STD (`created_by`, `deleted_at`, `version`), UUIDv7, precision ของเงิน/ปริมาณ, `tax_rounding`, เบอร์ E.164 (spec/10 §3–4, DM-004–007)
- [ ] **§3 ตารางใหม่ (ของใหม่กว่า docs)** — platform/billing ของแพลตฟอร์ม (spec/10 §5.1); user/membership/role/approval (§5.2); `inbox_message`; `carrier_offer` + `access_link`; `trip_assignment` (override กฎห้ามจ่ายงาน); `pod_record`; `waiting_time`; `exception`; `notification_rule`/`notification`; `cash_advance`; `vendor`; fleet เพิ่มเติม (ยาง, ถังน้ำมัน, ค่าปรับ, คะแนนการขับ, ลีสซิ่ง, `odometer_reading`, `coupling`, `vehicle_position`); custom fields (§5.9); AI (§5.10); `mapping_profile`/`mapping_rule`; `api_request_log`; MCP; `audit_log`; `job`/`import_batch`/`report_schedule`/`data_subject_request`
- [ ] **§3.2** — `vehicle_type` เป็น master table; `customer_site.customer_id` nullable + `kind`; `customer.credit_limit`, `notify_config`; `carrier.tier`, `max_trips_per_day`; `driver.user_id`
- [ ] **§3.4** — ตัดสิน RA-1/RA-2 แล้วแก้ `invoice`/`receipt`/`adjustment_note`; เพิ่ม `payment.unapplied_amount`, สถานะเช็ค, สถานะติดตาม 50 ทวิ ฝั่งรับ; เพิ่มค่า `vat_type = NONE`
- [ ] **§3.5** — `year_era`; กฎวันที่ใน series ไม่ถอยหลัง (spec/05 BIL-084)
- [ ] **§3.7** — `webhook_endpoint.secret` เก็บแบบเข้ารหัสถอดได้; `api_key.customer_id` (shipper key), `mapping_profile_id`, `rate_limit_per_min`; `idempotency_key` สถานะ in_progress; นิยาม `erp_master_code`
- [ ] **§4** — เพิ่ม `DRAFT` (SO), `PICKED_UP` (DO), `ACCEPTED` + `DISPATCHED → CANCELLED` (trip), `PAID → ISSUED/PARTIALLY_PAID` (invoice), `APPROVED → CANCELLED` (settlement); ตัด `SENT/ACCEPTED/MISMATCH` ออกจาก diagram §4.4
- [ ] **§5.1** — rate limit ต่อ key ตามแพ็กเกจ; limit เริ่มต้น/สูงสุดของ pagination; filter `custom_fields.{key}`; กัน SSRF ของ webhook; scope `invoices:finalize` ที่ API key ลูกค้า/MCP ไม่ได้โดยปริยาย (D5)
- [ ] **§5.2–5.3** — resource `rate-quotes`, `custom-fields`, `products`; event `trip.started`, `trip.cancelled`, `pod.verified`, `exception.*`, `delivery_order.eta_changed`, `webhook.test`; OpenAPI ต่อ tenant รวม custom fields; shipper-scoped key
- [ ] **§5 ใหม่** — MCP server เป็น client ตัวที่ 4 ของ `/v1` (spec/07 §13) + OAuth 2.1/DCR (spec/11 NFR-145)
- [ ] **§5.5** — แก้ `secondary_driver_id`/`IN_TRANSIT`; `sub` ของ JWT driver เมื่อมี `user`; รับ `deviceClockOffsetMs`, `seqOnDevice`, `baseVersion` ใน batch; ผูก `sequence_conflict` กับ exception center
- [ ] **§6–7** — เงื่อนไขสร้าง payment อัตโนมัติจาก `fetchPaymentStatus` (spec/07 INT-026); master ต้อง sync ก่อนเอกสาร (INT-024); ตรวจ mapping ก่อนเปิด connector (INT-015); field mapping profile เป็นชั้นหน้า `/v1`; ledger webhook ขาเข้า; `customFields` ใน canonical payload
- [ ] **§8 / NFR** — PDPA ตาม spec/11 §4; envelope encryption ต่อ tenant; retention หลัง tenant ยกเลิก; retention ตามแพ็กเกจ (ถ้ารับ RA-14)

## 5. ต้องให้เจ้าของตัดสิน

| # | เรื่อง | ทางเลือก | ค่าเริ่มต้นที่เสนอ |
|---|---|---|---|
| RA-1 | เลขใบกำกับภาษีอยู่ที่ไหนเมื่อ `ON_PAYMENT` | (ก) docs: `invoice.tax_invoice_no` เลขเดียวต่อใบแจ้งหนี้ (ข) spec: เอกสาร RT ต่อการรับเงิน 1 ครั้ง + RC แยกส่วนยกเว้น | ตารางตาม docs แต่ **ย้ายเลขใบกำกับภาษีไปอยู่ที่ `receipt`** (1 payment = 1 ใบเสร็จ/ใบกำกับภาษี, โยงกับ invoice ผ่าน `payment_allocation` ที่มีอยู่) — เพราะ tax point เกิดทุกครั้งที่รับเงิน ใบแจ้งหนี้ที่รับ 2 งวดต้องมี 2 เลข ซึ่งคอลัมน์เดียวของ (ก) ตามที่เขียนไว้เก็บไม่ได้; คง `invoice.tax_invoice_no` ไว้เฉพาะโหมด `ON_ISSUE`; ให้นักบัญชียืนยัน |
| RA-2 | แก้/ยกเลิกเอกสารหลังออกเลข | (ก) docs: credit/debit note เท่านั้น, `VOIDED` (ข) spec: ยกเลิก INV ได้ถ้ายังไม่มีเงิน/ใบกำกับ + ACN/ADN ภายใน + ยกเลิกใบกำกับแล้วออกใหม่ | (ก) เป็นฐาน + รับ 2 อย่างจาก (ข): `adjustment_note.kind` เพิ่มชนิดภายในสำหรับใบแจ้งหนี้ที่ยังไม่มีเลขใบกำกับภาษี (docs §8.2 ข้อ 5) และ transition ยกเลิก-ออกใหม่ (docs §8.2 ข้อ 8 คำตอบ A); ไม่ให้ยกเลิก INV ตรง ๆ — รอคำตอบนักบัญชี 2 ข้อนั้น |
| RA-3 | State machine ของ SO | (ก) docs: `RECEIVED/ON_HOLD/…/CLOSED` (ข) spec: `draft/confirmed/…/completed` + `billingStatus` | (ก) + เพิ่ม `DRAFT`; `CLOSED` คงความหมาย docs (วางบิลครบ); "พร้อมวางบิล" ดูจาก DO |
| RA-4 | SO หลายจุดรับ-ส่ง | (ก) docs: ต้นทาง/ปลายทางคู่เดียวบน SO (ข) spec: `Stop[]` ระดับ SO + จัดสรรสินค้าต่อจุด | (ข) — drawer SO รอบ 9 และ milk run ต้องใช้; เพิ่มตาราง `sales_order_stop` โดยคง `origin_text/dest_text` ของ docs ไว้สำหรับงานจาก connector ที่ยัง map ไม่ได้ |
| RA-5 | DO: แกนสถานะ, ความสัมพันธ์กับ trip, ส่งใหม่ | (ก) docs: แกนเดียว (รวม `POD_PENDING/UNBILLED/BILLED`), 1 DO = 1 trip, ส่งใหม่ = DO ใหม่ (ข) spec: 3 แกน, DO อยู่หลายเที่ยว, ส่งใหม่ = DO เดิม | (ก) + `PICKED_UP` + `pod_status` ขยายค่า; ส่งใหม่เป็น DO ใหม่อ้าง `redelivery_of` (เลข DO เป็น key reconcile กับ ERP — docs §6.5 จึงไม่ควรใช้ซ้ำข้ามเที่ยว); ถ่ายลำกลางทางใช้การปิด/เปิด trip ตาม docs §4.2 |
| RA-6 | Trip: ข้อเสนอรถร่วม และการกดรับของคนขับ | (ก) docs: `OFFERED` + token บน trip (ข) spec: `SubcontractOffer` + `accepted/rejected` | สถานะตาม docs + `ACCEPTED`; เพิ่มตาราง `carrier_offer` เก็บทุกข้อเสนอ (cascade, ราคา, เหตุผล) |
| RA-7 | โมเดลบรรทัดราคา/ต้นทุน | (ก) docs: snapshot บน DO + `do_surcharge` + `trip_cost` (ข) spec: `ChargeLine` ตารางเดียวสองฝั่งตั้งแต่ SO ร่าง | ลูกผสม: ฝั่งต้นทุนคง `trip_cost` (กติกา `settlement_line.trip_cost_id` unique); ฝั่งรายได้ขยาย `do_surcharge` เป็น `order_charge` ผูกได้ทั้ง SO และ DO เพื่อให้ตารางราคาใน SO (รอบ 9) มีที่เก็บ; ไม่รวมสองฝั่งเป็นตารางเดียว |
| RA-8 | ชื่อ DO ใน API | (ก) docs: `delivery-orders`, `do_`, `delivery_order.*` (ข) spec: `shipments`, `shp_`, `shipment.*` | (ก) — ตรงกับชื่อตารางและเอกสารไทย; ถ้าเจ้าของต้องการคำว่า shipment สำหรับผู้ส่งสินค้า ให้ตัดสินก่อนเปิด API ภายนอก เพราะเปลี่ยนภายหลังเป็น breaking change |
| RA-9 | ERP เป็นผู้ออกเลขเอกสาร | (ก) docs: TMS ออกเลขของตัวเองเสมอ เก็บเลข ERP คู่กัน; `taxDocumentOwner = ERP` → TMS ไม่ออกใบกำกับภาษี (ข) spec: `numberingOwner = external` → เลขชั่วคราว `TMP-` รอเลข ERP | (ก) — เอกสารไม่ควรพิมพ์ไม่ได้เพราะ ERP ล่ม (ขัดหลัก standalone) |
| RA-10 | ค่า VAT เริ่มต้นระดับลูกค้า | (ก) docs: `vat_type` มาจาก `service_item` เท่านั้น (ข) spec: ลูกค้ามี `freightTaxCategory`/`accessorialTaxCategory` ทับค่า default (รอบ 10) | รับ (ข) เป็น **ตัวตั้งค่า default** เท่านั้น — ค่าจริงยัง snapshot ที่บรรทัดตาม docs; ผูกกับคำตอบนักบัญชี docs §8.2 ข้อ 1–2 |
| RA-11 | โครง master และ fleet | หาง: ตาราง `vehicle` เดียว (docs) หรือ `Trailer` แยก (spec) · ค่าใช้จ่าย: `fuel_log` รวม (docs) หรือ `expense` + `fuel_entry` + `fine` (spec) · rate card: แถวเดียว (docs) หรือหัว+บรรทัด (spec) | หาง = ตารางเดียวตาม docs + `coupling`; ค่าใช้จ่าย = แยกตาม spec; rate card = หัว+บรรทัดตาม spec; ทุกอย่างเขียน `vehicle_cost` ตาม docs |
| RA-12 | แอปคนขับ: เครื่อง, ลำดับ event, ตรวจรถ | เครื่อง: หลายเครื่อง 30 วัน (docs) หรือ 1 เครื่อง refresh 90 วัน (spec) · ลำดับสลับ: flag ให้คนตัดสิน (docs) หรือสร้าง event อนุมาน (spec) · ตรวจรถ: P2 ไม่บล็อก (docs) หรือ P0 บล็อกเมื่อข้อวิกฤตไม่ผ่าน (spec รอบ 6) | เครื่อง = docs; ลำดับ = docs (ไม่สร้างข้อมูลที่คนขับไม่ได้กด) โดยแสดงใน exception center; ตรวจรถ = spec (กฎห้ามจ่ายงานรอบ 6 ใหม่กว่า) แต่ manager override ได้ตามแนว docs |
| RA-13 | เฟสของ Open API และ connector ตัวแรก | (ก) docs §8.3: plumbing API ขั้น 2, integration layer ขั้น 3, KRS ขั้น 4 (ข) spec: Open API P1, connector ตัวแรกยังไม่เลือก (O-INT-1) | plumbing `/v1` + outbox + `StandaloneAdapter`/`FileExportAdapter` = P0 ตาม docs; connector ตัวแรกให้เจ้าของเลือกตามลูกค้านำร่อง (KRS พร้อมที่สุดเพราะมี Appendix A) |
| RA-14 | ระยะเก็บข้อมูล | sync log 24 เดือน (docs) / 90 วัน (spec) · audit 5 ปี (docs/04) / 2 ปี (spec) · GPS 90 วัน (docs/04) / 180 วัน (spec เสนอ) · ข้อมูลปฏิบัติการ: ขั้นต่ำคงที่ (docs) / ตามแพ็กเกจ 2-5-7 ปี (spec) | sync log 24 เดือน, audit 5 ปี, GPS 90 วัน ตาม docs เป็น **ขั้นต่ำ**; ระยะตามแพ็กเกจของ spec ใช้ได้เฉพาะส่วนที่ยาวกว่าขั้นต่ำ; `stop_event` เก็บเท่าเอกสาร |
