import { defineMasterImport, put, type MasterColumn } from '../imports/master-import';
import { CreateRateCardDto, type RateSideKey } from './rate-card.dto';
import type { RateCardsService } from './rate-cards.service';

const MODELS = {
  PER_TRIP: ['เหมาเที่ยว', 'ต่อเที่ยว'],
  PER_KM: ['ต่อกม.', 'ต่อ กม.'],
  PER_TON: ['ต่อตัน'],
  PER_CBM: ['ต่อ ลบ.ม.', 'ต่อลบ.ม.'],
  PER_UNIT: ['ต่อหน่วย'],
};
const label = (m: Record<string, string[]>) => Object.values(m).map((l) => l[0]!);

/**
 * Rate card (ST2-T13 ขาขาย / ST2-T14 ขาซื้อ) — POST /v1/rate-cards ด้วย service เดียวกับ API
 * - นำเข้าเป็น **ร่าง** เสมอ แล้วผ่านการอนุมัติตามปกติ (MD-285) · ช่วงวันทับกับ rate key เดียวกัน → 422 overlap จาก service
 * - สิทธิ์: ขาขาย `prices.sell:write` · ขาซื้อ `prices.buy:write` (spec/02 §11.2) — service ตรวจซ้ำต่อแถว
 * - อ้างเส้นทางด้วยรหัสเส้นทาง (ต้นแบบ vWiz คอลัมน์ "เส้นทาง") หรือ ต้นทาง/ปลายทาง (รหัสสถานที่)
 * - create_only: "นำเข้าทับ rate ที่ใช้งาน = ฉบับแก้ไข" (MD-285) ยังไม่รองรับ — แก้ราคาใช้ "ออกฉบับแก้ไข" ในหน้าจอ [OPEN spec/12 §3]
 * - ค่าบริการเสริมเฉพาะ rate (accessorials) ไม่อยู่ในไฟล์นี้ — เพิ่มในหน้าจอหลังนำเข้า
 */
