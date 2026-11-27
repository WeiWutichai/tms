// คำแปล EN/中文 ของ key ที่ไม่มีในพจนานุกรมต้นแบบ (design/prototype/i18n.js) — ใช้โดย scripts/build-i18n.mjs
// P1-ST2-T01 landing: ข้อความที่ปรับจากต้นแบบตาม R-11 / R-02 (ต้นฉบับแปลอยู่ใน i18n.js)
export const EXTRA = {
  'land.meta.title': {
    en: 'TMS — Dispatch, track, collect POD, bill. All in one place.',
    zh: 'TMS — 派车、追踪、收集 POD、开票,一站完成',
  },
  'land.and': { en: 'and', zh: '及' },
  'land.or': { en: 'or', zh: '或' },
  'land.worksWith': { en: 'Works with {list}', zh: '可与 {list} 配合使用' },
  'land.fact.bill': {
    en: 'Issue billing notes and invoices yourself',
    zh: '自行开具对账单与发票',
  },
  'land.fact.link': {
    en: 'Subcontractors accept jobs and send POD by link',
    zh: '外协通过链接接单并提交 POD',
  },
  'land.fact.acc': {
    en: 'Connects to {n} accounting / ERP systems',
    zh: '对接 {n} 款财务 / ERP 系统',
  },
  'land.bill.d': {
    en: 'Accounting picks the customer and period, ticks DOs that are delivered with POD approved, then issues the billing note and invoice. Freight is VAT-exempt and ancillary services carry 7% VAT, per customer terms.',
    zh: '财务选择客户与账期,勾选已送达且 POD 通过的 DO,然后开具对账单与发票。按客户条款,运费免增值税,附加服务计 7% 增值税。',
  },
  'land.settle.p2': {
    en: 'Net amount to transfer, with the payment voucher issued on the spot',
    zh: '应转账净额,可立即开具付款凭证',
  },
  'land.faq.erp.a': {
    en: 'No ERP needed. TMS issues billing notes and invoices itself; tax invoices and receipts come from your accounting software. Connect {list}, or export files for your accountant.',
    zh: '无需 ERP。TMS 可自行开具对账单与发票,税务发票与收据由您的财务软件开具。可对接 {list},或导出文件给会计。',
  },
  'land.faq.erp.aNone': {
    en: 'No ERP needed. TMS issues billing notes and invoices itself; tax invoices and receipts come from your accounting software, or export files for your accountant.',
    zh: '无需 ERP。TMS 可自行开具对账单与发票,税务发票与收据由您的财务软件开具,或导出文件给会计。',
  },
  'land.faq.price.a': {
    en: 'By active vehicles per month, meaning vehicles with at least one trip. Unlimited users, no contract.',
    zh: '按当月活跃车辆计费,即至少有 1 个车次的车辆。用户不限,无合约。',
  },
  'land.priceFrom': { en: 'From ฿{price} per truck per month', zh: '每车每月 ฿{price} 起' },
};
