# เทียบ Payment Gateway ในไทยสำหรับเก็บค่า Subscription SaaS (TMS)

วันที่รวบรวม: 2026-11-03 | ผู้รวบรวม: Claude (งาน C) | สถานะ: handoff draft

## 0. วิธีอ่านรายงานนี้

- **FACT** = ดึงจากหน้าทางการ (official) หรือเอกสาร docs ที่เปิดได้จริง ณ วันรวบรวม มีลิงก์กำกับทุกจุด
- **FACT (แหล่งรอง)** = ตัวเลขจากบทความ/บล็อกภายนอก ไม่ใช่หน้าทางการ ต้องยืนยันกับผู้ให้บริการก่อนใช้ตัดสินใจ
- **OPINION** = ความเห็น/การตีความของผู้รวบรวม
- **ไม่พบข้อมูล** = ค้นหน้าทางการแล้วไม่พบ ไม่เดา
- ค่าธรรมเนียมทุกตัวในไทยโดยทั่วไปยังไม่รวม VAT 7% (Opn และ Beam ระบุชัดในหน้า pricing) ถ้าเจ้าไหนไม่ระบุให้ถือว่า "ไม่พบข้อมูล" เรื่อง VAT
- บริบทธุรกิจ: ลูกค้าเป็นนิติบุคคลไทย (บริษัทขนส่ง) จ่ายรายเดือน/รายปี หลักพัน–หลักหมื่นบาท stack NestJS

## 1. สรุปสั้น (TL;DR)

- **ตัวเลือกหลักที่แนะนำ: Opn Payments (Omise)** — ครบทั้ง card recurring (Charge Schedules API), PromptPay QR, webhook มี HMAC signature, Node SDK ทางการ, ราคาเปิดเผย (บัตร 3.65% / PromptPay 1.65%) และฐานผู้ใช้ไทยกว้าง (OPINION เหตุผลอยู่ข้อ 7)
- **สำรองอันดับ 1: Stripe (Thailand)** — ถ้าต้องการ Stripe Billing จัดการ subscription state/retry ให้ทั้งหมด แต่บัตรแพงกว่า (3.65% + ฿10) และ Billing คิดเพิ่ม 0.7% ของยอด
- **สำรองอันดับ 2: Beam** — ค่าธรรมเนียมถูกสุดที่เปิดเผย (บัตร 1.80% เริ่มต้น, PromptPay 0.25%) มี webhook HMAC และ MIT recurring แต่ไม่มี scheduler ให้ ต้องสร้าง cron เอง และไม่มี Node SDK
- **โอน + แนบสลิป**: ใช้ EasySlip หรือ SlipOK (ราคา ~0.13–0.42 บาท/สลิป) ตรวจ QR บนสลิป แล้วให้ระบบ TMS match กับ invoice เอง
- **ใบกำกับภาษี**: ไม่มี gateway เจ้าใดในลิสต์ที่ออก e-Tax Invoice ส่งกรมสรรพากรให้โดยตรง ต้องต่อผู้ให้บริการ e-Tax แยก (INET ผ่าน PEAK / FlowAccount / ทำเองผ่าน e-Tax Invoice by Time Stamp ถ้ารายได้ ≤ 30 ล้าน)

## 2. ตารางเทียบ 9 เจ้า × 10 มิติ

หมายเหตุ: ตัวเลขทั้งหมดก่อน VAT 7% เว้นแต่ระบุ

