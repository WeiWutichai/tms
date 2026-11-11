import { FormDrawer, FormField, TextInput } from '@tms/ui';
import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { ApiError } from '../../api';
import { useI18n } from '../../i18n';
import type { MessageKey } from '../../i18n/th';
import { fieldErrors, isStale, problemText } from '../master/problems';
import {
  CAPABILITIES,
  VEHICLE_CLASSES,
  useCreateVehicleType,
  useUpdateVehicleType,
  type Capability,
  type LicenceClass,
  type VehicleClass,
  type VehicleType,
  type VehicleTypeCreate,
  type VehicleTypeInput,
} from './useVehicleTypes';

interface Form {
  name: string;
  cap: string;
  vol: string;
  lic: LicenceClass;
  vc: VehicleClass | '';
  tags: Capability[];
  tmin: string;
  tmax: string;
}

/** ค่าเริ่มต้นตามต้นแบบ cfVt(): ใบขับขี่ขั้นต่ำ ท.2 */
const EMPTY: Form = {
  name: '',
  cap: '',
  vol: '',
  lic: 'T2',
  vc: '',
  tags: [],
  tmin: '',
  tmax: '',
};

/** ลำดับตัวเลือกใบขับขี่ตามต้นแบบ (ท.2, ท.1, ท.3, ท.4) + ส่วนบุคคล (spec/02 §4 — ต้นแบบไม่มี [OPEN spec/12 §3]) */
const LIC_ORDER: LicenceClass[] = ['T2', 'T1', 'T3', 'T4', 'PERSONAL'];

function toForm(v: VehicleType): Form {
  return {
    name: v.name,
    cap: v.payloadKg === null ? '' : String(v.payloadKg),
    vol: v.volumeCbm === null ? '' : String(v.volumeCbm),
    lic: v.minLicenceClass ?? 'T2',
    vc: v.vehicleClass,
    tags: [...v.capabilityTags],
    tmin: v.tempMinC === null ? '' : String(v.tempMinC),
    tmax: v.tempMaxC === null ? '' : String(v.tempMaxC),
  };
}

/** สไตล์ช่องของฟอร์มต้นแบบ (cfOpen: สูง 40, ขอบ #CDD1C8) */
const SEL: CSSProperties = { height: 40, padding: '0 12px', borderColor: '#CDD1C8', width: '100%' };
const NUM = { textAlign: 'right', fontVariantNumeric: 'tabular-nums' } as const;
const intOf = (s: string) => (/^\d{1,8}$/.test(s.trim()) ? Number(s) : NaN);
const decOf = (s: string, places: number) =>
  new RegExp(`^-?\\d{1,8}(\\.\\d{1,${places}})?$`).test(s.trim()) ? Number(s) : NaN;

/**
 * "เพิ่มประเภทรถ" (ต้นแบบ TMS v4 cfVt) และ "แก้ไข" (ฟอร์มเดียวกัน — ต้นแบบไม่มีฟอร์มแก้ [OPEN spec/12 §3])
 * ช่องตามต้นแบบ: ชื่อประเภทรถ, น้ำหนักบรรทุก, ปริมาตร, ใบขับขี่ขั้นต่ำ
 * ช่องที่ต้นแบบไม่มี (backlog ST2-T04 / spec/02 §4) [OPEN spec/12 §3]: ชั้นรถ, ความสามารถพิเศษ, อุณหภูมิห้องเย็น
 * ปริมาตรไม่บังคับตาม spec/02 §4 (ต้นแบบติด *) [OPEN spec/12 §3]
 */
