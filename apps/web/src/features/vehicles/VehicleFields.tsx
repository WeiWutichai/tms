import { FormField, TextInput } from '@tms/ui';
import type { CSSProperties, ReactNode } from 'react';
import type { T } from '../../i18n';
import type { MessageKey } from '../../i18n/th';
import { searchCarriers } from '../carriers/useCarriers';
import { RefPicker, type RefOption } from '../master/RefPicker';
import {
  FUEL_TYPES,
  GPS_PROVIDERS,
  PROVINCES,
  UNIT_ROLES,
  searchPairable,
  vehPlate,
  type FuelType,
  type Province,
  type UnitRole,
  type Vehicle,
  type VehicleCreate,
  type VehicleInput,
  type VehicleStatus,
} from './useVehicles';

/** ค่าฟอร์มรถ (ใช้ร่วม: ฟอร์ม "เพิ่มรถ" และ drawer แก้ไข) — ตัวเลขเก็บเป็นข้อความตามที่พิมพ์ */
export interface VehicleForm {
  plate: string;
  prov: Province | '';
  typeId: string;
  cap: string;
  own: 'OWN' | 'SUBCONTRACT';
  carrier: RefOption | null;
  gps: string;
  gpsId: string;
  status: VehicleStatus;
  role: UnitRole;
  pair: RefOption | null;
  brand: string;
  model: string;
  year: string;
  color: string;
  vin: string;
  eng: string;
  tare: string;
  gross: string;
  vol: string;
  fuel: FuelType | '';
  tank: string;
  odo: string;
  buyOn: string;
  cost: string;
  life: string;
  salvage: string;
}

/** ค่าเริ่มต้นของรถใหม่ (ต้นแบบ newWithCf('veh'): ทะเบียนว่าง ประเภท "— เลือก —" น้ำหนักว่าง) — จังหวัดเริ่มที่ กทม. */
export const EMPTY_FORM: VehicleForm = {
  plate: '',
  prov: 'TH-10',
  typeId: '',
  cap: '',
  own: 'OWN',
  carrier: null,
  gps: '',
  gpsId: '',
  status: 'ready',
  role: 'SINGLE',
  pair: null,
  brand: '',
  model: '',
  year: '',
  color: '',
  vin: '',
  eng: '',
  tare: '',
  gross: '',
  vol: '',
  fuel: '',
  tank: '',
  odo: '',
  buyOn: '',
  cost: '',
  life: '',
  salvage: '',
};

const s = (v: string | number | null | undefined) =>
  v === null || v === undefined ? '' : String(v);

export function toForm(v: Vehicle, t: T): VehicleForm {
  return {
    plate: v.plate,
    prov: v.plateProvince as Province,
    typeId: v.vehicleType.id,
    cap: s(v.payloadKg),
    own: v.ownership,
    carrier: v.carrier ? { id: v.carrier.id, label: v.carrier.name, sub: v.carrier.code } : null,
    gps: s(v.gpsProvider),
    gpsId: s(v.gpsDeviceId),
    status: v.status,
    role: v.unitRole,
    pair: v.paired ? { id: v.paired.id, label: vehPlate(t, v.paired) } : null,
    brand: s(v.brand),
    model: s(v.model),
    year: s(v.year),
    color: s(v.color),
    vin: s(v.chassisNo),
    eng: s(v.engineNo),
    tare: s(v.tareWeightKg),
    gross: s(v.grossWeightKg),
    vol: s(v.volumeCbm),
    fuel: v.fuelType ?? '',
    tank: s(v.tankCapacityL),
    odo: s(v.odometerKm),
    buyOn: s(v.purchasedOn),
    cost: s(v.purchaseCost),
    life: s(v.depreciationYears),
    salvage: s(v.salvageValue),
  };
}

const PLATE_RE = /^[0-9A-Z\u0E01-\u0E2E]{2,10}$/;
const dec = (x: string, places: number) =>
  new RegExp(`^\\d{1,8}(\\.\\d{1,${places}})?$`).test(x.trim()) ? Number(x) : NaN;
const int = (x: string) => (/^\d{1,8}$/.test(x.trim()) ? Number(x) : NaN);
const MONEY = /^\d{1,12}(\.\d{1,2})?$/;

