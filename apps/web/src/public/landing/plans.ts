import { useEffect, useState } from 'react';

/**
 * ข้อมูลแพ็กเกจสาธารณะ (P1-ST2-T02) จาก `GET /v1/public/plans` — ทางเดียวที่หน้าราคาและ landing อ่านราคา (PLT-002)
 * 404 = `pricing.publicVisible = false` (D-40 ยังไม่เคาะ) → ซ่อนราคาทั้งหมด · ไม่ใช้ React Query (landing เป็น bundle เบา)
 */
export type CellKind = 'yes' | 'addon' | 'no' | 'limit' | 'unlimited';

export interface PublicPlan {
  code: string;
  nameTh: string;
  nameEn: string | null;
  badge: string | null;
  isContactSales: boolean;
  version: number;
  effectiveFrom: string;
  pricePerVehicleMonthly: string | null;
  minimumMonthly: string | null;
  annualDiscountPct: string;
  volumeTiers: { fromVehicle: number; discountPct: string }[];
  vehicleMin: number;
  vehicleMax: number | null;
  trialDays: number;
  provisional: boolean;
}

export interface PublicFeature {
  key: string;
  category: string;
  nameTh: string;
  nameEn: string | null;
  type: string;
  unit: string | null;
  isBasic: boolean;
  cells: { kind: CellKind; limit: number | null }[];
}

export interface PublicPlans {
  currency: string;
  vatMode: string;
  provisional: boolean;
  retentionDays: number;
  subconWeight: string;
  /** วันทดลองใช้ที่ใช้จริงตอนสมัคร (ค่าตั้ง trial.days) */
  trialDays: number;
  plans: PublicPlan[];
  features: PublicFeature[];
}

/** สถานะการโหลด: undefined = กำลังโหลด · null = ปิดหน้าราคา (404) · 'error' = โหลดไม่สำเร็จ */
export type PlansState = PublicPlans | null | 'error' | undefined;

export const plansApi = {
  async fetch(): Promise<PublicPlans | null> {
    const r = await fetch('/v1/public/plans', { headers: { Accept: 'application/json' } });
    if (r.status === 404) return null;
    if (!r.ok) throw new Error(`plans ${r.status}`);
    return (await r.json()) as PublicPlans;
  },
};

/** โหลดแพ็กเกจครั้งเดียว (enabled = false → ไม่โหลด เช่นเมื่อ test ส่งข้อมูลมาเอง) · reload() = ลองใหม่ */
export function usePublicPlans(enabled = true): { state: PlansState; reload: () => void } {
  const [state, setState] = useState<PlansState>(undefined);
  const [n, setN] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    setState(undefined);
    plansApi.fetch().then(
      (v) => live && setState(v),
      () => live && setState('error'),
    );
    return () => {
      live = false;
    };
  }, [enabled, n]);
  return { state, reload: () => setN((x) => x + 1) };
}

/** แพ็กเกจแรก (ตาม sortOrder) ที่มีราคาต่อรถ — ราคา "เริ่ม ฿…" ของ landing */
export function entryPlan(p: PublicPlans): PublicPlan | undefined {
  return p.plans.find((x) => x.pricePerVehicleMonthly !== null);
}

const thousands = (s: string) => s.replace(/\B(?=(\d{3})+(?!\d))/g, ',');

/** "1234.50" → "1,234.50" (ตัวคำนวณ — ต้นแบบ T.fmt) */
export function fmtMoney(dec: string): string {
  const [w, f = '00'] = dec.split('.');
  return `${thousands(w!)}.${f.padEnd(2, '0')}`;
}

/** "350.00" → "350" · "297.50" → "297.50" (การ์ดราคา — ต้นแบบ T.num) */
export function fmtPrice(dec: string): string {
  const [w, f = '00'] = dec.split('.');
  return /^0*$/.test(f) ? thousands(w!) : `${thousands(w!)}.${f.padEnd(2, '0')}`;
}

/** "15.00" → "15" · "12.50" → "12.5" */
export function fmtPct(dec: string): string {
  return dec.includes('.') ? dec.replace(/\.?0+$/, '') : dec;
}

/** 1000 → "1,000" */
export const fmtInt = (n: number) => thousands(String(n));
