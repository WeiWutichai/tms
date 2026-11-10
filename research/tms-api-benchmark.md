# TMS Public API Benchmark — Alvys, Rose Rocket, Shipsy, Locus, Onfleet, Track-POD (+ Stripe/Shopify reference)

วันที่ทำ research: 2026-11-03
วิธีการ: ทุกข้อเท็จจริง (FACT) มาจากหน้า docs ที่เปิดอ่านจริงด้วย WebFetch และมีลิงก์กำกับ ส่วนที่เป็นความเห็น/การตีความติดป้าย **OPINION** กรณีที่หา docs สาธารณะไม่ได้ เขียน **ไม่พบข้อมูล** แทนการเดา
หมายเหตุ: บางหน้าที่ตั้งใจเปิด (เช่น Alvys `openapi/alvys.json`, Locus Swagger JSON) ถูกบล็อกจาก environment ที่ใช้ทำ research — จะระบุไว้ว่า "ลิงก์มีอยู่แต่เปิดจาก environment นี้ไม่ได้" และใช้ข้อมูลจากหน้า docs/third-party profile แทน (ติดป้ายแยก)

---

## 1. Alvys (docs.alvys.com) — Trucking TMS, US

**1.1 Auth** — FACT
- OAuth 2.0 Client Credentials: `POST https://auth.alvys.com/oauth/token` body `client_id, client_secret, audience="https://api.alvys.com/public/", grant_type=client_credentials` แล้วใช้ `Authorization: Bearer` — [Authentication](https://docs.alvys.com/reference/authentication.md)
- Scope รูปแบบ `entity:permission` เช่น `load:read trip:create` ครอบคลุม customer/driver/fuel/invoice/load/maintenance/toll/trailer/trip/truck/user/visibility/dispatch/carrier; token ถูกจำกัดตาม scope ที่ client ได้รับ — [Authentication](https://docs.alvys.com/reference/authentication.md)
- สร้าง credential ได้สูงสุด 10 ชุดต่อ tenant ใน Admin → API Access, ตั้งวันหมดอายุได้ (optional); legacy flow `/api/authentication/{tenant_id}/token` ถูกเลิกใช้ (migrate ภายใน 31 ก.ค. 2025) — [Authentication](https://docs.alvys.com/reference/authentication.md)
- Tenant ไม่อยู่ใน URL อีกต่อไป ผูกกับ token — [Assign trip](https://docs.alvys.com/reference/trips/assign-trip.md)
- Rotation ของ client secret: ไม่พบข้อมูล (มีเฉพาะ webhook secret rotation ดูข้อ 1.4)

**1.2 Resource model / naming** — FACT
- Base URL `https://integrations.alvys.com/api/p/v{version}/<controller>` เช่น `/api/p/v1/loads/search` — [Base URL](https://docs.alvys.com/en/api/guides/base-url.md)
- Resource เป็นพหูพจน์: `loads, trips, carriers, customers, drivers, trucks, trailers, invoices, tenders, locations, users, subsidiaries, fuel, tolls, maintenance, visibility` — [API reference index](https://docs.alvys.com/_llms/en/api-documentation/v1-0/api-reference.txt)
- Stop เป็น nested ภายใต้ trip: `GET /trips/{tripId}/stops`, `PUT /trips/{tripId}/stops/{stopId}/arrival` (body `ArrivedAt` ISO 8601) — [Record stop arrival](https://docs.alvys.com/en/api/reference/trips/record-stop-arrival.md)
- Action endpoints ใช้ verb sub-resource: `POST /trips/{tripId}/assign` (body `CarrierId, DispatcherId, Driver1Id, TruckId, TrailerId, CarrierRate`), `/trips/{id}/dispatch` — [Assign trip](https://docs.alvys.com/reference/trips/assign-trip.md)
- Search เป็น `POST /{resource}/search` (ไม่ใช่ GET + query) — [Search loads](https://docs.alvys.com/en/api/reference/loads/search-loads.md)
- Documents/POD: `POST /loads/{id}/documents`, `/trips/{id}/documents` (upload) ไม่มี resource `documents` กลาง — [API reference index](https://docs.alvys.com/_llms/en/api-documentation/v1-0/api-reference.txt)
- JSON body เป็น **PascalCase** (`CarrierId`, `PageSize`) แต่ webhook payload เป็น **camelCase** — [Assign trip](https://docs.alvys.com/reference/trips/assign-trip.md), [Webhooks overview](https://docs.alvys.com/en/api/reference/webhooks/overview.md)
- **OPINION:** Public API ไม่มี `POST /loads` (create) — มี Get/Search/Update/Delete-note เท่านั้น; การสร้าง load เข้าทาง tender/EDI ซึ่งทำให้ ERP connector ที่ต้อง "push order เข้า TMS" ทำได้ยาก

**1.3 Idempotency** — FACT
- Create ใช้ field `ExternalId` ใน body (ไม่ใช่ header) สำหรับ accessorial/credit creates: key เดิม+request เดิม → คืน record แรก, key เดิมแต่ค่าเปลี่ยน → `409 Conflict`, ไม่ส่ง key → ไม่มี idempotency; key case-sensitive, trim whitespace, unique ภายใน tenant; ถ้าได้ `503` ให้ retry request เดิม — [Idempotency](https://docs.alvys.com/en/api/guides/idempotency.md)
- Update ใช้ **ETag + `If-Match`** ทุก PATCH: ไม่ส่ง → `428 Precondition Required`, stale → `412 Precondition Failed`, record ถูก settle แล้ว → `409` — [Updating Records Safely](https://docs.alvys.com/en/api/guides/concurrency.md)
- ไม่พบ header `Idempotency-Key` แบบ Stripe

**1.4 Webhooks** — FACT
- Event naming dot-separated `{resource}.{action}`: `load.status.changed, load.changed, trip.status.changed, trip.changed, tender.created, tender.accepted, ..., webhook.verification`; รายการจริงจาก `GET /api/p/v1/webhooks/event-types` — [Webhooks overview](https://docs.alvys.com/en/api/reference/webhooks/overview.md)
- Envelope: `id, type, timestamp, version ("v1"/"v2"), etag, subsidiaryId, data` (data = full snapshot + optional `data.diff.changes[]`) — [Load events](https://docs.alvys.com/en/api/reference/webhooks/load-events.md)
- Headers: `X-Alvys-Event, X-Alvys-Event-Id, X-Alvys-Timestamp, X-Alvys-Signature, X-Alvys-Attempt` — [Webhooks overview](https://docs.alvys.com/en/api/reference/webhooks/overview.md)
- Signature: `X-Alvys-Signature: t={timestamp},v1={sig}`, HMAC-SHA256 ของ `{timestamp}.{eventId}.{raw_body}`, tolerance แนะนำ 5 นาที, ระหว่าง rotate secret ส่ง `v1` (ใหม่) + `v0` (เก่า) — [Security & Signature](https://docs.alvys.com/en/api/reference/webhooks/security-signature-verification.md)
- Retry: สูงสุด 4 ครั้ง (initial + retry ที่ ~10s/30s/60s), timeout 30s, retry เฉพาะ 5xx/408/429/network; at-least-once; dedupe ด้วย `X-Alvys-Event-Id`; disable อัตโนมัติเมื่อ 10 events ล้มเหลวติดกัน; **ไม่มี replay endpoint** — [Event Delivery & Reliability](https://docs.alvys.com/en/api/reference/webhooks/event-delivery-reliability.md)
- Subscription ผ่าน API: `POST /api/p/v1/webhooks`, verify ownership `POST /webhooks/{id}/verify`, มี `rotate-secret`, `delivery-logs`, `health metrics`, `test` — [v1.0 index](https://docs.alvys.com/_llms/en/api-documentation/v1-0.txt)

**1.5 Pagination / filtering** — FACT
- Offset-style ใน body: `Page` (เริ่ม 0), `PageSize` (>0, ตัวอย่าง 200, ไม่ระบุ max); response `Items[], Page, PageSize, Total, Facets`; filter `DateRange, UpdatedAtRange, Status[], OrderNumbers[], LoadNumbers[] (max 150), CustomerId`; ต้องมี filter อย่างน้อย 1; **ไม่มี sort / field selection** — [Search loads](https://docs.alvys.com/en/api/reference/loads/search-loads.md)

**1.6 Rate limit / versioning** — FACT
- Global: 10 req/s ต่อ token, 300 req/10s ต่อ organization; endpoint-level เช่น `POST /loads/search` 10 req/min, `GET /loads` 5 req/min; เกิน → `429` + `Retry-After` (วินาที); ไม่มี remaining-quota header — [Rate Limits](https://docs.alvys.com/en/api/guides/rate-limits.md)
- Versioning: path segment `/api/p/v1/...` และ header `api-version` (override route, แนะนำให้ส่งเสมอ) รูปแบบ semver; `v1.0` เป็น version เดียวที่ release; ระบุรายการ breaking vs non-breaking ชัด; **deprecation timeline ไม่พบข้อมูล** — [Versioning](https://docs.alvys.com/en/api/guides/versioning.md)

**1.7 Error format** — FACT
- 400 ใช้ `ValidationProblemDetails` (`Errors{field:[msg]}, Type, Title, Status, Detail, Instance`), 401/403/404/429 ใช้ `ProblemDetails` (`application/problem+json`) — [Assign trip](https://docs.alvys.com/reference/trips/assign-trip.md)
- Guide กลางบอกว่า 5XX เป็น problem+json, 4XX "may include an error message", ห้าม hard-code error message; list ว่าง → 200 + empty ไม่ใช่ 404 — [Response Codes](https://docs.alvys.com/en/api/guides/response-codes.md)
- Error code catalog (machine-readable code): ไม่พบข้อมูล

**1.8 Sandbox / OpenAPI / SDK** — FACT
- Sandbox: ไม่พบข้อมูล (Base URL page ระบุ production เท่านั้น) — [Base URL](https://docs.alvys.com/en/api/guides/base-url.md)
- OpenAPI: มีลิงก์ `https://docs.alvys.com/openapi/alvys.json` ใน index (เปิดจาก environment นี้ไม่ได้) — [v1.0 index](https://docs.alvys.com/_llms/en/api-documentation/v1-0.txt)
- SDK: ไม่พบข้อมูล; มี MCP server สำหรับ AI agents — [v1.0 index](https://docs.alvys.com/_llms/en/api-documentation/v1-0.txt)

**1.9 Bulk / async** — FACT
- Carrier invoice: `POST /invoices/carrier-invoice` multipart (File, TripId, CarrierInvoiceNumber, PaymentType) ตอบ `200` sync — [Create carrier invoice](https://docs.alvys.com/en/api/reference/invoices/create-carrier-invoice.md)
- Bulk/async job endpoint: ไม่พบข้อมูล

**1.10 OPINION — จุดดี/จุดแย่ของ docs**
- ดี: guide ครบที่สุดใน 6 ตัว (idempotency, ETag concurrency, versioning policy, rate limit ตาราง, webhook security/retry เป็นหน้าแยก), มี llms.txt + .md ทุกหน้า
- แย่: ไม่มี create load ใน public API, PascalCase/camelCase ไม่สม่ำเสมอ, pagination เป็น offset ใน body, ไม่มี sandbox, error 4xx ไม่ล็อก schema ทุก endpoint

---

## 2. Rose Rocket (roserocket.readme.io) — LTL/FTL TMS, Canada

**2.1 Auth** — FACT
- ต้องลงทะเบียน integration เป็น "Org App" ก่อน ไม่งั้น API "will refuse connections outright"; Authenticate ส่ง `username, password` (login ของ user) + `client_id` (Org App Key) + `client_secret`; ได้ `access_token` อายุ 24 ชั่วโมง ใส่ใน header — [Guides index](https://roserocket.readme.io/v1.0/docs), [Getting started](https://roserocket.readme.io/v1.0/docs/getting-started)
- Token URL จริง: ไม่พบในหน้า docs (อยู่ใน Postman collection บน Google Drive) — [Postman collection](https://roserocket.readme.io/v1.0/docs/postman-collection)
- Scope ต่อ key / rotation: ไม่พบข้อมูล
- Third-party profile ระบุ Platform Model API (v2) ใช้ OAuth2 (Auth0 ที่ `a.roserocket.com`) และ credential ขอผ่าน account rep — [apis.io](https://apis.io/providers/rose-rocket/) (third-party, ไม่ใช่ docs ทางการ)

**2.2 Resource model / naming** — FACT
- Base `https://platform.roserocket.com/api/v1`; มี Internal API ที่ `https://<subdomain>.roserocket.com` ซึ่ง "NO documentation" แต่ใช้ token เดียวกัน — [Using the internal API](https://roserocket.readme.io/v1.0/docs/using-the-internal-api)
- โครงสร้าง: `customers/{customerID}/orders/{orderID}` (nested ใต้ customer), `legs`, `manifests` (= trip/route), `manifests/{id}/stops`, `partner_carriers`, `equipment`, `invoices`, `bills`, `receivables`, `users`, `webhooks`, `external_ids` — [Get leg (sidebar)](https://roserocket.readme.io/v1.0/reference/get-leg)
- Path param รับ external ID ได้โดยตรงด้วย prefix `ext:{externalID}` หรือ `external_id:{externalID}` — [Get leg](https://roserocket.readme.io/v1.0/reference/get-leg)
- Status transitions เป็น verb endpoint: `POST .../orders/{orderID}/mark_delivered`, `mark_in_transit`, `cancel`, `book`; POD: `GET .../orders/{orderID}/pod` — [Mark delivered](https://roserocket.readme.io/v1.0/reference/mark-order-as-delivered), [POD](https://roserocket.readme.io/v1.0/reference/get-order-proof-of-delivery)
- Status IDs เป็น slug: `new, saved, quoted, dispatched, in-transit, delivered, invoice-created, invoice-sent, invoice-paid, ...` — [Order status IDs](https://roserocket.readme.io/v1.0/docs/order-status-ids)
- Field naming snake_case (`pickup_start_at`, `po_num`, `billing_option`) — [Upsert order](https://roserocket.readme.io/v1.0/reference/upsert-order-by-external-id)

**2.3 Idempotency** — FACT
- Upsert by external ID: `POST /customers/{customerID}/orders/{orderID}/upsert` โดย `orderID` = `ext:{externalID}`; body มี `external_id` ด้วย; docs ไม่อธิบายเกณฑ์ create vs update — [Upsert order by external ID](https://roserocket.readme.io/v1.0/reference/upsert-order-by-external-id)
- Multi external IDs ต่อ order: `PUT /external_ids/orders/{orderID}` body `external_ids[]` — [Upsert external IDs](https://roserocket.readme.io/v1.0/reference/upsert-external-ids-for-an-order)
- `Idempotency-Key` header: ไม่พบข้อมูล

**2.4 Webhooks** — FACT
- ตั้งค่าใน Settings > Advanced Settings > Webhooks และผ่าน API `POST /webhooks` (body = "webhook object" ไม่ระบุ field) — [Webhooks guide](https://roserocket.readme.io/v1.0/docs/webhooks-1), [Create webhook](https://roserocket.readme.io/v1.0/reference/create-webhook)
- Events (ชื่อตาม UI): Order Created/Updated/Deleted/Status Updated/Dispatched/In Transit/Delivered/POD Uploaded; Leg Created/Deleted/Dispatched/Loaded/Unloaded; Manifest Created/Assigned/Dispatched/Moving/Completed/Carrier Details Updated/Cost Details Updated; Task Completed — [Webhooks guide](https://roserocket.readme.io/v1.0/docs/webhooks-1)
- Payload: "Event object" มี type + record ID (thin event) ไม่มีตัวอย่าง JSON; signature: แนะนำให้ verify แต่ **ไม่ระบุวิธี**; retry: "**will not retry**" ต้องตอบ 2xx; replay: ไม่พบข้อมูล — [Webhooks guide](https://roserocket.readme.io/v1.0/docs/webhooks-1)

**2.5 Pagination / filtering** — FACT
- `GET /orders`: `offset` (≥0, default 0), `limit` (0–50, default 20); filters `created_start_at/end_at, updated_start_at/end_at, search_term, customer_id, po_num, ref_num, tender_num, in_external_ids[], in_status_ids[]`; `sort` มีใน docs แต่ระบุว่า "not supported"; response schema ไม่แสดง — [Search orders](https://roserocket.readme.io/v1.0/reference/find-orders)

**2.6 Rate limit / versioning / deprecation** — FACT
- Rate limit: ไม่พบข้อมูลใน docs ทางการ
- Versioning: `/api/v1` (platform) และ `/api/v2/platformModel` (network) — [Using the internal API](https://roserocket.readme.io/v1.0/docs/using-the-internal-api), [apis.io](https://apis.io/providers/rose-rocket/)
- Deprecation policy: ไม่พบข้อมูล; changelog มี 2 entries (เก่ากว่า 2 ปี) — [Changelog](https://roserocket.readme.io/v1.0/changelog)

**2.7 Error format** — FACT
- ทุก endpoint ที่เปิดดูระบุเพียง `200 successful operation` / `400 Bad request` ไม่มี body schema — [Search orders](https://roserocket.readme.io/v1.0/reference/find-orders)
- Error code catalog: ไม่พบข้อมูล

**2.8 Sandbox / OpenAPI / SDK** — FACT
- Sandbox: ไม่พบข้อมูล; "Try It" ใน ReadMe ยิง production จริง ("can modify data") — [Testing from ReadMe](https://roserocket.readme.io/v1.0/docs/testing-the-api-from-readme)
- OpenAPI download: ไม่พบลิงก์ใน docs; มี Postman collection บน Google Drive — [Postman collection](https://roserocket.readme.io/v1.0/docs/postman-collection)
- SDK: ไม่พบข้อมูล

**2.9 Bulk / async** — FACT
- `POST /customers/{customerID}/orders/bulk_create` body `orders[]`; max size/async: ไม่ระบุ — [Bulk create orders](https://roserocket.readme.io/v1.0/reference/bulk-create-orders)
- Invoice async job: ไม่พบข้อมูล

**2.10 OPINION**
- ดี: external-ID-as-path (`ext:`) ใช้งานจริงสะดวกมากสำหรับ ERP connector; resource ครบ (order→leg→manifest→stop, bills/receivables)
- แย่: docs ระดับ "มีแต่ชื่อ endpoint" (ไม่มี response schema, ไม่มี error format), webhook ไม่ retry/ไม่มี signature spec, แนะนำให้ไปแกะ internal API เอง = contract ไม่มั่นคง

---

## 3. Shipsy (knowledge.shipsy.ai / shipsy.atlassian.net) — Logistics platform, India/MEA

**3.1 Auth** — FACT
- API key สร้างโดย admin ใน My Account → Account Info → "Generate API Key" แล้วเห็น "API header details", sample cURL, SSL cert (.crt) — [Generate API Key](https://knowledge.shipsy.ai/help/exim/generate-api-key-and-access-api-header-details--8anqqnps)
- ชื่อ header จริง, scope, rotation: ไม่พบข้อมูล (แสดงหลัง login เท่านั้น)
- Third-party (Unicommerce) ระบุ connector ต้องการ `API Key` + `Customer Code` ที่ Shipsy ออกให้ "for each seller" (key ต่อ customer) — [Unicommerce](https://support.unicommerce.com/index.php/knowledge-base/integration-with-shipsy/) (third-party)

**3.2 Resource model** — FACT
- EXIM product: base `https://eximapi.shipsy.in/` endpoints `POST /add/bl, /add/bk, /add/container, DELETE /bl, GET /track, GET /vessel-schedules, POST /inquiry, POST /shipments/external` (verb-style, singular) — [SAP API Integration](https://knowledge.shipsy.ai/help/exim/shipsy-sap-api-integration-details--lqxe0_vj)
- Logistics/TMS (consignment, trip, rider, vehicle, hub) endpoint paths: **ไม่พบข้อมูลสาธารณะ** — docs สาธารณะพูดถึง "consignment status และ consignment trips" webhook เท่านั้น — [Consignment Webhooks](https://shipsy.atlassian.net/wiki/spaces/HELP/pages/3646914746/Consignment+Webhooks)

**3.3 Idempotency** — ไม่พบข้อมูล (มี customer reference number เป็น identifier ตาม Unicommerce แต่ไม่มี spec)

**3.4 Webhooks** — FACT
- ตั้งค่าใน UI (Integrations → Integration Marketplace → Webhooks): URL, request type default POST, "Select Authorisation", Headers, Parameters, Body (on-demand/default), เลือก event ได้จาก **62 events**, ตัวเลือก "Use Static IP Address", trigger parent/child consignment — [Settings in a Webhook](https://shipsy.atlassian.net/wiki/spaces/HELP/pages/3650748511/Settings+in+a+Webhook+Integration), [Configuring Events](https://shipsy.atlassian.net/wiki/spaces/HELP/pages/3650159132/Configuring+Events+in+a+Webhook)
- Payload formats: Client Level (Default / On-Demand), Customer Level (Default / Format 1 / Format 2), Trip Level (First&Last Mile / Middle Mile / On-Demand) — ไม่มีตัวอย่าง JSON — [Webhook Formats](https://shipsy.atlassian.net/wiki/spaces/HELP/pages/3650486354/Webhook+Formats)
- Webhook ส่งที่ระดับ organisation, filter ได้ — [Status Update Webhook](https://shipsy.atlassian.net/wiki/spaces/HELP/pages/3650519152/What+is+Status+Update+Webhook)
- Signature/HMAC, retry, replay, event names: ไม่พบข้อมูล; ขอ webhook ใหม่ "chargeable" — [Consignment Webhooks](https://shipsy.atlassian.net/wiki/spaces/HELP/pages/3646914746/Consignment+Webhooks)

**3.5–3.9 Pagination / rate limit / versioning / error / sandbox / OpenAPI / SDK / bulk** — ไม่พบข้อมูลสาธารณะ

**3.10 OPINION**
- Shipsy เป็น enterprise "docs behind login" — public knowledge base มีเฉพาะ how-to UI ไม่มี API contract ให้ developer ประเมินก่อนเซ็นสัญญา เป็น anti-pattern ที่เราควรหลีกเลี่ยงถ้าต้องการให้ ERP connector ภายนอก self-serve
- จุดที่น่าหยิบ: webhook configurable auth header + static IP egress และ payload "format" หลายแบบต่อ audience (client vs customer vs trip)

---

## 4. Locus (locus.sh) — Dispatch/last-mile, India (Ingka Group)

**4.1 Auth** — FACT
- "API integrations are only available to Locus clients"; Locus rep ส่ง Client ID + authentication details ทางอีเมล; ใน SwaggerUI กด Authorize — [API references](https://locus.sh/resources/api-references)
- Third-party profile: HTTP Basic + API key (มีความไม่สอดคล้องกับ "bearer" ในหน้าเดียวกัน) — [apis.io](https://apis.io/providers/locus-sh/), [api-evangelist](https://github.com/api-evangelist/locus-sh) (third-party)
- Scope/rotation: ไม่พบข้อมูล

**4.2 Resource model** — FACT
- 3 OpenAPI 2.0 specs: Order Management `https://oms.locus-api.com/v1`, Entity Management `https://locus-api.com/v1`, Platform Entities `https://platform.locus-api.com/v1`; เปิดผ่าน SwaggerUI `https://docs.locus.sh/?model=...` — [API references](https://locus.sh/resources/api-references)
- Tenant อยู่ใน path: `PUT /client/{clientId}/order/{orderId}` (create), `PUT /client/{clientId}/order/{orderId}/park`, `.../cancel`, `POST /client/{clientId}/get-slots`, `GET /client/{clientId}/roster/{rosterId}`; resource เป็น **เอกพจน์** — [apis.io](https://apis.io/providers/locus-sh/) (third-party สรุปจาก spec)
- Task: `GET https://locus-api.com/v1/client/{clientId}/task/{taskId}` — [Kapture blog](https://kapturecrm.com/developer/blog/?p=591) (third-party)
- Entities: locations, riders, rider personas, rosters, transporters, vehicles, vehicle models, homebases, SKU, personnel, teams — [api-evangelist](https://github.com/api-evangelist/locus-sh) (third-party)

**4.3 Idempotency** — FACT (ตีความจาก path)
- Create order เป็น `PUT /client/{clientId}/order/{orderId}` คือ client กำหนด orderId เอง = natural upsert by external id — [apis.io](https://apis.io/providers/locus-sh/)
- **OPINION:** นี่คือ pattern "PUT /orders/{externalId}" ที่โจทย์ถามถึง ใช้ได้ดีกับ ERP ที่มี order number เป็นเจ้าของอยู่แล้ว

**4.4 Webhooks** — ไม่พบข้อมูลใน spec/public docs (third-party scorecard ให้ "Event Surface Described: missing") — [api-evangelist README](https://github.com/api-evangelist/locus-sh)

**4.5–4.7 Pagination / rate limit / versioning / error** — ไม่พบข้อมูล (มี `/v1` ใน base URL เท่านั้น)

**4.8 Sandbox / OpenAPI / SDK** — FACT
- OpenAPI: มี (Swagger 2.0 JSON 3 ไฟล์ โหลดผ่าน SwaggerUI; เปิดตรงจาก environment นี้ไม่ได้) — [API references](https://locus.sh/resources/api-references)
- Sandbox, SDK: ไม่พบข้อมูล; ไม่มี self-serve signup — [API references](https://locus.sh/resources/api-references)

**4.9 Bulk / async** — ไม่พบข้อมูล

**4.10 OPINION**
- ดี: spec-first (OpenAPI เป็นแหล่งเดียว), tenant ชัดใน path, client-owned ID
- แย่: ไม่มี guide ใดเลยนอก Swagger (ไม่มี webhook/ratelimit/error semantics), gated access

---

## 5. Onfleet (docs.onfleet.com) — Last-mile delivery, US

**5.1 Auth** — FACT
- HTTP Basic: API key เป็น username, password ว่าง; สร้างได้หลาย key ต่อ org ใน dashboard — [Authentication](https://docs.onfleet.com/reference/authentication)
- Scoped key: ตัวเลือกเดียว "API key can only access tasks it creates" — [Scoped API Key](https://docs.onfleet.com/reference/scope-api-key)
- Rotation policy: ไม่พบข้อมูล

**5.2 Resource model** — FACT
- Base `https://onfleet.com/api/v2`; พหูพจน์ flat: `tasks, workers, teams, destinations, recipients, hubs, containers, webhooks, administrators, organizations, route plans` — [Create task](https://docs.onfleet.com/reference/create-task), [pyonfleet README](https://github.com/onfleet/pyonfleet/blob/master/README.md)
- Task = 1 destination + 1 recipient; `POST /tasks` body `destination (id|object), recipients[], completeAfter/completeBefore (unix ms), pickupTask, notes, quantity`; response `id, shortId, state (int)` — [Create task](https://docs.onfleet.com/reference/create-task)
- Lookup ทางเลือก: `GET /tasks/shortId/{shortId}` — [Tasks](https://docs.onfleet.com/reference/tasks)
- Field naming camelCase

**5.3 Idempotency** — ไม่พบข้อมูล (create task ไม่มี idempotency key / external id upsert) — [Create task](https://docs.onfleet.com/reference/create-task)

**5.4 Webhooks** — FACT
- Triggers เป็นตัวเลข+ชื่อ (30 รายการ): `0 taskStarted, 1 taskEta, 2 taskArrival, 3 taskCompleted, 4 taskFailed, 5 workerDuty, 6 taskCreated, 7 taskUpdated, 8 taskDeleted, 9 taskAssigned, 10 taskUnassigned, 12 taskDelayed, ... 19 taskBatchCreateJobCompleted, 22–29 routePlan*, 30 predictedTaskDelay, 31 taskPredictedEta`; บาง trigger มี `threshold` — [Webhooks](https://docs.onfleet.com/reference/webhooks)
- Payload: `taskId, workerId, adminId, actionContext{id,type}, triggerId, triggerName, time (ms), data{task|worker}` — [Webhooks](https://docs.onfleet.com/reference/webhooks)
- Signature: header `X-Onfleet-Signature` = HMAC-SHA512 ของ raw body ด้วย secret (hex-decoded) จาก dashboard; ไม่มี timestamp → ไม่มี replay protection — [Webhook Authentication](https://docs.onfleet.com/reference/secrets.md), [Hookdeck guide](https://hookdeck.com/webhooks/platforms/guide-to-onfleet-webhooks-features-and-best-practices.md) (third-party)
- Validation handshake: GET พร้อม `check` param ต้อง echo กลับ 200 — [Hookdeck guide](https://hookdeck.com/webhooks/platforms/guide-to-onfleet-webhooks-features-and-best-practices.md) (third-party; หน้า official validation เปิดไม่ได้)
- Retry: "retried in 30-minute cycles, up to one full day"; failure = non-200; auto-disable หลัง 300 consecutive failures; replay: ไม่พบข้อมูล — [Retry](https://docs.onfleet.com/reference/retry.md)

**5.5 Pagination** — FACT
- `GET /tasks/all?from=<unix ms>` (required) `&to&lastId&state&worker&completeBeforeBefore&completeAfterAfter&containers`; cursor = `lastId` (หายไปในหน้าสุดท้าย); page ≤ 64 tasks; ไม่มี sort/field selection — [List tasks](https://docs.onfleet.com/reference/list-tasks)

**5.6 Rate limit / versioning** — FACT
- 20 req/s ต่อ organization (รวมทุก key); headers `X-RateLimit-Limit`, `X-RateLimit-Remaining`; เกิน → 429 แล้วอาจ "temporary ban" — [Throttling](https://docs.onfleet.com/reference/throttling)
- Versioning `/api/v2` ใน URL; deprecation policy: ไม่พบข้อมูล

**5.7 Error format** — FACT
- `{ "code": "InvalidCredentials", "message": { "error": 1102, "message": "...", "request": "<uuid>", "cause": "..." } }`; catalog อยู่ใน gist ภายนอก "periodically updated" — [Errors](https://docs.onfleet.com/reference/errors)
- Batch errors ใช้ shape ต่างกัน (`statusCode, error, message, cause`) — [Batch async](https://docs.onfleet.com/reference/create-tasks-in-batch-async)

**5.8 Sandbox / OpenAPI / SDK** — FACT
- Test = **แยก organization** (ขอทางอีเมล) key แยกจาก production; "do not currently support environment-scoped API keys" — [Environment isolation](https://docs.onfleet.com/reference/environment-isolation)
- SDK: Python `pyonfleet`, JS `node-onfleet` (active); PHP/Go/Ruby/Java deprecated — [API wrappers](https://docs.onfleet.com/reference-link/api-wrappers)
- OpenAPI download: ไม่พบข้อมูล

**5.9 Bulk / async** — FACT
- `POST /tasks/batch-async` body `tasks[]` ≤ 500 → `{"status":"pending","jobId":"..."}`; poll `GET /tasks/batch/{jobId}` → `status (เช่น completedWithErrors), tasksReceived, tasksCreated, tasksErrored, errors[], failedTasks[], newTasks[]`; หรือรับ webhook `taskBatchCreateJobCompleted` — [Batch async](https://docs.onfleet.com/reference/create-tasks-in-batch-async), [Batch job status](https://docs.onfleet.com/reference/batch-job-status)

**5.10 OPINION**
- ดี: async job pattern (submit → jobId → poll หรือ webhook) ชัดที่สุดใน 6 ตัว; rate-limit header; error มี request id
- แย่: error code catalog อยู่นอก docs, 2 error shapes, webhook ไม่มี timestamp/replay, test ต้องขอ org แยก, ไม่มี idempotency

---

## 6. Track-POD (api.track-pod.com) — ePOD / route, EU

**6.1 Auth** — FACT
- Header `X-API-KEY`; key จาก Settings → Integrations → Web API; สร้างหลาย key, จำกัดได้ตาม domain / HTTP method / Allowed IP list — [Track-POD API explained](https://track-pod.com/blog/track-pod-api-explained/), [api-evangelist](https://github.com/api-evangelist/track-pod)
- Scope ระดับ resource / rotation: ไม่พบข้อมูล

**6.2 Resource model** — FACT
- Base `https://api.track-pod.com`; resource **เอกพจน์ PascalCase**: `/Order, /Route, /Driver, /Vehicle, /Address, /RejectReason, /VehicleCheck, /Test`; lookup หลาย identifier: `GET /Order/Number/{number}`, `/Order/Id/{id}`, `/Order/TrackId/{trackId}`, `/Order/Date/{date}`, `/Order/Route/Code/{code}`; status: `PUT /Order/Number/{number}/Status|Complete|Reject`; POD: `GET /Order/Number/{number}/Pdf`; label: `/Shipping-label` — [apis.io Order API](https://apis.io/apis/track-pod/track-pod-order-api/) (third-party สรุปจาก OpenAPI), [apis.io provider](https://apis.io/providers/track-pod/)
- รับ JSON/XML — [Jentic](https://www.jentic.com/apis/track-pod) (third-party)

**6.3 Idempotency** — FACT
- `PUT /Order` (update ด้วย Number ใน body), `POST /Address` = "add or update address" (upsert); `Idempotency-Key`: ไม่พบข้อมูล — [apis.io Order API](https://apis.io/apis/track-pod/track-pod-order-api/), [Jentic](https://www.jentic.com/apis/track-pod)

**6.4 Webhooks** — FACT
- Events: Order created/updated/deleted/status updated/rescheduled/load status updated/feedback submitted/"status updated and POD ready"; Route created/updated/deleted/started/closed/optimized/ETA recalculated/load status updated; Vehicle check completed; Chat message created — [How to use Webhooks](https://track-pod.freshdesk.com/support/solutions/articles/103000049842-how-to-use-webhooks-)
- Payload: `Metadata{Event, Date}` + `Data{...}` (order: `Id, Number, RouteNumber, Status, StatusId, Address, TimeSlotFrom/To, GoodsList, TrackKey, TrackLink`); ไม่รับประกันลำดับ → ใช้ `Date` — [How to use Webhooks](https://track-pod.freshdesk.com/support/solutions/articles/103000049842-how-to-use-webhooks-)
- Auth: header `X-TRACK-POD-TOKEN` = shared secret (ไม่ใช่ HMAC); HTTPS only — [How to use Webhooks](https://track-pod.freshdesk.com/support/solutions/articles/103000049842-how-to-use-webhooks-)
- Retry: 5 ครั้ง exponential backoff ที่ 1 / 5.9 / 34.81 / 205.38 / 1211.7 นาที; เก็บ attempts 15 วัน; **manual retry จาก UI** (= replay) — [How to use Webhooks](https://track-pod.freshdesk.com/support/solutions/articles/103000049842-how-to-use-webhooks-)

**6.5 Pagination** — FACT: ไม่พบ pagination param; list ด้วย date/route; `GET /Order/Number/{number}/List` = "last 25 orders" — [apis.io Order API](https://apis.io/apis/track-pod/track-pod-order-api/)

**6.6 Rate limit / versioning** — FACT
- 20 req/s หรือ 400 req/min; `/Test` ใช้ตรวจ quota — [Track-POD API explained](https://track-pod.com/blog/track-pod-api-explained/), [apis.io provider](https://apis.io/providers/track-pod/)
- Headers ที่ส่งกลับ, versioning, deprecation: ไม่พบข้อมูล (มี endpoint ที่ mark deprecated ใน spec เช่น `PUT /Order/Id/{id}/Status`)

**6.7 Error format** — ไม่พบข้อมูล

**6.8 Sandbox / OpenAPI / SDK** — FACT
- Sandbox: `https://api.sandbox.track-pod.com` — [apis.io Order API](https://apis.io/apis/track-pod/track-pod-order-api/), [api-evangelist](https://github.com/api-evangelist/track-pod)
- OpenAPI: Swagger UI ที่ `https://api.track-pod.com/index.html` — [Track-POD API explained](https://track-pod.com/blog/track-pod-api-explained/)
- SDK: ไม่พบข้อมูล (มี Zapier/Integrately) — [api-evangelist](https://github.com/api-evangelist/track-pod)

**6.9 Bulk / async** — FACT: `POST /Order/Bulk` ≤ 500 orders (sync); async job: ไม่พบข้อมูล — [apis.io Order API](https://apis.io/apis/track-pod/track-pod-order-api/)

**6.10 OPINION**
- ดี: sandbox จริง, webhook retry schedule + manual replay + signing secret regenerate ชัด, lookup by business key (`Number`) ทุก action
- แย่: เอกพจน์ PascalCase ใน path, auth webhook เป็น shared token ไม่ใช่ HMAC, ไม่มี error/pagination spec, docs กระจาย blog/freshdesk/swagger

---

## 7. Reference มาตรฐาน: Stripe / Shopify

- **Idempotency (Stripe)** — FACT: header `Idempotency-Key` (≤255 chars, แนะนำ UUID v4) ใช้กับทุก POST; เซฟ status+body ของ request แรก, retry คืนค่าเดิม; key เดิมแต่ param ต่าง → error (`idempotency_error`, HTTP 409); key ถูก prune หลัง ≥24h — [Idempotent requests](https://docs.stripe.com/api/idempotent_requests.md), [Errors](https://docs.stripe.com/api/errors?api-version=2025-04-30.basil)
- **Webhook signature (Stripe)** — FACT: `Stripe-Signature: t=...,v1=...`; signed_payload = `timestamp + "." + raw body`; HMAC-SHA256; tolerance default 5 นาที; roll secret ให้ secret เก่า active ≤24h (หลาย v1); retry exponential backoff ≤3 วัน (live) / 3 ครั้ง (sandbox); manual resend ≤15 วัน (Dashboard) / ≤30 วัน (CLI); ไม่รับประกันลำดับ → dedupe ด้วย event id; ต้องตอบ 2xx เร็ว — [Webhooks](https://docs.stripe.com/webhooks)
- **Pagination (Stripe)** — FACT: `limit` (default 10), `starting_after`, `ending_before`; response `data[], has_more`; reverse-chronological — [How pagination works](https://docs.stripe.com/pagination.md)
- **Errors (Stripe)** — FACT: `type (api_error|card_error|idempotency_error|invalid_request_error), code, message, param, doc_url, request_log_url`; HTTP 400/401/402/403/404/409/424/429/5xx — [Errors](https://docs.stripe.com/api/errors?api-version=2025-04-30.basil)
- **Versioning (Stripe)** — FACT: date-based `2024-09-30.acacia`; monthly non-breaking + major ปีละ 2 ครั้ง; header `Stripe-Version`; account default pinned; webhook endpoint pin version ได้; รายการ backward-compatible changes ชัด — [API versioning](https://docs.stripe.com/api-versions?locale=en-GB)
- **Rate limit (Stripe)** — FACT: global 100 req/s live, 25 req/s sandbox, 25 req/s ต่อ endpoint; 429 + header `Stripe-Rate-Limited-Reason` (`global-rate|endpoint-rate|global-concurrency|endpoint-concurrency|resource-specific`) — [Rate limits](https://docs.stripe.com/rate-limits.md)
- **Versioning (Shopify)** — FACT: `YYYY-MM` ใน URL ออกทุกไตรมาส, รองรับ ≥12 เดือน, overlap ≥9 เดือน, header `X-Shopify-API-Version` ใน response — [Shopify versioning](https://shopify.dev/api/usage/versioning)
- **Rate limit (Shopify REST)** — FACT: leaky bucket 40 req/app/store, leak 2/s (Plus ×10); header `X-Shopify-Shop-Api-Call-Limit: 32/40`; 429 + `Retry-After` — [Shopify rate limits](https://shopify.dev/docs/api/admin-rest/usage/rate-limits.md)
- **RFC 9457** — FACT: obsoletes RFC 7807; members `type, status, title, detail, instance`; media type `application/problem+json` — [RFC 9457](https://www.rfc-editor.org/rfc/rfc9457.html)

---

## 8. ตารางเทียบ 6 ตัว × 9 มิติ

| มิติ | Alvys | Rose Rocket | Shipsy | Locus | Onfleet | Track-POD |
|---|---|---|---|---|---|---|
| Auth | OAuth2 client-credentials, scope `entity:perm`, ≤10 creds/tenant | user/pass+client_id/secret → token 24h; v2 OAuth2 (Auth0) | API key ต่อ customer (header ไม่เปิดเผย) | Basic + API key, Client ID ทางอีเมล | Basic (key=username), 1 scope option | `X-API-KEY`, จำกัด IP/method/domain |
| Resource/URL | พหูพจน์, PascalCase body, `POST /x/search`, stops ใต้ trips | nested `customers/{c}/orders/{o}`, `ext:` prefix, verb endpoints | ไม่พบ (TMS); EXIM verb-style | เอกพจน์, tenant ใน path `/client/{id}/order/{id}` | พหูพจน์ flat, camelCase | เอกพจน์ PascalCase, lookup หลาย key |
| Idempotency | `ExternalId` body (create) + ETag/If-Match (update) | upsert `/orders/ext:{id}/upsert` | ไม่พบ | `PUT .../order/{clientOrderId}` | ไม่พบ | `PUT /Order` by Number, `POST /Address` upsert |
| Webhooks | envelope+diff, HMAC-SHA256 `t=,v1=`, 4 attempts, auto-disable 10, no replay | thin event, no retry, signature ไม่ระบุ | 62 events, configurable auth, format หลายแบบ, ไม่มี spec | ไม่พบ | 30 numeric triggers, HMAC-SHA512 no timestamp, 30-min cycles 1 วัน, disable 300 | Metadata+Data, shared token, 5 retries backoff, manual replay |
| Pagination | `Page/PageSize` ใน body, `Total` | `offset/limit≤50`, sort ไม่ทำงาน | ไม่พบ | ไม่พบ | cursor `lastId`, ≤64 | ไม่มี (date/route list) |
| Rate limit | 10/s token, 300/10s org, per-endpoint, `Retry-After` | ไม่พบ | ไม่พบ | ไม่พบ | 20/s org, `X-RateLimit-*` | 20/s, 400/min |
| Versioning/Deprecation | `/v1` + `api-version` header, semver, breaking list; timeline ไม่พบ | `/v1`,`/v2`; policy ไม่พบ | ไม่พบ | `/v1`; ไม่พบ | `/v2`; ไม่พบ | ไม่พบ |
| Error format | problem+json (ValidationProblemDetails) | เฉพาะ 200/400 | ไม่พบ | ไม่พบ | `code` + `message{error,request,cause}` | ไม่พบ |
| Sandbox/OpenAPI/SDK | ไม่มี sandbox / OpenAPI JSON / MCP | ไม่มี / Postman GDrive / ไม่มี | ไม่พบ | gated / Swagger 2.0 / ไม่มี | test org ขอแยก / ไม่พบ / Py,JS | sandbox host / Swagger UI / ไม่มี |
| Bulk/async | carrier invoice sync | `bulk_create` (ไม่ระบุ limit) | ไม่พบ | ไม่พบ | batch-async ≤500 + jobId poll + webhook | `/Order/Bulk` ≤500 sync |

**OPINION สรุป:** Alvys ชนะด้าน API governance (idempotency/ETag/versioning/webhook security), Onfleet ชนะด้าน async job + rate-limit header, Track-POD ชนะด้าน webhook ops (retry schedule + replay + sandbox), Rose Rocket ชนะด้าน external-id ergonomics แต่ docs อ่อน, Locus/Shipsy ไม่เหมาะเป็นต้นแบบ public API

---

## 9. "มาตรฐาน API ของเรา" (ข้อกำหนดสำหรับ dev)

### 9.1 Naming & URL
- Base: `https://api.<domain>/v1/` — version เป็น path segment `v1` (major เท่านั้น) และรับ header `X-Api-Version: 2026-11-01` สำหรับ minor/behavior pin (เหมือน Alvys `api-version` + Stripe date version)
- Resource **พหูพจน์ kebab-free lowercase**: `/orders`, `/trips`, `/stops`, `/drivers`, `/vehicles`, `/carriers`, `/customers`, `/invoices`, `/documents`, `/webhooks`
- Tenant **ไม่อยู่ใน path** (ผูกกับ credential เหมือน Alvys/Onfleet) — ลด leak และ URL ซ้ำซ้อน
- Nested เฉพาะ composition จริง: `/trips/{tripId}/stops/{stopId}`; ที่เหลือ flat + filter (`/orders?tripId=`)
- Action = verb sub-resource POST: `/trips/{id}/dispatch`, `/stops/{id}/arrive`, `/stops/{id}/depart`, `/orders/{id}/cancel`, `/invoices/{id}/finalize` (เหมือน Alvys/Rose Rocket/Track-POD)
- List = `GET` + query (ไม่ใช่ `POST /search` แบบ Alvys) เพื่อให้ cache/log ได้; search ซับซ้อนค่อยเพิ่ม `POST /orders:search` ภายหลัง
- JSON **camelCase** ทั้ง request/response/webhook (บทเรียน Alvys PascalCase vs camelCase)
- ID: opaque string prefix `ord_`, `trp_`, `stp_`, `drv_`, `veh_`, `inv_`, `evt_` (Stripe style) + ทุก record มี `externalId` (nullable, unique ต่อ tenant+resource)
- Timestamps ISO 8601 UTC พร้อม offset; money `{ "amount": "1250.00", "currency": "THB" }` string decimal

### 9.2 Auth
- Machine-to-machine: **OAuth2 client credentials** `POST /oauth/token` → JWT (RS256) อายุ 1 ชั่วโมง; scope รูปแบบ `resource:verb` (`orders:read orders:write invoices:read webhooks:manage`) ตาม Alvys
- UI ของเรา: Authorization Code + PKCE ออก JWT เดียวกัน ใส่ claims `tenantId, sub, scopes` → controller ชุดเดียว
- Static API key (`Authorization: Bearer tk_live_...`) เป็นทางเลือกสำหรับ connector ง่าย ๆ — map เป็น principal เดียวกัน; key ต่อ tenant ได้หลายใบ, ตั้ง scope/expiry/IP allowlist ต่อ key (Track-POD/Alvys)
- Rotation: สร้าง key ใหม่ได้โดย key เก่ายังใช้ได้ถึง `revokeAt` (≤7 วัน); มี `GET /api-keys` และ `lastUsedAt`
- Environment แยกด้วย prefix `tk_test_`/`tk_live_` (บทเรียน Onfleet ที่ต้องขอ org แยก)

### 9.3 Idempotency & concurrency
- ทุก `POST` ที่สร้าง/action รับ header `Idempotency-Key` (≤255, แนะนำ UUIDv4) scope ต่อ (tenant, key, path); เก็บ 24h; key เดิม+body hash เดิม → replay response เดิม + header `Idempotent-Replayed: true`; key เดิม+body ต่าง → `422` type `idempotency-mismatch`; request แรกยังทำงานอยู่ → `409` (Stripe)
- Upsert by external id: `PUT /orders/external/{externalId}` (เต็ม) และ `PATCH /orders/external/{externalId}` (merge) — 201 เมื่อสร้าง, 200 เมื่ออัปเดต; ทุก path param `{id}` ยอมรับ `ext:{externalId}` (Rose Rocket)
- Optimistic concurrency: ทุก GET/PUT/PATCH คืน `ETag`; `PATCH` ที่ส่ง `If-Match` ไม่ตรง → `412`; ไม่บังคับ 428 (ต่างจาก Alvys) แต่ connector ที่ต้องการ safety เปิดได้

### 9.4 Webhook contract
- Event name `{resource}.{action}` lowercase dot: `order.created, order.updated, order.cancelled, trip.dispatched, stop.arrived, stop.departed, delivery_order.status_changed, pod.captured, invoice.finalized, invoice.paid` — รายการจริงที่ `GET /v1/webhooks/event-types`
- Envelope (snapshot + diff, ตาม Alvys/Stripe):
  ```json
  { "id": "evt_01J...", "type": "invoice.finalized", "version": "1",
    "occurredAt": "2026-11-03T10:15:00Z", "tenantId": "tnt_...",
    "data": { "object": { ...full snapshot... }, "previousAttributes": { "status": "draft" } },
    "request": { "id": "req_...", "idempotencyKey": "..." } }
  ```
- Headers: `X-TMS-Event`, `X-TMS-Event-Id`, `X-TMS-Timestamp`, `X-TMS-Signature: t=<unix>,v1=<hex>`, `X-TMS-Attempt`
- Signature: HMAC-SHA256(secret, `${t}.${rawBody}`) — รูปแบบ Stripe/Alvys; tolerance 5 นาที; roll secret → ส่งทั้ง v1 ใหม่และเก่า 24h
- Delivery: timeout 10s, ต้องตอบ 2xx; retry เมื่อ 5xx/408/429/timeout/network **8 ครั้ง** backoff 1m, 5m, 30m, 2h, 6h, 12h, 24h, 24h (~3 วัน); at-least-once; ไม่รับประกันลำดับ; auto-disable หลัง 50 events ล้มเหลวติดกัน + ส่ง email
- Replay: `GET /v1/webhook-deliveries?eventId=`, `POST /v1/webhook-deliveries/{id}/retry`, `POST /v1/events/{id}/redeliver?endpointId=` (เก็บ 30 วัน) — ปิดช่องว่างที่ Alvys/Onfleet ไม่มี
- Subscription API: `POST /v1/webhooks { url, events[], description }` → คืน `secret` ครั้งเดียว; verify ด้วย event `webhook.verification` ที่ endpoint ต้อง echo `challenge`
- Event version ใน envelope (`version`) แยกจาก API version; เพิ่ม field = non-breaking

### 9.5 Error format (RFC 9457)
- `Content-Type: application/problem+json` ทุก 4xx/5xx:
  ```json
  { "type": "https://docs.<domain>/errors/validation-failed", "title": "Validation failed",
    "status": 422, "detail": "stops[1].plannedArrival must be after stops[0].plannedArrival",
    "instance": "/v1/orders", "code": "validation_failed", "requestId": "req_01J...",
    "errors": [ { "field": "stops[1].plannedArrival", "code": "out_of_order", "message": "..." } ] }
  ```
- `code` เป็น stable machine string (catalog ใน docs, ไม่เปลี่ยนโดยไม่ bump version); `detail/title` เปลี่ยนได้
- Mapping: 400 malformed, 401 unauthenticated, 403 scope/tenant, 404 not found (รวม cross-tenant), 409 state conflict (`invalid_state_transition`, `duplicate_external_id`), 412 etag, 422 validation/idempotency-mismatch, 429 rate limit, 5xx server (`request_id` เสมอ)
- List ว่าง → 200 + `data: []` ไม่ใช่ 404 (Alvys)

### 9.6 Pagination / filtering / sorting / fields
- Cursor-based: `?limit=50` (default 25, max 200) `&cursor=<opaque>`; response `{ "data": [...], "nextCursor": "...", "hasMore": true }` (Stripe/Onfleet) — ห้าม offset ใน public API
- Filter: `?status=in_transit,delivered&updatedAfter=2026-11-01T00:00:00Z&customerId=cus_...&externalId=PO-123`; ช่วงเวลาใช้คู่ `*After/*Before`
- Sort: `?sort=-updatedAt,plannedPickupAt` (prefix `-` = desc) whitelist ต่อ resource
- Field selection/expansion: `?fields=id,status,externalId` และ `?expand=stops,customer` (Stripe expand) — ไม่ embed ลึกโดย default
- Sync สำหรับ ERP: ทุก list รองรับ `updatedAfter` + sort `updatedAt` เสถียร (tie-break ด้วย id) เพื่อ incremental pull

### 9.7 Versioning / deprecation
- Major ใน path (`/v1`) เปลี่ยนเฉพาะ breaking; behavior date-version ผ่าน `X-Api-Version` (default = วันที่ tenant สร้าง) — เพิ่ม field/enum/endpoint = non-breaking (Stripe list)
- Deprecation: ประกาศ ≥12 เดือน, response header `Deprecation: true`, `Sunset: <HTTP-date>`, `Link: <docs>; rel="deprecation"`; changelog page + email ถึง owner ของ key ที่ยังเรียก endpoint นั้น (บทเรียน Shopify 12 เดือน)
- Enum ใหม่ส่งได้เสมอ → client ต้อง tolerate unknown (`status` อื่นให้ map เป็น `unknown`)

### 9.8 Rate limit
- Default ต่อ tenant: 50 req/s burst 100 (token bucket), ต่อ key 20 req/s; write endpoints หนัก (bulk, invoice finalize) 5 req/s; webhook egress ไม่นับ
- Headers ทุก response: `RateLimit-Limit`, `RateLimit-Remaining`, `RateLimit-Reset` (วินาที) + `Retry-After` เมื่อ 429; body problem+json `code: rate_limited`, field `scope: tenant|key|endpoint` (Stripe `Stripe-Rate-Limited-Reason`)
- Plan tier ปรับ limit ได้ต่อ tenant (เก็บใน `tenants.rateLimitProfile`)

### 9.9 Sandbox / docs / SDK
- Sandbox = tenant mode `test` ใน cluster เดียว (key `tk_test_`), data แยก schema/row-level, webhook ส่งจริง, มี `POST /v1/test/events/trigger` ให้ยิง event จำลอง (Stripe `trigger`)
- OpenAPI 3.1 generate จาก NestJS decorators เผยแพร่ที่ `GET /v1/openapi.json` + docs site; CI diff spec ทุก PR (breaking → ต้อง bump major)
- Postman collection + TypeScript SDK (generate จาก OpenAPI) เป็น first-party; Python ลำดับถัดไป; llms.txt และ `.md` ทุกหน้า (Alvys pattern)

### 9.10 Bulk / async job
- Bulk sync: `POST /v1/orders:bulk` ≤ 200 items ตอบ 207 multi-status `{ "results": [ { "index": 0, "status": 201, "id": "ord_..." }, { "index": 1, "status": 422, "problem": {...} } ] }`
- Async: งานหนัก (import >200, invoice run, route optimize) → `POST /v1/invoice-runs` ตอบ `202 { "id": "job_...", "status": "pending", "statusUrl": "/v1/jobs/job_..." }`; `GET /v1/jobs/{id}` → `status pending|running|succeeded|failed|succeeded_with_errors, progress{total,done,failed}, result{...}, errors[]`; จบแล้วยิง webhook `job.completed` (Onfleet batch-async pattern) ; job เก็บ 7 วัน; รองรับ `Idempotency-Key` เพื่อไม่สร้าง job ซ้ำ

### 9.11 ตัวอย่าง request/response

**(1) สร้าง order + idempotency**
```http
POST /v1/orders
Authorization: Bearer eyJ...   (scope orders:write)
Idempotency-Key: 6f1c2d3e-...-9a
Content-Type: application/json

{ "externalId": "KRS-SO-2026-000123", "customerId": "cus_01J...",
  "serviceType": "ftl", "references": { "poNumber": "PO-5567" },
  "stops": [
    { "sequence": 1, "type": "pickup", "location": { "name": "คลัง A", "address": "...", "lat": 13.7, "lng": 100.5 },
      "window": { "start": "2026-11-05T01:00:00Z", "end": "2026-11-05T04:00:00Z" } },
    { "sequence": 2, "type": "delivery", "location": { ... }, "window": { ... } } ],
  "items": [ { "sku": "A-100", "quantity": 20, "weightKg": 500 } ] }
```
```http
HTTP/1.1 201 Created
ETag: "a1b2c3"
Location: /v1/orders/ord_01JC...
{ "id": "ord_01JC...", "externalId": "KRS-SO-2026-000123", "status": "created",
  "stops": [ { "id": "stp_01...", "sequence": 1, "status": "pending" }, ... ],
  "createdAt": "2026-11-03T10:00:00Z", "updatedAt": "2026-11-03T10:00:00Z" }
```
(retry ด้วย key เดิม → 201 เดิม + `Idempotent-Replayed: true`; key เดิม body ต่าง → 422 `idempotency_mismatch`)

**(2) อัปเดตสถานะ Delivery Order (stop arrive/complete + POD)**
```http
POST /v1/stops/stp_01.../complete
If-Match: "a1b2c3"
Idempotency-Key: 8c0f...

{ "completedAt": "2026-11-05T06:12:00+07:00", "outcome": "delivered",
  "pod": { "receiverName": "สมชาย", "signatureDocumentId": "doc_01...", "photoDocumentIds": ["doc_02..."] },
  "items": [ { "sku": "A-100", "deliveredQuantity": 20 } ] }
```
```http
HTTP/1.1 200 OK
ETag: "d4e5f6"
{ "id": "stp_01...", "status": "completed", "outcome": "delivered",
  "arrivedAt": "...", "completedAt": "2026-11-04T23:12:00Z",
  "order": { "id": "ord_01JC...", "status": "delivered" } }
```
Invalid transition (เช่น complete stop ที่ยัง `pending` ไม่ `arrived`) → `409`:
```json
{ "type": "https://docs.<domain>/errors/invalid-state-transition", "title": "Invalid state transition",
  "status": 409, "code": "invalid_state_transition", "detail": "stop is 'pending'; call /arrive first",
  "instance": "/v1/stops/stp_01.../complete", "requestId": "req_..." }
```

**(3) Webhook `invoice.finalized`**
```http
POST https://erp.customer.example/tms-webhook
X-TMS-Event: invoice.finalized
X-TMS-Event-Id: evt_01JD...
X-TMS-Timestamp: 1762164900
X-TMS-Signature: t=1762164900,v1=9f3c...e1
X-TMS-Attempt: 1
Content-Type: application/json

{ "id": "evt_01JD...", "type": "invoice.finalized", "version": "1",
  "occurredAt": "2026-11-03T10:15:00Z", "tenantId": "tnt_01...",
  "data": { "object": { "id": "inv_01...", "number": "INV-2026-0001", "externalId": null,
      "customerId": "cus_01...", "status": "finalized", "currency": "THB",
      "subtotal": "12500.00", "tax": "875.00", "total": "13375.00",
      "lines": [ { "orderId": "ord_01JC...", "description": "FTL กรุงเทพ→ชลบุรี", "amount": "12500.00" } ],
      "issuedAt": "2026-11-03T10:15:00Z", "dueAt": "2026-12-03T00:00:00Z" },
    "previousAttributes": { "status": "draft" } } }
```
Receiver ต้องตรวจ `v1 == HMAC_SHA256(secret, "1762164900." + rawBody)` และ `|now - t| ≤ 300s` แล้วตอบ 200 ภายใน 10s; dedupe ด้วย `id`

**(4) Upsert ด้วย external id (ERP เป็นเจ้าของเลขที่)**
```http
PUT /v1/orders/external/KRS-SO-2026-000123
If-Match: *            (optional: ยอมทับทุก version)

{ "customerId": "cus_01J...", "serviceType": "ftl", "stops": [ ... ], "items": [ ... ] }
```
→ `201 Created` ครั้งแรก / `200 OK` ครั้งถัดไป (body = order เต็ม, `externalId` คงเดิม); ถ้า order อยู่ใน `in_transit` และ body เปลี่ยน stops → `409 invalid_state_transition` พร้อม `detail` บอก field ที่แก้ไม่ได้

---

## 10. Resource ที่ต้องเปิดเป็น API ในเฟสแรก (เรียงตามความสำคัญสำหรับ ERP connector + ลูกค้า)

| # | Resource | Endpoints ขั้นต่ำ | เหตุผล (OPINION) |
|---|---|---|---|
| 1 | `orders` (shipment/DO) | POST, GET list/one, PATCH, `PUT /external/{id}`, `/cancel`, `/documents` | จุดเข้าหลักของ ERP (KRS push SO/DO) — ทุก TMS ที่ดูมี order เป็นแกน |
| 2 | `webhooks` + `events` + `webhook-deliveries` | CRUD, event-types, deliveries/retry | ERP ต้อง pull status กลับ; ไม่มี webhook = polling หนัก (บทเรียน Rose Rocket no-retry) |
| 3 | `stops` | GET (ใต้ trip/order), `/arrive`, `/depart`, `/complete`, `/fail` | milestone ที่ ERP/ลูกค้าต้องการ (ETA, POD) — Alvys/Rose Rocket/Track-POD ล้วนมี |
| 4 | `documents` / POD | upload (multipart/presigned), GET metadata, download URL หมดอายุ | ปิดงานบัญชี/เคลม; Track-POD ขาย ePOD เป็น core |
| 5 | `customers` | CRUD + `PUT /external/{id}` | ต้อง map กับ ERP master ก่อนสร้าง order |
| 6 | `invoices` (AR) + `invoice-runs` (async job) | GET list/one, `/finalize`, `/void`, `POST /invoice-runs`, `GET /jobs/{id}` | KRS integration คือเหตุผลหลัก; async + webhook `invoice.finalized` |
| 7 | `trips` | GET list/one, `/dispatch`, `/assign`, `/complete` | ลูกค้า/ERP อ่านว่ารถคันไหน-คนไหน; เขียนน้อยในเฟสแรก |
| 8 | `drivers`, `vehicles` | GET list/one, POST/PATCH, `PUT /external/{id}` | master data sync จาก HR/fleet system |
| 9 | `carriers` (subcontract) + `carrier-bills` (AP) | GET, POST, `PUT /external/{id}` | ERP ฝั่ง AP; Alvys/Rose Rocket มี settlement/bills |
| 10 | `locations` (address book) | GET, POST (upsert by externalId/geo) | ลดการส่ง address ซ้ำใน order (Track-POD `/Address` upsert) |
| 11 | `tracking` (public link / events ของ order) | `GET /orders/{id}/tracking`, `GET /orders/{id}/events` | ลูกค้าปลายทาง; audit trail (Rose Rocket audit history) |
| 12 | `jobs`, `api-keys`, `event-types`, `openapi.json` | GET | platform plumbing ที่ทุก connector ต้องการ |

เฟสถัดไป (ไม่ใช่เฟสแรก): tenders/rate quotes, route optimization, fuel/toll, maintenance, custom fields, visibility/telemetry

---

## 11. Checklist ส่งต่อ dev (สรุปจาก benchmark)
1. ทำ `Idempotency-Key` middleware (NestJS interceptor + Redis/Postgres table `idempotency_keys(tenant_id, key, request_hash, response, expires_at)`) ก่อนเปิด POST ใด ๆ
2. ทุก entity มี `external_id` unique index `(tenant_id, external_id)` + route `/external/{externalId}` + รับ `ext:` prefix ใน `{id}` params
3. Problem+json exception filter เดียว + error code enum ใน repo + docs page auto-gen
4. Outbox table → webhook dispatcher (HMAC `t=,v1=`, retry schedule, deliveries log, redeliver API) ตั้งแต่ sprint แรก; UI ของเราก็ subscribe ได้
5. Cursor pagination helper (keyset `updatedAt,id`) ใช้ทุก list; ห้าม offset
6. Prisma row-level tenant scoping จาก JWT claim; 404 แทน 403 เมื่อ cross-tenant
7. Rate limit guard ต่อ tenant/key + `RateLimit-*` headers
8. Test tenant mode + `tk_test_` key + `/test/events/trigger`
9. Swagger decorators ครบ → `openapi.json` → CI breaking-change check → TS SDK gen