/** ตรวจในฟอร์ม (กฎเดียวกับ API ที่ตรวจได้ทันที) — คืน { ช่อง API: ข้อความ } */
export function validate(f: VehicleForm, t: T): Record<string, string> {
  const e: Record<string, string> = {};
  const pk = f.plate.replace(/[\s\-.]/g, '').toUpperCase();
  if (!f.plate.trim()) e.plate = t('veh.v.plate');
  else if (!PLATE_RE.test(pk) || !/\d/.test(pk)) e.plate = t('veh.v.plateBad');
  if (!f.prov) e.plateProvince = t('veh.v.prov');
  if (!f.typeId) e.vehicleTypeId = t('veh.v.type');
  if (!(dec(f.cap, 2) > 0)) e.payloadKg = t('veh.v.cap');
  if (f.own === 'SUBCONTRACT' && !f.carrier) e.carrierId = t('veh.v.carrier');
  const optDec = (k: string, v: string, places = 2) => {
    if (v.trim() && Number.isNaN(dec(v, places))) e[k] = t('veh.v.num');
  };
  const optInt = (k: string, v: string) => {
    if (v.trim() && Number.isNaN(int(v))) e[k] = t('veh.v.int');
  };
  optDec('tareWeightKg', f.tare);
  optDec('grossWeightKg', f.gross);
  optDec('volumeCbm', f.vol);
  optDec('odometerKm', f.odo, 1);
  optInt('year', f.year);
  optInt('tankCapacityL', f.tank);
  optInt('depreciationYears', f.life);
  if (f.cost.trim() && !MONEY.test(f.cost.trim())) e.purchaseCost = t('veh.v.money');
  if (f.salvage.trim() && !MONEY.test(f.salvage.trim())) e.salvageValue = t('veh.v.money');
  if ((f.life.trim() || f.salvage.trim()) && !f.cost.trim()) e.purchaseCost = t('veh.v.lifeCost');
  return e;
}

const nOrNull = (x: string) => (x.trim() ? Number(x) : null);
const tOrNull = (x: string) => (x.trim() ? x.trim() : null);

/** ฟอร์ม → body ของ API (ข้อมูลการเงินส่งเฉพาะผู้มีสิทธิ์) */
export function toBody(f: VehicleForm, finance: boolean): VehicleCreate {
  return {
    plate: f.plate.trim(),
    plateProvince: f.prov as Province,
    vehicleTypeId: f.typeId,
    ownership: f.own,
    carrierId: f.own === 'SUBCONTRACT' ? (f.carrier?.id ?? null) : null,
    payloadKg: Number(f.cap),
    gpsProvider: tOrNull(f.gps),
    gpsDeviceId: tOrNull(f.gpsId),
    unitRole: f.role,
    pairedVehicleId: f.role === 'SINGLE' ? null : (f.pair?.id ?? null),
    brand: tOrNull(f.brand),
    model: tOrNull(f.model),
    year: nOrNull(f.year),
    color: tOrNull(f.color),
    chassisNo: tOrNull(f.vin),
    engineNo: tOrNull(f.eng),
    tareWeightKg: nOrNull(f.tare),
    grossWeightKg: nOrNull(f.gross),
    volumeCbm: nOrNull(f.vol),
    fuelType: f.fuel || null,
    tankCapacityL: nOrNull(f.tank),
    ...(f.odo.trim() ? { odometerKm: Number(f.odo) } : {}),
    ...(finance
      ? {
          purchasedOn: tOrNull(f.buyOn),
          purchaseCost: tOrNull(f.cost),
          depreciationMethod: f.life.trim() ? 'STRAIGHT_LINE' : null,
          depreciationYears: nOrNull(f.life),
          salvageValue: tOrNull(f.salvage),
        }
      : {}),
  };
}

/** แก้ไข: ส่งเฉพาะช่องที่เปลี่ยน (เทียบกับค่าที่โหลดเข้าฟอร์ม) — สถานะแยกไป POST /status */
export function toDiff(base: VehicleForm, f: VehicleForm, finance: boolean): VehicleInput {
  const a = toBody(base, finance) as Record<string, unknown>;
  const b = toBody(f, finance) as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(b)) if (JSON.stringify(a[k]) !== JSON.stringify(b[k])) out[k] = b[k];
  // ปลดคู่เมื่อเปลี่ยนเป็นรถเดี่ยว ต้องส่ง pairedVehicleId: null คู่กับ unitRole (API ไม่ให้เปลี่ยนบทบาทขณะจับคู่)
  if ('unitRole' in out && base.pair && !('pairedVehicleId' in out))
    out.pairedVehicleId = b.pairedVehicleId;
  return out as VehicleInput;
}

const SEL: CSSProperties = { height: 40, padding: '0 12px', borderColor: '#CDD1C8', width: '100%' };
const NUM = { textAlign: 'right', fontVariantNumeric: 'tabular-nums' } as const;