| มิติ | Opn (Omise) | 2C2P | GB Prime Pay | KBank K-Payment GW | SCB Payment GW | Stripe TH | Pay Solutions | ChillPay | Beam |
|---|---|---|---|---|---|---|---|---|---|
| 1. บัตร (fee) | **3.65%** ทุกแบรนด์ [FACT](https://www.omise.co/pricing/thailand) | ไม่เปิดเผย (quote) [FACT](https://2c2p.com/countries/thailand/) | ไม่เปิดเผย ให้โทร call center [FACT](https://www.gbprimepay.com/th/faq) | **3.25%** นิติบุคคล [FACT*](https://www.kasikornbank.com/th/business/sme/financial-services/collection-solutions/Pages/k-payment-gateway.aspx) | **3.00%** SME / 2.50% Corporate (Visa/MC/JCB) [FACT](https://www.scb.co.th/th/personal-banking/payment/for-merchant/payment-gateway.html) | **3.65% + ฿10** บัตรไทย / 4.75% + ฿10 บัตรต่างประเทศ [FACT](https://stripe.com/en-th/pricing) | 3.60% (2023) → 3% (เม.ย. 2026) [แหล่งรอง](https://boldrails.com/blog/best-payment-gateways-thailand) | **3.25%** แพ็ก Chill Pro [FACT](https://www.chillpay.co/en/payment-channel/pricing/) | **1.80%** บัตรทั่วไป / 2.75% premium / 3.25% บัตรต่างประเทศ [FACT](https://beamcheckout.com/pricing) |
| 2. PromptPay QR (fee) | **1.65%** [FACT](https://www.omise.co/pricing/thailand) | ไม่เปิดเผย | ไม่เปิดเผย | รองรับ Thai QR แต่ไม่ระบุ fee แยก [FACT*] | **5 บาท/รายการ** (ผ่าน Payment GW); ฟรีผ่าน QR API ถึง 31 ธ.ค. 2024 (ข้อมูลเก่า) [FACT](https://www.scb.co.th/th/personal-banking/payment/for-merchant/payment-gateway.html) | **1.65%** + ฿10/refund [FACT](https://stripe.com/en-th/pricing/local-payment-methods) | 1.5% (2023) → 1% (2026) [แหล่งรอง](https://sennalabs.com/blog/compare-payment-gateway) | ไม่พบข้อมูล | **ฟรี* หรือ 0.25% (min ฿1)** [FACT](https://beamcheckout.com/pricing) |
| 3. Recurring/card-on-file | **มี** Charge Schedules API (customer+card token) [FACT](https://docs.omise.co/en/schedules-api/international) | **มี** Recurring Payment Plan + cardToken [FACT](https://developer.2c2p.com/docs/direct-api-rpp-recurring-payment-plan) | ไม่พบใน FAQ/SDK ที่เปิดดูได้ | ไม่พบข้อมูล (หน้าพูดถึงแค่ผ่อนชำระ) | มี Tokenization 0.20% แต่ไม่ระบุ recurring [FACT] | **มี** Stripe Billing (subscription เต็มรูปแบบ) [FACT](https://docs.stripe.com/billing/revenue-recovery/smart-retries) | มี (ตามบทความ 2023) [แหล่งรอง](https://sennalabs.com/blog/compare-payment-gateway) | **มี** บน Chill Pro/Max [FACT](https://www.chillpay.co/en/payment-channel/pricing/) | **มี** CIT/MIT ด้วย card token / network token แต่ไม่มี scheduler [FACT](https://docs.beamcheckout.com/cit-mit/mit.md) |
| 4. Retry เมื่อตัดไม่ผ่าน | schedule ถูก **suspend 3 วันหลังตัดไม่ผ่าน** ไม่มีรายละเอียด retry ชัด [FACT](https://docs.omise.co/en/schedules-api/international) | มี `allowAccumulate`/`maxAccumulateAmount` สะสมยอดที่ตัดไม่ผ่าน; ไม่ระบุ retry schedule [FACT](https://developer.2c2p.com/docs/api-payment-token-request-parameter) | ไม่พบข้อมูล | ไม่พบข้อมูล | ไม่พบข้อมูล | **Smart Retries** แนะนำ 8 ครั้ง/2 สัปดาห์, custom ได้ 3 ครั้ง, เลือก past_due/unpaid/canceled/paused [FACT](https://docs.stripe.com/billing/revenue-recovery/smart-retries) | ไม่พบข้อมูล | ไม่พบข้อมูล | ไม่มี auto-retry; ส่ง `merchantAdviceCode` บอกว่าควร retry ไหม [FACT](https://docs.beamcheckout.com/cit-mit/mit.md) |
| 5. Webhook + signature | **HMAC-SHA256** header `Omise-Signature` + timestamp; **ไม่รับประกัน retry** [FACT](https://docs.omise.co/en/api-webhooks/international) | backendReturnUrl; payload เป็น **JWT HS256** ด้วย merchant secret [FACT](https://developer.2c2p.com/docs/json-web-tokens-jwt) | backgroundUrl มี; checksum ไม่พบใน source ที่เปิดดูได้ | ไม่พบข้อมูล | ไม่พบข้อมูล | Stripe-Signature HMAC (มาตรฐาน Stripe) | ไม่พบข้อมูล | Result URL + Background URL, "MD5 Key" [FACT](https://www.chillpay.co/en/docs/customer-docs/) | **HMAC-SHA256** header `x-beam-signature`, **retry 10 ครั้ง exponential backoff** [FACT](https://docs.beamcheckout.com/webhook/webhook) |
| 6. Docs / SDK Node | **omise-node ทางการ** 1.x active [FACT](https://www.github.com/omise/omise-node) | docs ครบ แต่ไม่พบ Node SDK ทางการ | doc.gbprimepay.com (เข้าไม่ได้ขณะรวบรวม); SDK community เท่านั้น | API portal apiportal.kasikornbank.com [แหล่งรอง](https://www.mdsoft.co.th/%E0%B8%84%E0%B8%A7%E0%B8%B2%E0%B8%A1%E0%B8%A3%E0%B8%B9%E0%B9%89/1061-register-kbank-api.html) | developer.scb.co.th [FACT](https://developer.scb.co.th) | stripe-node ทางการ | ไม่พบ | HTML template + plugin, ไม่มี SDK [FACT](https://www.chillpay.co/en/docs/customer-docs/) | OpenAPI spec + Postman, **ไม่มี SDK** [FACT](https://docs.beamcheckout.com/llms.txt) |
| 7. Sandbox | มี (test keys) | มี (เมนู Sandbox) [FACT](https://developer.2c2p.com/docs/api-payment-token-request-parameter) | ขอผ่าน info@gbprimepay.com [FACT](https://www.gbprimepay.com/th/faq) | ไม่พบข้อมูล | ไม่พบข้อมูล | มี test mode | ไม่พบข้อมูล | มี sandbox-cdnv3.chillpay.co [FACT](https://www.chillpay.co/en/docs/customer-docs/) | มี "Playground" + test data [FACT](https://docs.beamcheckout.com/playground.md) |
| 8. เวลาอนุมัติ / เงื่อนไข | "ติดต่อกลับภายใน **15 วันทำการ**" หลังเอกสารครบ [FACT](https://docs.opn.ooo/how-do-i-enable-live-account/thailand) | ไม่พบข้อมูล | ไม่ระบุเวลา; บริษัทจดทะเบียน ≥ 6 เดือน [FACT](https://www.gbprimepay.com/th/faq) | ไม่ระบุเวลา; **ธุรกิจ ≥ 3 ปี, ทุน ≥ 2 ล้าน, เงินฝากค้ำ ≥ 300,000** [FACT*] | ไม่ระบุเวลา; **ทุน ≥ 1 ล้าน, จดทะเบียน ≥ 12 เดือน** [FACT] | ไม่พบเวลา; ต้องมีที่อยู่ธุรกิจในไทย + บัญชี THB ในไทย + หนังสือรับรอง DBD [FACT](https://support.stripe.com/questions/what-information-is-required-to-open-a-stripe-account-in-thailand) | ไม่พบข้อมูล | ไม่พบข้อมูล | ไม่พบข้อมูล |
| 9. ค่ารายเดือน / setup | ไม่ระบุในหน้า pricing; ค่าโอนออก **฿20–30/ครั้ง** (หน้า pricing บอก 20, docs บอก 30) [FACT](https://docs.opn.ooo/dashboard-transfers) | ไม่พบข้อมูล | **ไม่มีค่าสมัคร**; ค่าโอน ฿20 ถ้ายอด < 50,000 [FACT](https://www.gbprimepay.com/th/faq) | ไม่ระบุ | **ค่าสนับสนุนพัฒนาระบบ 50,000 บาท/ผลิตภัณฑ์** (ไม่รวม VAT) [FACT] | **ไม่มี** setup/monthly; Billing +0.7% [FACT](https://stripe.com/en-th/pricing) | ไม่มีค่าสมัคร (2023); refund ฿300 [แหล่งรอง] | ไม่ระบุ | ไม่ระบุ; payout ฟรีถ้าเกิน threshold [FACT](https://beamcheckout.com/pricing) |
| 10. รอบโอนเงินเข้า | **วันทำการถัดไป** หลังสั่งโอน (scheduled 8AM) [FACT](https://docs.opn.ooo/dashboard-transfers) | ไม่พบข้อมูล | สรุปยอด 20:00 (บัตร) / 24:00 (QR) โอนตามวันในโปรไฟล์; ขั้นต่ำ ฿100 [FACT](https://www.gbprimepay.com/th/faq) | ไม่พบข้อมูล | วันทำการถัดไป (ระบุสำหรับเครื่องรูดบัตร) [FACT] | เลือก rolling / weekly / monthly [FACT](https://stripe.com/en-th/pricing) | ไม่พบข้อมูล | **T+1** [FACT](https://www.chillpay.co/en/) | **T+1 QR, T+3 บัตร**, รายวัน [FACT](https://beamcheckout.com/pricing) |

`FACT*` = หน้า KBank ที่เปิดได้มี URL ลงท้าย BACKUP และอ้างโปรโมชันปี 2565–2566 อาจล้าสมัย ต้องยืนยันกับ K-BIZ Contact Center

### มิติที่ 11 (เพิ่ม): รองรับออกใบกำกับภาษี / e-Tax Invoice ให้ลูกค้าปลายทาง

| เจ้า | สถานะ |
|---|---|
| ทุกเจ้าในตาราง | **ไม่พบ** ฟีเจอร์ออก e-Tax Invoice ส่งกรมสรรพากรแทน merchant ในหน้าทางการ/docs ที่เปิดดูได้ |
| Stripe | ออก **ใบกำกับภาษีค่าธรรมเนียม Stripe** ให้ merchant รายเดือน (VAT บน fee) ไม่ใช่ใบกำกับที่ merchant ออกให้ลูกค้า [FACT](https://support.stripe.com/questions/taxes-on-stripe-fees-for-thailand-based-businesses) |
| ChillPay | มี integration กับ PEAK ที่ "ออกเอกสารใบเสร็จรับเงิน/ใบกำกับภาษีให้อัตโนมัติ" เมื่อลูกค้าจ่ายผ่านเอกสาร PEAK [FACT](https://intercom.help/peak/en/articles/9673789-เชื-อมต-อ-peak-x-chillpay) |

OPINION: ใบกำกับภาษีเป็นงานฝั่ง accounting ไม่ใช่ฝั่ง gateway ควรออกแบบให้ TMS สร้าง invoice/receipt เองหรือยิง API ไปโปรแกรมบัญชี (ดูข้อ 5)

## 3. รายละเอียดต่อเจ้า (สิ่งที่ตารางใส่ไม่พอ)

### 3.1 Opn Payments (Omise)
- FACT: บัตร 3.65% ทุกแบรนด์, PromptPay 1.65%, mobile banking/direct debit ฿10, ทั้งหมด + VAT 7% — [pricing](https://www.omise.co/pricing/thailand)
- FACT: PromptPay QR ขั้นต่ำ ฿20 สูงสุด ฿150,000 ต่อรายการ, QR หมดอายุ default 24 ชม. ปรับได้ด้วย `expires_at`, webhook `charge.complete` — [docs](https://docs.opn.ooo/promptpay)
- FACT: Schedule API: `every` + `period` (day/week/month) + `on.days_of_month`; **ไม่รองรับวันที่ 29/30/31 สำหรับรายเดือน**; status มี active/expiring/expired/deleted/paused/suspended; "Schedules are suspended three (3) days after the charge is unsuccessful" — [docs](https://docs.omise.co/en/schedules-api/international), [FAQ](https://docs.opn.ooo/how-to-do-recurring-payments)
- FACT (ความเสี่ยงสำคัญ): Charge Schedules API — "Use of this API is disabled for 3DS-enabled accounts" — [docs](https://docs.omise.co/charge-schedules-api) → ต้องถาม Opn ตอนสมัครว่าบัญชีเราเปิด 3DS ไหมและจะใช้ schedule ได้ไหม
- FACT: webhook ลงนาม HMAC-SHA256 (`Omise-Signature`, `Omise-Signature-Timestamp`), แนะนำ re-fetch ด้วย ID เป็น fallback, "Omise does not currently guarantee automatic retries for failed deliveries" — [docs](https://docs.omise.co/en/api-webhooks/international)
- FACT: เอกสารนิติบุคคล: หนังสือรับรอง DBD, บอจ.3, บอจ.5, บัตร ปชช. ผู้ถือหุ้น >25% และกรรมการ, ภ.พ.20 (optional), หน้าสมุดบัญชี; ไม่รับ e-signature; "we will be in touch within 15 business days" — [docs](https://docs.opn.ooo/how-do-i-enable-live-account/thailand)
- FACT: ค่าโอนออก ฿30 (≤ 2 ล้าน) / ฿150 (> 2 ล้าน) ตาม docs ขณะที่หน้า pricing บอก ฿20 — ตัวเลขขัดกัน ให้ยืนยัน — [docs](https://docs.opn.ooo/dashboard-transfers)

### 3.2 2C2P
- FACT: หน้า Thailand ไม่มีราคา; รับบัตรทุกแบรนด์หลัก, PromptPay ระบุใน metadata — [page](https://2c2p.com/countries/thailand/)
- FACT: Recurring Payment Plan: ตั้ง `recurring=true`, `invoicePrefix`, `recurringAmount`, `recurringInterval` (วัน) หรือ `chargeOnDate` (ddMM), `recurringCount` (0 = จนกว่าจะยกเลิก), `allowAccumulate`/`maxAccumulateAmount`; ได้ `cardToken` + `recurringUniqueID` กลับมา; ผลแจ้งทาง `backendReturnUrl` — [docs](https://developer.2c2p.com/docs/direct-api-rpp-recurring-payment-plan), [params](https://developer.2c2p.com/docs/api-payment-token-request-parameter)
- FACT: request/response เป็น JWT ลงนาม HMAC-SHA256 (HS256) ด้วย merchant secret key — [docs](https://developer.2c2p.com/docs/json-web-tokens-jwt)
- FACT (แหล่งรอง, เก่า): บทความ Chargebee อ้าง 2C2P "3.75% to 4.20% depending on the card" — [chargebee blog](https://chargebee.com/blog/payment-gateway-options-thailand); บทความ 2022 อ้าง THB 0.45 + VAT ต่อรายการบัตร (น่าจะเป็นค่า gateway ไม่ใช่ MDR) — [inai](https://inai.io/blog/top-11-payment-gateways-in-thailand) → ตัวเลขขัดกันเองและไม่ใช่ทางการ ใช้ไม่ได้
- OPINION: 2C2P เหมาะกับ enterprise volume สูง สำหรับ SaaS หลักพัน–หมื่น/เดือนในช่วงเริ่มต้นจะไม่ได้ราคาดีและกระบวนการ quote ช้า

### 3.3 GB Prime Pay
- FACT: FAQ ทางการ: ไม่มีค่าสมัคร, คิดเฉพาะค่าธรรมเนียมจากยอดขาย, ค่าธรรมเนียมให้ติดต่อ call center; ค่าโอน ฿20 ถ้ายอดโอน < 50,000; ขั้นต่ำโอน ฿100; บริษัทต้องจดทะเบียน ≥ 6 เดือน; sandbox ขอทางอีเมล — [FAQ](https://www.gbprimepay.com/th/faq)
- FACT: หน้าแรก gbprimepay.com และ doc.gbprimepay.com เปิดไม่ได้ขณะรวบรวม (client_error)
- FACT (แหล่งรอง, **ไม่ได้ยืนยัน**): บทความหนึ่งเรียก "Xendit (formerly GB Prime Pay)" และอ้าง local cards 3.20% + ฿10, PromptPay 0.80% — [outsourcify](https://outsourcify.net/guides/thailands-online-payment-gateways/); หน้า Xendit เองระบุไทย: บัตร local 3.5%, mobile banking ฿15 flat — [Xendit help](https://help.xendit.co/hc/en-us/articles/360039086452-What-are-the-pricing-for-Xendit-products); ค้นไม่พบประกาศทางการเรื่องการควบรวม → ถือว่า **ไม่พบข้อมูล**
- SDK community (PHP) มี QR Cash + backgroundUrl แต่ไม่พบ recurring/checksum — [packagist](https://packagist.org/packages/sunsunza2009/gbprimepay)

### 3.4 KBank K-Payment Gateway
- FACT*: นิติบุคคล 3.25%, รัฐ 3–5%, เงินฝากค้ำประกันขั้นต่ำ 300,000 บาทหรือ 1% ของยอดขาย/เดือน, ประกอบธุรกิจ ≥ 3 ปี, ทุนจดทะเบียน ≥ 2 ล้าน, รับ Thai QR/Alipay/WeChat — [KBank](https://www.kasikornbank.com/th/business/sme/financial-services/collection-solutions/Pages/k-payment-gateway.aspx)
- FACT: KBank Open API portal สมัครออนไลน์ได้ที่ apiportal.kasikornbank.com (ขั้นตอนตามบทความแหล่งรอง) — [mdsoft](https://www.mdsoft.co.th/%E0%B8%84%E0%B8%A7%E0%B8%B2%E0%B8%A1%E0%B8%A3%E0%B8%B9%E0%B9%89/1061-register-kbank-api.html)
- FACT: "Verified Slip" ของ KBank เป็นฟีเจอร์ใน K PLUS สำหรับผู้บริโภค ไม่พบ API สำหรับธุรกิจในหน้านั้น — [KBank](https://www.kasikornbank.com/en/personal/digital-banking/kplus/functions/verified-slip/Pages/index.html)
- OPINION: เงื่อนไข 3 ปี + ทุน 2 ล้าน + เงินค้ำ 300k ตัดสตาร์ทอัพออกเกือบหมด ไม่เหมาะเป็น gateway หลักช่วงเริ่ม

### 3.5 SCB Payment Gateway / SCB Developer
- FACT: SME บัตร 3.00% (Corporate 2.50%), Thai QR 5 บาท/รายการ, Tokenization 0.20%, **ค่าสนับสนุนพัฒนาระบบ 50,000 บาท/ผลิตภัณฑ์**, ทุน ≥ 1 ล้าน, จดทะเบียน ≥ 12 เดือน, ต้องมีบัญชี SCB, บัญชีไม่มีรายการ 6 เดือนอาจถูกปิด — [SCB](https://www.scb.co.th/th/personal-banking/payment/for-merchant/payment-gateway.html)
- FACT: SCB Developer Portal มี API: QR Code Payment, Mae Manee QR, Payment Link, Direct Debit, **Slip Verification**; ไม่ระบุค่าธรรมเนียม/sandbox ในหน้าแรก — [developer.scb.co.th](https://developer.scb.co.th)
- OPINION: ค่า setup 50,000 ทำให้ไม่คุ้มสำหรับ SaaS ช่วงต้น แต่ Thai QR 5 บาท/รายการ ถูกมากถ้า ticket หลักหมื่น (เทียบ 1.65% ของ 10,000 = 165 บาท)

### 3.6 Stripe (Thailand)
- FACT: เปิดบริการไทยทางการ 26 ต.ค. 2022; รองรับ Billing, Checkout, Invoicing, Connect — [newsroom](https://stripe.com/en-in/newsroom/news/thailand)
- FACT: ราคาไทย: บัตรไทย 3.65% + ฿10, บัตรต่างประเทศ 4.75% + ฿10, แปลงสกุล +2%, PromptPay 1.65% (+฿10/refund), Billing 0.7%, Invoicing Starter 0.4%, ไม่มี setup/monthly — [pricing](https://stripe.com/en-th/pricing), [local methods](https://stripe.com/en-th/pricing/local-payment-methods)
- FACT: **ใช้กับนิติบุคคลไทยได้โดยตรง ไม่ต้องมี entity ต่างประเทศ** — ต้องมี "A business address in Thailand", "A Thai-based bank account that's THB denominated", ชื่อตรงกับหนังสือรับรองนิติบุคคล DBD; รองรับ บริษัท/หจก./กิจการเจ้าของคนเดียว/บุคคล — [support](https://support.stripe.com/questions/what-information-is-required-to-open-a-stripe-account-in-thailand)
- FACT: รับเงินได้เฉพาะ THB; PromptPay และบัตรเดบิตไทยรับได้เฉพาะ THB — [support](https://support.stripe.com/questions/supported-payment-methods-currencies-and-businesses-for-stripe-accounts-in-thailand?locale=en-GB)
- FACT: VAT บน Stripe fee ทุกรายการ ออกใบกำกับรายเดือน — [support](https://support.stripe.com/questions/taxes-on-stripe-fees-for-thailand-based-businesses)
- FACT: Smart Retries default แนะนำ 8 ครั้งใน 2 สัปดาห์; หลังหมด retry เลือกได้ cancel / unpaid / past_due / paused; webhook `invoice.payment_failed` มี `attempt_count` และ `next_payment_attempt` — [docs](https://docs.stripe.com/billing/revenue-recovery/smart-retries)
- FACT: บัญชีไทย "might have limited support for most plugins" — [support](https://support.stripe.com/questions/stripe-thailand-support-for-marketplaces)
- ไม่พบข้อมูล: เวลาอนุมัติบัญชี; รายชื่ออุตสาหกรรมที่ต้องขอ license เพิ่ม (หน้า support บอกแค่ "may require additional licenses")

### 3.7 Pay Solutions
- FACT: โดเมน paysolutions.asia redirect ไป payso.co ซึ่งเปิดไม่ได้จาก session นี้ → ราคาทางการ **ไม่พบข้อมูล**
- FACT (แหล่งรอง): 2023: บัตร 3.60% (AmEx 4.75%), QR PromptPay 1.5%, e-wallet 2.60%, ไม่มีค่าสมัคร/รายปี, refund ฿300 ถ้าเกิน 7 วัน, มี recurring — [sennalabs](https://sennalabs.com/blog/compare-payment-gateway); เม.ย. 2026: บัตร 3%, PromptPay 1%, wallet 2% — [boldrails](https://boldrails.com/blog/best-payment-gateways-thailand)
- OPINION: ถ้าราคา 2026 จริง ถูกกว่า Opn ชัดเจน แต่ docs/SDK/webhook signature ไม่พบจากแหล่งเปิด ต้องขอ docs มาดูก่อน

### 3.8 ChillPay (PraIn FinTech)
- FACT: แพ็ก Chill Pro "Transaction Fee 3.25%", Chill Max (TPV ≥ 10 ล้าน/เดือน) ราคาพิเศษ, Settlement T+1, Recurring บน Pro/Max — [pricing](https://www.chillpay.co/en/payment-channel/pricing/)
- FACT: ได้ license จาก ธปท., 40+ ช่องทาง รวม QR PromptPay, sandbox ฟรี, integration ผ่าน HTML template/WooCommerce plugin, "MD5 Key" สำหรับ checksum, Result URL + Background URL — [home](https://www.chillpay.co/en/), [docs](https://www.chillpay.co/en/docs/customer-docs/)
- ไม่พบข้อมูล: fee PromptPay แยก, วิธีคำนวณ checksum, API recurring แบบ programmatic
- OPINION: MD5 checksum เป็นแนวทางเก่ากว่า HMAC-SHA256 ของ Opn/Beam/Stripe; จุดแข็งคือ PEAK integration ออกใบเสร็จ/ใบกำกับอัตโนมัติ

### 3.9 Beam
- FACT: บัตรทั่วไป 1.80%, premium 2.75%, ต่างประเทศ 3.25%, AmEx 3.50%, QR PromptPay ฟรี* (Qualified Small Business) หรือ 0.25% min ฿1, payout รายวัน T+1 QR / T+3 บัตร, ราคาไม่รวมภาษี — [pricing](https://beamcheckout.com/pricing)
- FACT: payment methods รวม `CARD`, `CARD_TOKEN`, `CARD_NETWORK_TOKEN`, `QR_PROMPT_PAY`, mobile banking apps; charge status PENDING/SUCCEEDED/FAILED, FAILED ไม่ retry ต้องสร้างใหม่, PENDING ค้างได้ไม่จำกัดต้องตั้ง timeout เอง — [docs](https://docs.beamcheckout.com/charges/charges.md)
- FACT: MIT: POST /api/v1/charges ด้วย `CARD_TOKEN`/`CARD_NETWORK_TOKEN`, `initiatorType: MERCHANT`, แนบ `networkTransactionId` จาก CIT แรก; decline ส่ง `merchantAdviceCode` — [docs](https://docs.beamcheckout.com/cit-mit/mit.md)
- FACT: webhook HMAC-SHA256 `x-beam-signature`, event ใน `x-beam-event`, retry 10 ครั้ง exponential backoff; events: `charge.succeeded`, `payment_link.paid`, `card_authorization.*` — [docs](https://docs.beamcheckout.com/webhook/webhook)
- FACT: มี **QR Slip Verification API** — อ่าน QR บนสลิป match กับ charge ที่ PENDING แล้วเปลี่ยนเป็น SUCCEEDED; ต้องขอเปิด API แยก (ไม่งั้น 403) — [docs](https://docs.beamcheckout.com/qr-slip-verification/qr-slip-verification.md)
- ไม่พบข้อมูล: เวลาอนุมัติ, เอกสารสมัคร, Node SDK (มีแต่ OpenAPI + Postman)
- OPINION: ราคาถูกสุดและ API ทันสมัยสุดในลิสต์ แต่ยังใหม่ ความเสี่ยงคือ scheduler/dunning ต้องเขียนเอง และไม่มี event `charge.failed` ใน list webhook (ต้อง poll)

## 4. บริการตรวจสลิปอัตโนมัติ

| บริการ | ราคา | วิธีต่อ | ความแม่น | แหล่ง |
|---|---|---|---|---|
| **EasySlip** | แพ็กรายเดือน 30 วัน: Start ฿99/250 ครั้ง (~0.40/สลิป), Basic ฿350/1,000 (0.35), Starter ฿700/2,500 (0.28), Gold ฿3,500/17,500 (0.20), Diamond ฿5,000/35,000 (~0.14) … Premium-3 ฿40,000/320,000 (0.125) | REST: verify by QR payload (GET), image multipart (POST), base64, URL; Bearer token จาก developer.easyslip.com; มี `checkDuplicate`; รองรับ TrueMoney wallet slip | "ใช้ได้ทุกธนาคาร", "Recheck ข้อมูลผ่านธนาคารแห่งประเทศไทย"; **ไม่มีตัวเลข % แม่น** | [FACT pricing](https://easyslip.com/api-products/), [FACT API](https://github.com/EASYSLIP-CO-LTD/n8n-nodes-easyslip) |
| **SlipOK** | OK Start ฿210/เดือน 500 สลิป (0.42), OK SME ฿360/1,000 (0.36), เกินโควตา 0.42/สลิป | REST `api.slipok.com`, header `x-authorization`, มี quota endpoint; โควตาหักเฉพาะสลิปที่ valid; มี LINE OA bot, WordPress plugin | อ้าง "ภายใน 1 วินาที", ตรวจพบสลิปปลอม 8,600+ ใบ/ปี (คำกล่าวอ้าง) **ไม่มี %** | [FACT API](https://slipok.com/api-documentation/check-slip-quota/), [แหล่งรอง ราคา](https://thunder.in.th/blog/cheapest-slip-verification-api/) (หน้าแรก slipok.com เปิดไม่ได้), [แหล่งรอง](https://marketeeronline.co/archives/342421) |
| **Slip2Go** | **ไม่พบข้อมูล** ราคาทางการ (พบแค่ว่าใช้ผ่าน BigSeller หัก BigCoin ต่อครั้ง) | ไม่พบ docs สาธารณะ | ไม่พบ | [แหล่งรอง](https://help.bigseller.pro/en_US/detailPage/3/1/9328/content) |
| Thunder Solution (เจอระหว่างค้น) | Free 150 สลิป, ฿99/400, ฿199/1,000, ฿349/2,500 (30 วัน) | API + LINE OA | ไม่พบ % | [แหล่งรอง-ผู้ขายเอง](https://thunder.in.th/blog/cheapest-slip-verification-api/) |
| RDCW Slip Verify | ไม่พบราคา (หน้า pricing ไม่ได้เปิด) | POST `suba.rdcw.co.th/v2/inquiry` Basic auth clientId:clientSecret, รับ payload/image | ไม่พบ | [FACT docs](https://slip.rdcw.co.th/docs) |
| ธนาคาร | **SCB**: มี "Slip Verification" ใน developer portal (ไม่ระบุค่า/วิธีสมัคร) [FACT](https://developer.scb.co.th); **KBank**: Verified Slip เป็นฟีเจอร์ K PLUS ผู้บริโภค ไม่พบ API ธุรกิจ [FACT](https://www.kasikornbank.com/en/personal/digital-banking/kplus/functions/verified-slip/Pages/index.html); **Beam** มี QR slip verification ผูกกับ charge ของตัวเอง | | | |

OPINION: ทุกบริการ third-party ทำงานหลักการเดียวกันคืออ่าน Mini-QR (EMVCo) บนสลิปแล้วยิงไปตรวจกับ Bank Open API ดังนั้น "ความแม่น" ขึ้นกับว่าอ่าน QR ได้ไหม (ภาพชัด/ไม่ถูกครอป) มากกว่า AI; ควรให้ลูกค้าอัปโหลดภาพต้นฉบับ ไม่ใช่ screenshot ที่ถูกครอป และระบบต้องตรวจเองเพิ่ม 3 อย่าง: จำนวนเงินตรง invoice, บัญชีผู้รับเป็นของเรา, transRef ไม่ซ้ำ

## 5. Subscription Billing SaaS ใช้ในไทยได้ไหม

| บริการ | สถานะ | แหล่ง |
|---|---|---|
| **Stripe Billing** | ใช้ได้กับบัญชี Stripe ไทย (+0.7% ของยอด Billing) มี subscription object, Smart Retries, hosted invoice; PromptPay บน subscription เป็น one-time เท่านั้น (ไม่ auto-renew) | [FACT](https://stripe.com/en-th/pricing) |
| **Chargebee** | ลิสต์ gateway ที่รองรับ **ไม่มี** Opn/2C2P/GB Prime Pay; "you would need to integrate with a payment gateway that is supported in the country where you are incorporated"; PromptPay ผ่าน Stripe อยู่ใน Private Beta, THB เท่านั้น, one-time only | [FACT](https://www.chargebee.com/docs/payments/2.0/kb/billing/what-gateways-does-chargebee-support), [FACT](https://www.chargebee.com/docs/payments/2.0/payment-gateways-and-configuration/stripe-promptpay) |
| **Recurly** | หน้า gateways ไม่ระบุไทย/THB/Omise/2C2P → **ไม่พบข้อมูล** | [FACT](https://www-prod.recurly.com/gateways/) |
| **Paddle** (Merchant of Record) | "works with software businesses anywhere in the world with the exception of the unsupported countries" — ไทยไม่อยู่ในลิสต์ที่ไม่รองรับ แต่ Paddle เป็น MoR = Paddle เป็นผู้ขายให้ลูกค้า ไม่ใช่เรา | [FACT](https://www.paddle.com/help/start/account-verification/which-countries-are-supported-by-paddle) |

OPINION: Paddle ไม่เหมาะกับ B2B ไทย เพราะลูกค้านิติบุคคลต้องการใบกำกับภาษีไทยจากผู้ขายไทยเพื่อเคลม VAT ซื้อ แต่ MoR จะออก invoice ในนาม Paddle (ต่างประเทศ) ไม่มี VAT ไทยให้เคลม; Chargebee ใช้ได้เฉพาะคู่กับ Stripe TH ซึ่งเท่ากับจ่ายค่า Chargebee ซ้อน Stripe Billing

### ใบกำกับภาษี / e-Tax Invoice
- FACT: กรมสรรพากรมี 2 ระบบ: e-Tax Invoice & e-Receipt (ธุรกิจปริมาณมาก) และ e-Tax Invoice by Time Stamp (รายได้ ≤ 30 ล้านบาท/ปี) — [infoquest 17 ม.ค. 2025](https://www.infoquest.co.th/?p=462192)
- FACT: ผ่านโปรแกรมบัญชี PEAK ต่อ INET (service provider ที่กรมสรรพากรรับรอง) ได้ตั้งแต่แพ็ก Pro Plus; PEAK ไม่คิดเพิ่ม แต่จ่าย INET ตามจำนวนรายการจริง; ใช้ได้ทีละ 1 วิธีส่ง — [PEAK](https://intercom.help/peak/en/articles/6009284-เชื-อมต-อ-e-tax-invoice-และ-e-receipt-ผ-านผู-ให-บริการ-inet)
- ไม่พบข้อมูล: ราคาต่อเอกสารของ INET และ Leceipt (หน้า SCB e-Tax เปิดไม่ได้)
- OPINION: Phase 1 ให้ TMS สร้าง PDF ใบเสร็จ/ใบกำกับภาษี (เลขที่รันต่อเนื่อง, เลขผู้เสียภาษี 13 หลัก + สาขาของลูกค้า, VAT 7%) แล้วส่งอีเมล; Phase 2 ยิง API ไป PEAK/FlowAccount เพื่อลงบัญชี + ส่ง e-Tax ผ่าน INET ตอนปริมาณมากขึ้น

## 6. Flow แนะนำ 3 ช่องทาง + state ของ subscription

### 6.1 State machine (ใช้ร่วมทุกช่องทาง)

```
trial ──(ครบ trial / กด subscribe)──▶ pending_payment ──(ชำระสำเร็จ)──▶ active
active ──(ถึง billing date, ตัดสำเร็จ)──▶ active (ต่ออายุ)
active ──(ตัดไม่ผ่าน / QR/สลิปไม่มาภายใน due+grace)──▶ past_due
past_due ──(ชำระสำเร็จภายใน grace 7 วัน)──▶ active
past_due ──(ครบ grace)──▶ suspended   (ล็อก write, อ่านอย่างเดียว, ข้อมูลไม่ลบ)
suspended ──(ชำระสำเร็จ)──▶ active
suspended ──(ครบ 60 วัน)──▶ canceled  (แจ้งล่วงหน้า, export ข้อมูลให้)
ทุก state ──(ลูกค้าขอยกเลิก)──▶ canceled เมื่อสิ้นรอบที่จ่ายแล้ว
```
OPINION: grace 7 วัน + suspended 60 วัน เป็นค่าเริ่มที่เหมาะกับ B2B ไทยซึ่งมักจ่ายช้าเพราะรอบอนุมัติภายใน ปรับได้ภายหลัง ควรเก็บเป็น config ไม่ hardcode

### 6.2 ช่องทาง A: บัตรเครดิต recurring (Opn)
1. Checkout: ใช้ Omise.js สร้าง card token ฝั่ง browser (PCI ไม่แตะ PAN) → ส่ง token ไป NestJS
2. NestJS สร้าง `customer` + attach card → เก็บ `customer_id` ไว้กับ account ของลูกค้า
3. ตัดงวดแรกทันทีด้วย `charges` (3DS ถ้าบัญชีเปิด) → เมื่อ `charge.complete` ผ่าน webhook → `active` + ออกใบเสร็จ/ใบกำกับ
4. งวดถัดไป เลือก 1 ใน 2:
   - **4a (ง่าย)** ใช้ Opn `schedules` รายเดือน `on.days_of_month` — **ห้ามใช้วันที่ 29–31** และต้องยืนยันว่าบัญชีไม่ติดข้อจำกัด 3DS; ฟัง `schedule.suspend` → `past_due`
   - **4b (ควบคุมเอง, แนะนำ)** cron ใน NestJS (BullMQ) ยิง `charges` ด้วย `customer_id` ทุก billing date; ถ้า fail → retry วันที่ +1, +3, +5 (รวม 3 ครั้ง, ยืม pattern Stripe) → ครบแล้ว `past_due` + ส่งอีเมลให้เปลี่ยนบัตร/จ่าย QR แทน
5. Webhook handler: verify `Omise-Signature` HMAC ก่อนเสมอ, idempotent ด้วย event id, และ **re-fetch charge ด้วย ID** เพราะ Opn ไม่รับประกัน retry → เพิ่ม cron poll `charges` ที่ยัง pending ทุก 15 นาทีเป็น fallback

### 6.3 ช่องทาง B: PromptPay QR (Opn หรือ Beam)
1. ถึง billing date − 7 วัน: สร้าง invoice ใน TMS สถานะ `open` + สร้าง charge PromptPay (Opn: `source.type=promptpay`, ตั้ง `expires_at` ≤ 24 ชม.; ถ้า QR หมดอายุให้สร้างใหม่ตอนลูกค้าเปิดหน้าจ่าย) → ส่งอีเมล/LINE พร้อมลิงก์หน้าจ่ายที่ render QR
2. ลูกค้าสแกนจ่าย → webhook `charge.complete` → verify signature → match `charge.metadata.invoice_id` → invoice `paid` → subscription `active`
3. ไม่จ่ายภายใน due → `past_due` (grace 7 วัน) → เตือนวันที่ 1, 3, 6 → ครบ → `suspended`
4. ข้อจำกัด: Opn PromptPay สูงสุด ฿150,000/รายการ (พอสำหรับรายปีหลักหมื่น); ไม่มี auto-renew ลูกค้าต้องสแกนทุกงวด → เสนอส่วนลดให้ย้ายไปบัตรหรือจ่ายรายปี (OPINION)

### 6.4 ช่องทาง C: โอนเงิน + แนบสลิป (บัญชีบริษัท + EasySlip/SlipOK)
1. ใบแจ้งหนี้แสดงเลขบัญชีบริษัท + **ยอดเงินมีเศษสตางค์เฉพาะ invoice** (เช่น 5,000.37) เพื่อช่วย match (OPINION)
2. ลูกค้าอัปโหลดภาพสลิปในหน้า invoice → NestJS ส่งภาพไป EasySlip `verify by image` (หรืออ่าน QR เองด้วย `jsQR` แล้วส่ง payload ซึ่งถูกกว่า/เร็วกว่า)
3. ตรวจ 4 ข้อก่อน mark paid: (a) API ตอบ valid, (b) บัญชีผู้รับ = บัญชีบริษัทเรา, (c) จำนวนเงิน = invoice (± 0), (d) `transRef` ไม่เคยถูกใช้ (unique index ใน DB) → ผ่านทั้งหมด → `paid` + `active` อัตโนมัติ
4. ถ้าข้อใดไม่ผ่าน → สถานะ `review` ให้แอดมินตรวจมือใน back office (อย่า reject อัตโนมัติ เพราะ QR อ่านไม่ออกบ่อย)
5. Reconcile รายวันกับ statement ธนาคาร (ดึงจาก KBank/SCB Open API ถ้าสมัครได้ หรือ import CSV) เพื่อจับเคสลูกค้าโอนแต่ไม่แนบสลิป

## 7. คำแนะนำ: ตัวเลือกหลัก + สำรอง

### ตัวเลือกหลัก: Opn Payments (Omise) — OPINION
เหตุผล
- ครบ 3 ช่องทางที่ต้องการในเจ้าเดียว (card-on-file, PromptPay, และโอนธรรมดาเราทำเองอยู่แล้ว) ราคาเปิดเผย ไม่ต้อง quote
- Node SDK ทางการ + docs ภาษาอังกฤษละเอียด + webhook HMAC → เขียน NestJS module ได้ภายในวันเดียว
- ไม่มีค่า setup/รายเดือน และเงื่อนไขสมัครไม่กีดกันบริษัทใหม่ (เทียบ KBank 3 ปี/2 ล้าน, SCB 50,000 บาท)
- เป็น gateway ที่ร้านค้าไทยคุ้น ลูกค้าบริษัทขนส่งเห็นหน้า checkout แล้วไม่ตะขิดตะขวง
ความเสี่ยง
- Schedules API ปิดสำหรับบัญชี 3DS → ต้องถามก่อนเซ็น หรือใช้ cron ของเราเอง (flow 4b) ตั้งแต่แรก
- Webhook ไม่รับประกัน retry → ต้องมี poll fallback (ออกแบบไว้แล้วใน 6.2 ข้อ 5)
- 3.65% แพงกว่า Beam เท่าตัว: ที่ MRR 300,000 บาท/เดือน ถ้า 50% จ่ายบัตร ต่างกัน ≈ (3.65−1.80)% × 150,000 ≈ 2,775 บาท/เดือน — ยอมจ่ายเพื่อความเสถียรช่วงแรก แล้ว renegotiate เมื่อ volume ถึง (OPINION)
- ตัวเลขค่าโอนออก 20 vs 30 บาทขัดกันเองในเอกสาร Opn → ถามให้ชัด

### สำรอง 1: Stripe (Thailand) — OPINION
- ใช้เมื่อต้องการให้ Stripe Billing จัดการ state/dunning/invoice PDF ทั้งหมด ลดโค้ดฝั่งเรา
- ต้นทุน: 3.65% + ฿10 + 0.7% Billing ≈ แพงกว่า Opn ราว 0.7–0.9% ของยอด; PromptPay บน subscription ไม่ auto-renew
- เสี่ยง: plugin/ฟีเจอร์บางตัวจำกัดสำหรับบัญชีไทย, อาจถูกขอ license เพิ่มตามอุตสาหกรรม (ไม่พบลิสต์)

### สำรอง 2: Beam — OPINION
- ใช้เมื่อค่าธรรมเนียมเป็นตัวตัดสิน (บัตร 1.80%, PromptPay 0.25%) และทีมพร้อมเขียน scheduler/dunning เอง
- ข้อดีเพิ่ม: QR slip verification API ในตัว, webhook retry 10 ครั้ง, T+1
- เสี่ยง: ไม่มี Node SDK (ใช้ OpenAPI codegen ได้), ไม่พบข้อมูลเวลาอนุมัติ/เอกสาร, ยังใหม่ในตลาด

### แนวทาง hybrid ที่น่าพิจารณา (OPINION)
- เริ่ม Opn เป็น gateway หลัก + EasySlip สำหรับสลิป; ออกแบบ `PaymentProvider` interface ใน NestJS (createCharge / chargeSavedCard / createQr / verifyWebhook) ให้สลับไป Beam ได้ภายหลังโดยไม่แตะ subscription state machine

## 8. Checklist สมัครและเตรียมระบบ

### เอกสารนิติบุคคล (ใช้ร่วมเกือบทุกเจ้า)
- [ ] หนังสือรับรองบริษัท DBD อายุไม่เกิน 3–6 เดือน (Opn/KBank/GB/SCB/Stripe)
- [ ] บอจ.3 (ตราประทับ) และ บอจ.5 (รายชื่อผู้ถือหุ้น) — Opn ระบุชัด
- [ ] บัตรประชาชนกรรมการผู้มีอำนาจ + ผู้ถือหุ้น > 25% (Opn) — เซ็นรับรองสำเนา + ประทับตรา, **ห้าม e-signature** (Opn)
- [ ] ภ.พ.20 (ถ้าจด VAT — ควรจดเพราะลูกค้า B2B ต้องการใบกำกับ)
- [ ] หน้าสมุดบัญชีธนาคารชื่อบริษัท (ชื่อต้องตรงหนังสือรับรอง) + statement ล่าสุด
- [ ] เว็บไซต์ live ที่แสดงสินค้า/ราคา/นโยบายคืนเงิน/ช่องทางติดต่อ (Opn, SCB ระบุ)
- [ ] ทะเบียนบ้านกรรมการ (GB Prime Pay ขอ)

### Opn เฉพาะ
- [ ] สมัคร test account → ขอเปิด PromptPay + ถามว่าบัญชีจะเป็น 3DS-enabled ไหม และใช้ Schedules API ได้ไหม
- [ ] ยืนยันค่าโอนออก (20 หรือ 30 บาท) และรอบ auto-transfer
- [ ] อัปโหลดเอกสารครบแล้วนับ 15 วันทำการ

### Stripe (ถ้าเลือก)
- [ ] ที่อยู่ธุรกิจในไทย + บัญชี THB + เลขทะเบียนนิติบุคคล + ข้อมูลกรรมการ/ผู้ถือหุ้น (วันเกิด ที่อยู่ เลขบัตร)
- [ ] เปิด PromptPay ใน Dashboard, ตั้ง Smart Retries + พฤติกรรมหลัง retry หมด (past_due)

### ฝั่งระบบ TMS (NestJS)
- [ ] ตาราง `subscriptions` (state, plan, billing_day, grace_until), `invoices`, `payments`, `payment_methods` (provider customer/card id เท่านั้น ไม่เก็บ PAN)
- [ ] Webhook endpoint: raw body, verify HMAC, idempotency key = event id, คิวประมวลผลแยก
- [ ] Cron: ออก invoice ล่วงหน้า 7 วัน, ตัดบัตรวัน billing, retry +1/+3/+5, เตือน past_due, suspend, poll charge pending
- [ ] Slip upload: จำกัดไฟล์ ≤ 5MB, เก็บ original, `transRef` unique index, คิว review สำหรับแอดมิน
- [ ] สมัคร EasySlip แพ็ก Start (฿99/250) หรือ SlipOK OK Start (฿210/500) ทดสอบก่อน
- [ ] เลขที่ใบกำกับภาษีรันต่อเนื่องไม่ย้อน, เก็บเลขผู้เสียภาษี 13 หลัก + รหัสสาขาลูกค้า, VAT 7% แยกบรรทัด
- [ ] ตัดสินใจเส้นทาง e-Tax: Time Stamp (≤ 30 ล้าน) vs service provider INET ผ่าน PEAK/FlowAccount

## 9. สิ่งที่ยังค้าง / ต้องยืนยันกับผู้ให้บริการโดยตรง

1. 2C2P, GB Prime Pay, Pay Solutions: ราคาทางการทั้งหมด (ขอ rate card เป็นลายลักษณ์อักษร)
2. GB Prime Pay มีสถานะเกี่ยวกับ Xendit จริงหรือไม่ (บทความแหล่งรองอ้าง ไม่พบประกาศทางการ)
3. KBank K-Payment Gateway: หน้าที่เปิดได้เป็น BACKUP ปี 2566 — เงื่อนไข 3 ปี/2 ล้าน/300k ยังใช้อยู่ไหม
4. SCB QR API ฟรีถึง 31 ธ.ค. 2024 — ปัจจุบันคิดเท่าไร
5. Opn: Schedules API กับ 3DS, ค่าโอน 20/30, มี webhook retry ไหมในปัจจุบัน
6. Beam: เอกสารสมัคร เวลาอนุมัติ และเงื่อนไข "Qualified Small Business" สำหรับ PromptPay ฟรี
7. Slip2Go: ราคาและ docs (ไม่พบเลย)
8. INET / Leceipt: ราคาต่อเอกสาร e-Tax
9. SCB Slip Verification API: วิธีสมัครและค่าธรรมเนียม (มีชื่อใน portal แต่ไม่มีรายละเอียด)
