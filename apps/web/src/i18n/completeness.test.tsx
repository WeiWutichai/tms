import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { SECTIONS } from '../features/settings/Settings';
import { en } from './en';
import { I18nProvider, useI18n } from './index';
import { th, type MessageKey } from './th';
import { zh } from './zh';

/**
 * ST9-T12 ตรวจความครบของข้อความ (docs/04 I "ภาษา", K10) — D-11: เฟส 0 ส่งมอบ **ไทยครบ** + โครง i18n
 * (EN/中文 ไม่บังคับ — key ที่ยังไม่แปลต้องตกกลับเป็นไทย ไม่แสดงชื่อ key)
 * สแกน key ที่ขาดหลัก ๆ อยู่ใน scripts/lint-i18n.mjs (รันใน `pnpm lint` และในไฟล์นี้) — ที่นี่เพิ่มค่า enum จาก OpenAPI
 */
const keys = new Set(Object.keys(th));
const schemas = JSON.parse(
  readFileSync(resolve(process.cwd(), '../../packages/contracts/openapi.json'), 'utf8'),
).components.schemas as Record<string, { properties: Record<string, { enum?: string[] }> }>;

function enumOf(path: string): string[] {
  const [schema, prop] = path.split('.') as [string, string];
  const e = schemas[schema]?.properties[prop]?.enum;
  if (!e?.length) throw new Error(`OpenAPI ไม่มี enum ${path}`);
  return e.map(String);
}

/**
 * ป้ายของค่า enum ที่ API ส่งมา แสดงด้วย t(`<prefix><value><suffix>`) — ทุกค่าต้องมีข้อความไทย
 * `except` = ค่าที่หน้าจอแสดงด้วยวิธีอื่น (ดูไฟล์ที่ระบุ)
 */
const ENUM_LABELS: Array<{ prefix: string; from: string; suffix?: string; except?: string[] }> = [
  { prefix: 'ord.st.', from: 'OrderDto.status' },
  { prefix: 'do.st.', from: 'DeliveryOrderDto.status' },
  { prefix: 'trip.st.', from: 'TripDto.status' },
  { prefix: 'trk.st.', from: 'TrackingShipmentDto.status' },
  { prefix: 'setup.', from: 'SetupStepDto.key' },
  { prefix: 'setup.', from: 'SetupStepDto.key', suffix: '.d' },
  { prefix: 'cust.cycle.', from: 'CustomerDto.billingCycle' },
  { prefix: 'veh.st.', from: 'VehicleDto.status' },
  { prefix: 'veh.fuel.', from: 'VehicleDto.fuelType' },
  { prefix: 'vdoc.type.', from: 'VehicleDocumentDto.docType' },
  { prefix: 'vt.vc.', from: 'VehicleTypeDto.vehicleClass' },
  { prefix: 'loc.vc.', from: 'SiteDto.maxVehicleClass' },
  { prefix: 'loc.k.', from: 'SiteDto.kind' },
  { prefix: 'vt.lic.', from: 'DriverDto.licenceClass' },
  { prefix: 'svc.vat.', from: 'ServiceItemDto.vatType' },
  { prefix: 'svc.wht.', from: 'ServiceItemDto.whtRate' },
  { prefix: 'svc.side.', from: 'ServiceItemDto.side' },
  { prefix: 'akey.st.', from: 'ApiKeyDto.status' },
  // CONNECTOR แสดงชื่อ connector (features/orders/OrderSource.tsx)
  { prefix: 'so.src.', from: 'OrderDto.sourceType', except: ['CONNECTOR'] },
  // PER_UNIT แสดงชื่อหน่วยนับ (features/rate-cards/rateFormat.ts)
  { prefix: 'rc.u.', from: 'RateCardDto.pricingModel', except: ['PER_UNIT'] },
];

describe('ST9-T12 ข้อความไทยครบ (สแกน key ที่ขาด)', () => {
  it('lint-i18n ผ่าน: key ที่ใช้ทุกตัวมีใน th.ts, ไม่มีข้อความไทย hard-code, error code ของ API มีข้อความครบ', () => {
    const out = execFileSync('node', ['scripts/lint-i18n.mjs'], {
      cwd: process.cwd(),
      encoding: 'utf8',
    });
    expect(out).toMatch(/OK/);
  });

  it.each(ENUM_LABELS)(
    'ค่า enum $from มีป้าย $prefix…$suffix ครบ',
    ({ prefix, from, suffix, except }) => {
      const missing = enumOf(from)
        .filter((v) => !except?.includes(v))
        .map((v) => `${prefix}${v}${suffix ?? ''}`)
        .filter((k) => !keys.has(k));
      expect(missing).toEqual([]);
    },
  );

  it('เมนูหน้าตั้งค่าทุกหัวข้อมีชื่อ (set.menu.*)', () => {
    expect(SECTIONS.map((s) => `set.menu.${s.k}`).filter((k) => !keys.has(k))).toEqual([]);
  });

  it('ไม่มีข้อความไทยว่าง และ en/zh ไม่มี key ที่ th ไม่มี', () => {
    expect(Object.entries(th).filter(([, v]) => !String(v).trim())).toEqual([]);
    expect(Object.keys(en).filter((k) => !keys.has(k))).toEqual([]);
    expect(Object.keys(zh).filter((k) => !keys.has(k))).toEqual([]);
    expect(Object.values(en).filter((v) => !v?.trim())).toEqual([]);
  });
});

describe('ST9-T12 EN ตกกลับอย่างนุ่มนวล (D-11: EN ไม่บังคับในเฟส 0)', () => {
  function Probe({ k }: { k: MessageKey }) {
    const { t } = useI18n();
    return <span data-testid="v">{t(k)}</span>;
  }
  const untranslated = (Object.keys(th) as MessageKey[]).find((k) => !(k in en))!;
  const translated = (Object.keys(en) as MessageKey[])[0]!;

  it('key ที่ยังไม่มีคำแปล EN → แสดงไทย (ไม่แสดงชื่อ key)', () => {
    expect(untranslated).toBeDefined();
    render(
      <I18nProvider lang="en">
        <Probe k={untranslated} />
      </I18nProvider>,
    );
    expect(screen.getByTestId('v').textContent).toBe(th[untranslated]);
  });

  it('key ที่มีคำแปล EN → แสดง EN', () => {
    render(
      <I18nProvider lang="en">
        <Probe k={translated} />
      </I18nProvider>,
    );
    expect(screen.getByTestId('v').textContent).toBe(en[translated]);
  });

  it('ทุก key เมื่อเลือก EN ได้ข้อความจริง (EN หรือไทย) ไม่ใช่ชื่อ key', () => {
    let t: ((k: MessageKey) => string) | null = null;
    function Grab() {
      t = useI18n().t;
      return null;
    }
    render(
      <I18nProvider lang="en">
        <Grab />
      </I18nProvider>,
    );
    const bad = (Object.keys(th) as MessageKey[]).filter((k) => {
      const v = t!(k);
      return !v || v === k;
    });
    expect(bad).toEqual([]);
  });
});