export function rateCardImportSpec(svc: RateCardsService, side: RateSideKey) {
  const sell = side === 'SELL';
  const px = sell
    ? { rate: 'sellRate', min: 'sellMinCharge', ex: 'sellExtraStopRate' }
    : { rate: 'buyRate', min: 'buyMinCharge', ex: 'buyExtraStopRate' };
  const party: MasterColumn = sell
    ? {
        key: 'party',
        header: 'ลูกค้า',
        aliases: ['Customer', 'รหัสลูกค้า'],
        required: true,
        fields: ['customerId'],
        example: 'CUS-0101',
        hint: 'รหัสหรือชื่อลูกค้าที่ตรงตัว',
      }
    : {
        key: 'party',
        header: 'ผู้รับเหมา',
        aliases: ['Carrier', 'Vendor', 'รหัสผู้รับเหมา'],
        required: true,
        fields: ['carrierId'],
        example: 'SUB-0101',
        hint: 'รหัสหรือชื่อผู้รับเหมาที่ตรงตัว',
      };
  return defineMasterImport({
    kind: sell ? 'rate_card_sell' : 'rate_card_buy',
    label: sell ? 'Rate card ขาขาย' : 'Rate card ขาซื้อ',
    scope: sell ? 'prices.sell:write' : 'prices.buy:write',
    modes: ['create_only'],
    createDto: CreateRateCardDto,
    // ต้นแบบ vWiz: ลูกค้า · เส้นทาง · ประเภทรถ · สูตร · ราคา
    columns: [
      party,
      {
        key: 'route',
        header: 'เส้นทาง',
        aliases: ['Route', 'รหัสเส้นทาง'],
        fields: [],
        example: 'RT-0101',
        hint: 'รหัสเส้นทาง — หรือกรอก ต้นทาง/ปลายทาง แทน',
      },
      {
        key: 'vehicleType',
        header: 'ประเภทรถ',
        aliases: ['Truck', 'Vehicle type'],
        required: true,
        fields: ['vehicleTypeId'],
        example: '6W',
        hint: 'รหัสหรือชื่อประเภทรถ (ตรงตัว — MD-111)',
      },
      {
        key: 'pricingModel',
        header: 'สูตร',
        aliases: ['Formula', 'Pricing model'],
        required: true,
        example: 'เหมาเที่ยว',
        options: label(MODELS),
      },
      {
        key: 'rate',
        header: 'ราคา',
        aliases: ['Price', 'Rate'],
        required: true,
        fields: [px.rate],
        example: sell ? '6700.00' : '5200.00',
        hint: 'บาท ก่อน VAT ต่อหน่วยของสูตร',
      },
      {
        key: 'validFrom',
        header: 'มีผลตั้งแต่',
        aliases: ['Valid from', 'วันเริ่ม'],
        required: true,
        example: '01/01/2570',
      },
      {
        key: 'validTo',
        header: 'ถึง',
        aliases: ['Valid to', 'วันสิ้นสุด'],
        example: '31/12/2570',
        hint: 'ว่าง = ไม่มีวันหมด',
      },
      {
        key: 'origin',
        header: 'ต้นทาง',
        aliases: ['Origin', 'From'],
        fields: ['originId'],
        example: '',
        hint: 'รหัสหรือชื่อสถานที่ (เมื่อไม่ใช้รหัสเส้นทาง)',
      },
      {
        key: 'destination',
        header: 'ปลายทาง',
        aliases: ['Destination', 'To'],
        fields: ['destinationId'],
        example: '',
      },
      { key: 'minCharge', header: 'ขั้นต่ำ', aliases: ['Min charge'], fields: [px.min] },
      {
        key: 'extraStopRate',
        header: 'ค่าจุดเพิ่ม',
        aliases: ['Extra stop'],
        fields: [px.ex],
        hint: 'ต่อจุดเมื่อเกินจำนวนจุดที่รวมในราคา',
      },
      {
        key: 'includedStops',
        header: 'จุดที่รวมในราคา',
        aliases: ['Included stops'],
        example: '2',
      },
      {
        key: 'unit',
        requiredWhen: 'เมื่อสูตรเป็นต่อหน่วย',
        header: 'หน่วยนับ',
        aliases: ['Unit'],
        fields: ['unitId'],
        hint: 'เฉพาะสูตรต่อหน่วย (รหัสหรือชื่อหน่วย)',
      },
      {
        key: 'serviceItem',
        header: 'รายการบนเอกสาร',
        aliases: ['Service item'],
        fields: ['serviceItemId'],
        hint: 'ว่าง = ค่าขนส่ง (FREIGHT)',
      },
      {
        key: 'code',
        header: 'รหัส',
        aliases: ['Code'],
        example: '',
        hint: sell ? 'ว่าง = RC-S-xxxx' : 'ว่าง = RC-B-xxxx',
      },
      { key: 'notes', header: 'หมายเหตุ', aliases: ['Notes'] },
      { key: 'externalId', header: 'รหัสในระบบอื่น', aliases: ['External ID', 'externalId'] },
    ],
    // ต้นทาง/ปลายทางที่ได้จากรหัสเส้นทาง → ปัญหาชี้คอลัมน์ "เส้นทาง" ที่ผู้ใช้กรอก
    columnFor: (f, v) =>
      v.route && (f === 'originId' || f === 'destinationId') ? 'route' : undefined,
    uniqueInFile: [{ column: 'code', label: 'รหัส', key: (v) => v.code?.toUpperCase() || null }],
    // ช่วงวันทับกับแถวก่อนหน้าในไฟล์ (key เดียวกัน) — กับข้อมูลในระบบ service ตรวจ (422 overlap)
    inFile: (body, prior) => {
      const key = (x: Record<string, unknown>) =>
        [x.customerId, x.carrierId, x.originId, x.destinationId, x.vehicleTypeId].join('|');
      const end = (x: Record<string, unknown>) =>
        (x.validTo as string | null | undefined) ?? '9999-12-31';
      const hit = prior.find(
        (p) =>
          key(p.body) === key(body) &&
          String(p.body.validFrom) <= end(body) &&
          String(body.validFrom) <= end(p.body),
      );
      return hit
        ? {
            column: 'validFrom',
            code: 'overlap',
            message: `ช่วงวันที่ทับกับแถว ${hit.row} ในไฟล์เดียวกัน (ลูกค้า/ผู้รับเหมา เส้นทาง และประเภทรถเดียวกัน)`,
          }
        : null;
    },
    async build(r) {
      const b: Record<string, unknown> = { side };
      put(b, 'code', r.text('code') ?? undefined);
      put(
        b,
        sell ? 'customerId' : 'carrierId',
        await r.ref('party', sell ? 'customer' : 'carrier'),
      );
      const route = await r.refFull('route', 'route');
      if (route?.extra && (r.values.origin || r.values.destination))
        r.bad('route', 'กรอกรหัสเส้นทาง หรือ ต้นทาง/ปลายทาง อย่างใดอย่างหนึ่ง');
      if (route?.extra) {
        b.originId = route.extra.originId;
        b.destinationId = route.extra.destinationId;
      } else {
        put(b, 'originId', await r.ref('origin', 'site'));
        put(b, 'destinationId', await r.ref('destination', 'site'));
        if (route === undefined && !r.values.route && !r.values.origin && !r.values.destination)
          r.bad('route', 'ต้องกรอกรหัสเส้นทาง หรือ ต้นทางและปลายทาง', 'required');
      }
      put(b, 'vehicleTypeId', await r.ref('vehicleType', 'vehicleType'));
      put(b, 'pricingModel', r.pick('pricingModel', MODELS));
      put(b, px.rate, r.decimal('rate'));
      put(b, px.min, r.decimal('minCharge'));
      put(b, px.ex, r.decimal('extraStopRate'));
      put(b, 'includedStops', r.int('includedStops'));
      put(b, 'unitId', await r.ref('unit', 'unit'));
      put(b, 'serviceItemId', await r.ref('serviceItem', 'serviceItem'));
      put(b, 'validFrom', r.date('validFrom'));
      put(b, 'validTo', r.date('validTo'));
      put(b, 'notes', r.text('notes'));
      put(b, 'externalId', r.text('externalId'));
      return b;
    },
    create: (dto) => svc.create(dto as CreateRateCardDto),
  });
}