/**
 * ช่องของฟอร์มรถ — ส่วน "ข้อมูลหลัก" (ต้นแบบ newWithCf('veh') + vPanel veh) และ "ข้อมูลเพิ่มเติม" (ทะเบียนรถขยาย)
 * `section` เลือกส่วนที่จะ render · `edit` = drawer แก้ไข (มีช่องสถานะ, ไม่ติด *)
 */
export function VehicleFields({
  t,
  f,
  set,
  errs,
  section,
  edit,
  readOnly,
  tenantName,
  types,
  selfId,
  onType,
}: {
  t: T;
  f: VehicleForm;
  set: <K extends keyof VehicleForm>(k: K, v: VehicleForm[K]) => void;
  errs: Record<string, string>;
  section: 'main' | 'extra' | 'fin';
  edit?: boolean;
  readOnly?: boolean;
  tenantName: string;
  types: { id: string; name: string; payloadKg: number | null }[];
  selfId?: string;
  onType?: (id: string) => void;
}) {
  const req = !edit;
  const text = (
    k: keyof VehicleForm,
    extra: Partial<React.InputHTMLAttributes<HTMLInputElement>> = {},
  ) =>
    function Inp(p: { id: string; 'aria-invalid': boolean }): ReactNode {
      return (
        <TextInput
          {...p}
          readOnly={readOnly}
          {...extra}
          value={f[k] as string}
          onChange={(e) => {
            const v = e.target.value;
            set(k, v as never);
          }}
        />
      );
    };
  const num = (k: keyof VehicleForm, decimal = true) =>
    text(k, { inputMode: decimal ? 'decimal' : 'numeric', placeholder: '0', style: NUM });
  const select = (
    k: keyof VehicleForm,
    opts: { value: string; label: string }[],
    onPick?: (v: string) => void,
  ) =>
    function Sel(p: { id: string; 'aria-invalid': boolean }): ReactNode {
      return (
        <select
          {...p}
          className="tms-select"
          style={SEL}
          disabled={readOnly}
          value={f[k] as string}
          onChange={(e) => (onPick ? onPick(e.target.value) : set(k, e.target.value as never))}
        >
          {opts.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      );
    };

  if (section === 'main')
    return (
      <>
        <FormField label={t('veh.f.plate')} required={req} error={errs.plate}>
          {text('plate', {
            autoFocus: !edit,
            maxLength: 20,
            placeholder: edit ? '' : t('veh.f.platePh'),
            className: 'tms-num',
          })}
        </FormField>
        <FormField label={t('veh.f.prov')} required={req} error={errs.plateProvince}>
          {select(
            'prov',
            PROVINCES.map((c) => ({ value: c, label: t(`prov.${c}` as MessageKey) })),
          )}
        </FormField>
        <FormField label={t('veh.f.type')} required={req} error={errs.vehicleTypeId}>
          {select(
            'typeId',
            [
              ...(f.typeId ? [] : [{ value: '', label: t('veh.f.pick') }]),
              ...types.map((x) => ({ value: x.id, label: x.name })),
            ],
            (v) => (onType ? onType(v) : set('typeId', v)),
          )}
        </FormField>
        <FormField
          label={t('veh.f.cap')}
          required={req}
          error={errs.payloadKg}
          hint={edit ? undefined : t('veh.f.capHint')}
        >
          {num('cap')}
        </FormField>
        <FormField label={t('veh.f.own')} required={req} error={errs.ownership}>
          {select('own', [
            { value: 'OWN', label: t('veh.own.OWN') },
            { value: 'SUBCONTRACT', label: t('veh.own.SUBCONTRACT') },
          ])}
        </FormField>
        <FormField
          label={t('veh.f.ownN')}
          required={req && f.own === 'SUBCONTRACT'}
          error={errs.carrierId}
        >
          {(p) =>
            f.own === 'OWN' ? (
              <TextInput {...p} readOnly value={tenantName} />
            ) : (
              <RefPicker
                id={p.id}
                value={f.carrier}
                onChange={(o) => set('carrier', o)}
                search={(q) => searchCarriers(q)}
                queryKey="veh-carrier"
                placeholder={t('veh.f.carrierPh')}
                noResult={t('veh.f.noResult')}
                invalid={p['aria-invalid']}
                disabled={readOnly}
              />
            )
          }
        </FormField>
        {edit && (
          <>
            <FormField label={t('veh.f.gps')} error={errs.gpsProvider}>
              {select('gps', [
                { value: '', label: t('veh.f.gpsNone') },
                ...GPS_PROVIDERS.map((g) => ({ value: g, label: t(`veh.gps.${g}` as MessageKey) })),
                ...(f.gps && !(GPS_PROVIDERS as readonly string[]).includes(f.gps)
                  ? [{ value: f.gps, label: f.gps }]
                  : []),
              ])}
            </FormField>
            <FormField label={t('veh.f.status')}>
              {select(
                'status',
                (['ready', 'maintenance', 'parked', 'retired'] as const).map((k) => ({
                  value: k,
                  label: t(`veh.st.${k}`),
                })),
              )}
            </FormField>
          </>
        )}
      </>
    );

  if (section === 'fin')
    return (
      <>
        <FormField label={t('veh.f.buyOn')} error={errs.purchasedOn}>
          {text('buyOn', { type: 'date' })}
        </FormField>
        <FormField label={t('veh.f.cost')} error={errs.purchaseCost}>
          {num('cost')}
        </FormField>
        <FormField
          label={t('veh.f.life')}
          error={errs.depreciationYears ?? errs.depreciationMethod}
        >
          {num('life', false)}
        </FormField>
        <FormField label={t('veh.f.salvage')} error={errs.salvageValue}>
          {num('salvage')}
        </FormField>
      </>
    );

  return (
    <>
      {!edit && (
        <FormField label={t('veh.f.gps')} error={errs.gpsProvider}>
          {select('gps', [
            { value: '', label: t('veh.f.gpsNone') },
            ...GPS_PROVIDERS.map((g) => ({ value: g, label: t(`veh.gps.${g}` as MessageKey) })),
          ])}
        </FormField>
      )}
      <FormField label={t('veh.f.gpsId')} error={errs.gpsDeviceId} hint={t('veh.f.gpsIdHint')}>
        {text('gpsId', { placeholder: t('veh.f.gpsIdPh'), maxLength: 50, className: 'tms-num' })}
      </FormField>
      <FormField label={t('veh.f.role')} error={errs.unitRole}>
        {select(
          'role',
          UNIT_ROLES.map((r) => ({ value: r, label: t(`veh.role.${r}`) })),
          (v) => {
            set('role', v as UnitRole);
            set('pair', null);
          },
        )}
      </FormField>
      <FormField
        label={t('veh.f.pair')}
        error={errs.pairedVehicleId}
        hint={f.role === 'SINGLE' ? t('veh.f.pairHint') : undefined}
      >
        {(p) => (
          <RefPicker
            id={p.id}
            value={f.pair}
            onChange={(o) => set('pair', o)}
            search={(q) => searchPairable(q, f.role, t, selfId)}
            queryKey={`veh-pair-${f.role}`}
            placeholder={t('veh.f.pairPh')}
            noResult={t('veh.f.noResult')}
            clearLabel={t('veh.f.gpsNone')}
            invalid={p['aria-invalid']}
            disabled={readOnly || f.role === 'SINGLE'}
          />
        )}
      </FormField>
      <FormField label={t('veh.f.brand')} error={errs.brand}>
        {text('brand', { maxLength: 60 })}
      </FormField>
      <FormField label={t('veh.f.model')} error={errs.model}>
        {text('model', { maxLength: 60 })}
      </FormField>
      <FormField label={t('veh.f.year')} error={errs.year}>
        {text('year', { inputMode: 'numeric', maxLength: 4, placeholder: '2021' })}
      </FormField>
      <FormField label={t('veh.f.color')} error={errs.color}>
        {text('color', { maxLength: 40 })}
      </FormField>
      <FormField label={t('veh.f.vin')} error={errs.chassisNo}>
        {text('vin', { maxLength: 40, className: 'tms-num' })}
      </FormField>
      <FormField label={t('veh.f.eng')} error={errs.engineNo}>
        {text('eng', { maxLength: 40, className: 'tms-num' })}
      </FormField>
      <FormField label={t('veh.f.tare')} error={errs.tareWeightKg}>
        {num('tare')}
      </FormField>
      <FormField label={t('veh.f.gross')} error={errs.grossWeightKg}>
        {num('gross')}
      </FormField>
      <FormField label={t('veh.f.vol')} error={errs.volumeCbm}>
        {num('vol')}
      </FormField>
      <FormField label={t('veh.f.fuel')} error={errs.fuelType}>
        {select('fuel', [
          { value: '', label: t('veh.f.gpsNone') },
          ...FUEL_TYPES.map((x) => ({ value: x, label: t(`veh.fuel.${x}`) })),
        ])}
      </FormField>
      <FormField label={t('veh.f.tank')} error={errs.tankCapacityL}>
        {num('tank', false)}
      </FormField>
      <FormField
        label={t('veh.f.odo')}
        error={errs.odometerKm}
        hint={edit ? t('veh.f.odoHint') : undefined}
      >
        {num('odo')}
      </FormField>
    </>
  );
}