export function VehicleTypeFormDrawer({
  open,
  vt,
  onClose,
  onSaved,
}: {
  open: boolean;
  /** มีค่า = แก้ไข */
  vt?: VehicleType | null;
  onClose: () => void;
  onSaved: (v: VehicleType, created: boolean) => void;
}) {
  const { t } = useI18n();
  const editing = !!vt;
  const create = useCreateVehicleType();
  const update = useUpdateVehicleType();
  const m = editing ? update : create;
  const [f, setF] = useState<Form>(EMPTY);
  const [tried, setTried] = useState(false);
  const [idemKey, setIdemKey] = useState(() => crypto.randomUUID());
  const submitting = useRef(false);
  useEffect(() => {
    if (open) {
      setF(vt ? toForm(vt) : EMPTY);
      setTried(false);
      setIdemKey(crypto.randomUUID());
      submitting.current = false;
      create.reset();
      update.reset();
    }
  }, [open, vt?.id]);

  const set = <K extends keyof Form>(k: K, v: Form[K]) => setF((x) => ({ ...x, [k]: v }));
  const cold = f.tags.includes('REFRIGERATED');

  // ---------- ตรวจในฟอร์ม (กฎ spec/02 §4) ----------
  const local: Record<string, string> = {};
  if (!f.name.trim()) local.name = t('vt.v.name');
  const cap = intOf(f.cap);
  if (!f.cap.trim()) local.payloadKg = t('vt.v.cap');
  else if (!(cap > 0)) local.payloadKg = t('vt.v.capBad');
  const vol = f.vol.trim() === '' ? null : decOf(f.vol, 2);
  if (vol !== null && !(vol >= 0)) local.volumeCbm = t('vt.v.vol');
  if (!f.vc) local.vehicleClass = t('vt.v.class');
  const tmin = cold ? decOf(f.tmin, 1) : null;
  const tmax = cold ? decOf(f.tmax, 1) : null;
  if (cold) {
    if (Number.isNaN(tmin)) local.tempMinC = t('vt.v.temp');
    if (Number.isNaN(tmax)) local.tempMaxC = t('vt.v.temp');
    else if (tmin !== null && tmax !== null && !Number.isNaN(tmin) && tmin >= tmax)
      local.tempMaxC = t('vt.v.tempRange');
  }
  const server = fieldErrors(m.error, t);
  // ชื่อซ้ำ → ข้อความตามต้นแบบ cfVt ("มีประเภทนี้แล้ว")
  if (
    m.error instanceof ApiError &&
    m.error.problem.errors?.some((e) => e.field === 'name' && e.code === 'duplicate')
  )
    server.name = t('vt.v.dup');
  const errs = { ...(tried ? local : {}), ...server };
  const topErr =
    m.error && !Object.keys(server).length
      ? isStale(m.error)
        ? t('vt.stale')
        : problemText(m.error, t)
      : null;

  const body = (): VehicleTypeCreate => ({
    name: f.name.trim(),
    payloadKg: cap,
    volumeCbm: vol,
    minLicenceClass: f.lic,
    vehicleClass: f.vc as VehicleClass,
    capabilityTags: f.tags,
    tempMinC: cold ? tmin : null,
    tempMaxC: cold ? tmax : null,
  });
  /** แก้ไข: ส่งเฉพาะช่องที่เปลี่ยน */
  const diff = (v: VehicleType): VehicleTypeInput => {
    const a = toForm(v);
    const b = body();
    const out: VehicleTypeInput = {};
    if (a.name !== f.name) out.name = b.name;
    if (a.cap !== f.cap) out.payloadKg = b.payloadKg;
    if (a.vol !== f.vol) out.volumeCbm = b.volumeCbm ?? null;
    if (a.lic !== f.lic) out.minLicenceClass = b.minLicenceClass;
    if (a.vc !== f.vc) out.vehicleClass = b.vehicleClass;
    const tagsChanged = [...a.tags].sort().join() !== [...f.tags].sort().join();
    if (tagsChanged) out.capabilityTags = b.capabilityTags!;
    if (cold && (tagsChanged || a.tmin !== f.tmin || a.tmax !== f.tmax)) {
      out.tempMinC = b.tempMinC ?? null;
      out.tempMaxC = b.tempMaxC ?? null;
    }
    return out;
  };
  const submit = () => {
    setTried(true);
    if (Object.keys(local).length || submitting.current) return;
    submitting.current = true;
    const done = {
      onError: () => setIdemKey(crypto.randomUUID()),
      onSettled: () => {
        submitting.current = false;
      },
    };
    if (vt) {
      const d = diff(vt);
      if (!Object.keys(d).length) {
        submitting.current = false;
        return onClose();
      }
      update.mutate(
        { id: vt.id, version: vt.version, body: d },
        { ...done, onSuccess: (v) => onSaved(v, false) },
      );
    } else
      create.mutate(
        { idempotencyKey: idemKey, body: body() },
        { ...done, onSuccess: (v) => onSaved(v, true) },
      );
  };

  const input =
    (
      k: 'name' | 'cap' | 'vol' | 'tmin' | 'tmax',
      extra: Partial<React.InputHTMLAttributes<HTMLInputElement>> = {},
    ) =>
    (p: { id: string; 'aria-invalid': boolean }) => (
      <TextInput
        {...p}
        {...extra}
        value={f[k]}
        onChange={(e) => setF((x) => ({ ...x, [k]: e.target.value }))}
      />
    );
  const toggleTag = (c: Capability, on: boolean) =>
    setF((x) => ({
      ...x,
      tags: on
        ? CAPABILITIES.filter((y) => y === c || x.tags.includes(y))
        : x.tags.filter((y) => y !== c),
    }));

  return (
    <FormDrawer
      open={open}
      title={editing ? t('vt.edit.title') : t('vt.create.title')}
      subtitle={editing ? vt?.code : t('vt.create.sub')}
      onClose={onClose}
      closeLabel={t('drawer.close')}
      {...(tried && Object.keys(local).length
        ? { alert: t('form.incomplete', { n: Object.keys(local).length }) }
        : {})}
      onSubmit={submit}
      footer={
        <>
          <button type="button" className="tms-fdrawer__cancel" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button
            type="submit"
            className="tms-drawer__pri"
            style={{ height: 40, padding: '0 18px' }}
            disabled={m.isPending}
          >
            {editing ? t('common.save') : t('vt.add')}
          </button>
        </>
      }
    >
      {topErr && <div className="tms-alert">{topErr}</div>}
      <section className="tms-fsec">
        <div className="tms-fgrid tms-fgrid--create">
          <FormField label={t('vt.f.name')} required span={2} error={errs.name}>
            {input('name', { autoFocus: true, maxLength: 100, placeholder: t('vt.f.namePh') })}
          </FormField>
          <FormField label={t('vt.f.cap')} required error={errs.payloadKg}>
            {input('cap', { inputMode: 'numeric', placeholder: '0', style: NUM })}
          </FormField>
          <FormField label={t('vt.f.vol')} error={errs.volumeCbm}>
            {input('vol', { inputMode: 'decimal', placeholder: '0', style: NUM })}
          </FormField>
          <FormField label={t('vt.f.lic')} required error={errs.minLicenceClass}>
            {(p) => (
              <select
                {...p}
                className="tms-select"
                style={SEL}
                value={f.lic}
                onChange={(e) => set('lic', e.target.value as LicenceClass)}
              >
                {LIC_ORDER.map((k) => (
                  <option key={k} value={k}>
                    {t(`vt.lic.${k}` as MessageKey)}
                  </option>
                ))}
              </select>
            )}
          </FormField>
          <FormField
            label={t('vt.f.class')}
            required
            error={errs.vehicleClass}
            hint={t('vt.f.classHint')}
          >
            {(p) => (
              <select
                {...p}
                className="tms-select"
                style={SEL}
                value={f.vc}
                onChange={(e) => set('vc', e.target.value as VehicleClass)}
              >
                <option value="" disabled>
                  {t('vt.f.classPick')}
                </option>
                {VEHICLE_CLASSES.map((k) => (
                  <option key={k} value={k}>
                    {t(`vt.vc.${k}` as MessageKey)}
                  </option>
                ))}
              </select>
            )}
          </FormField>
          <FormField label={t('vt.f.tags')} span={2} error={errs.capabilityTags}>
            {(p) => (
              <div
                id={p.id}
                role="group"
                style={{ display: 'flex', flexWrap: 'wrap', gap: '8px 20px', minHeight: 40 }}
              >
                {CAPABILITIES.map((c) => (
                  <label
                    key={c}
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 8,
                      cursor: 'pointer',
                    }}
                  >
                    <input
                      type="checkbox"
                      className="set-check"
                      checked={f.tags.includes(c)}
                      onChange={(e) => toggleTag(c, e.target.checked)}
                    />
                    {t(`vt.tag.${c}` as MessageKey)}
                  </label>
                ))}
              </div>
            )}
          </FormField>
          {cold && (
            <>
              <FormField label={t('vt.f.tmin')} required error={errs.tempMinC}>
                {input('tmin', { inputMode: 'decimal', placeholder: '0', style: NUM })}
              </FormField>
              <FormField label={t('vt.f.tmax')} required error={errs.tempMaxC}>
                {input('tmax', { inputMode: 'decimal', placeholder: '8', style: NUM })}
              </FormField>
            </>
          )}
        </div>
      </section>
    </FormDrawer>
  );
}
