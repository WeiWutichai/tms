import { FormDrawer, FormField, FormSection, Icon, TextInput, Toast } from '@tms/ui';
import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { ApiError } from '../../api';
import { useI18n } from '../../i18n';
import type { MessageKey } from '../../i18n/th';
import { fieldErrors, isStale, problemText } from '../master/problems';
import { RefPicker, type RefOption } from '../master/RefPicker';
import {
  formatContact,
  formatLatLng,
  inThaiBox,
  parseAliases,
  parseContact,
  parseLatLng,
} from './siteFormat';
import {
  SITE_KINDS,
  VEHICLE_CLASSES,
  fetchSite,
  onlyGeocodeChanged,
  useCreateSite,
  useGeocodeEstimate,
  searchCustomers,
  useUpdateSite,
  type Site,
  type SiteCreate,
  type SiteInput,
  type SiteKind,
  type VehicleClass,
} from './useSites';

interface Form {
  name: string;
  kind: SiteKind;
  cust: RefOption | null;
  addr: string;
  ll: string;
  r: string;
  mx: VehicleClass | '';
  open: string;
  close: string;
  ct: string;
  aliases: string;
  svc: string;
  notes: string;
  ext: string;
}

/** ค่าเริ่มต้นตามต้นแบบ cfLoc(): ปลายทาง, รัศมี 300, รถเข้าได้สูงสุด 10 ล้อ, เวลาทำการ 08:00–17:00 */
const EMPTY: Form = {
  name: '',
  kind: 'DROPOFF',
  cust: null,
  addr: '',
  ll: '',
  r: '300',
  mx: '10W',
  open: '08:00',
  close: '17:00',
  ct: '',
  aliases: '',
  svc: '',
  notes: '',
  ext: '',
};

function toForm(s: Site): Form {
  return {
    name: s.name,
    kind: s.kind,
    cust: s.customer ? { id: s.customer.id, label: s.customer.name, sub: s.customer.code } : null,
    addr: s.address.line1,
    ll: formatLatLng(s.lat, s.lng),
    r: String(s.geofenceRadiusM),
    mx: s.maxVehicleClass ?? '',
    open: s.openTime ?? '',
    close: s.closeTime ?? '',
    ct: formatContact(s.contact),
    aliases: s.aliases.join('\n'),
    svc: s.serviceTimeMin === null ? '' : String(s.serviceTimeMin),
    notes: s.notes ?? '',
    ext: s.externalId ?? '',
  };
}

/** สไตล์ช่องของฟอร์มต้นแบบ (cfOpen: สูง 40, ขอบ #CDD1C8) */
const SEL: CSSProperties = { height: 40, padding: '0 12px', borderColor: '#CDD1C8', width: '100%' };
const AREA: CSSProperties = { padding: '8px 12px', borderColor: '#CDD1C8', width: '100%' };
const PILL: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  height: 40,
  padding: '0 12px',
  border: '1px solid #9DB6E3',
  borderRadius: 999,
  background: '#FFFFFF',
  color: '#2257C4',
  fontWeight: 500,
  whiteSpace: 'nowrap',
};

/**
 * "เพิ่มสถานที่ / จุดรับส่ง" (ต้นแบบ TMS v4 cfLoc) และ "แก้ไข" (ฟอร์มเดียวกัน — ต้นแบบไม่มีฟอร์มแก้ [OPEN spec/12 §3])
 * ช่องตามต้นแบบ: ชื่อ, ประเภท, ลูกค้า, ที่อยู่, พิกัด + แผนที่, รัศมี geofence, รถเข้าได้สูงสุด, เวลาทำการ, ผู้ติดต่อ
 * ข้อมูลเพิ่มเติม (ไม่มีในต้นแบบ — ตาม backlog ST2-T02): ชื่อเรียกอื่น, เวลาให้บริการ, หมายเหตุ, รหัสในระบบต้นทาง
 * แผนที่: ยังไม่เลือกผู้ให้บริการ (Q-D3) → แสดงกรอบแผนที่ว่าง + กรอกพิกัดเอง
 * "ประมาณจากที่อยู่" (ST2-T03): เรียก geocode ของผู้ให้บริการที่ตั้งค่า → เติมพิกัดให้ตรวจ — กดบันทึก = คนยืนยัน (OK)
 */
export function SiteFormDrawer({
  open,
  site,
  presetCustomer,
  onClose,
  onSaved,
}: {
  open: boolean;
  /** มีค่า = แก้ไข */
  site?: Site | null;
  /** เปิดจากแท็บ "ที่อยู่ส่ง" ของลูกค้า */
  presetCustomer?: RefOption;
  onClose: () => void;
  onSaved: (s: Site, created: boolean) => void;
}) {
  const { t } = useI18n();
  const editing = !!site;
  const create = useCreateSite();
  const update = useUpdateSite();
  const m = editing ? update : create;
  const [f, setF] = useState<Form>(EMPTY);
  const [tried, setTried] = useState(false);
  const [idemKey, setIdemKey] = useState(() => crypto.randomUUID());
  const submitting = useRef(false);
  const estimate = useGeocodeEstimate();
  /** ชื่อที่ผู้ให้บริการจับคู่ได้ เมื่อพิกัดในช่องมาจากปุ่มประมาณ (แก้ช่องเอง = ล้าง) */
  const [estimated, setEstimated] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  useEffect(() => {
    if (open) {
      setF(site ? toForm(site) : { ...EMPTY, cust: presetCustomer ?? null });
      setTried(false);
      setEstimated(null);
      setToast(null);
      estimate.reset();
      setIdemKey(crypto.randomUUID());
      submitting.current = false;
      create.reset();
      update.reset();
    }
  }, [open, site?.id]);
  const set = <K extends keyof Form>(k: K, v: Form[K]) => setF((x) => ({ ...x, [k]: v }));

  /** ต้นแบบ cfLoc gps(): หาไม่พบ → toast ให้ปักหมุดเอง · พบ → เติมพิกัดในช่อง (ยังไม่บันทึก) */
  const runEstimate = () => {
    const address = f.addr.trim();
    if (!address) return setToast(t('loc.geo.needAddr'));
    setToast(null);
    estimate.mutate(address, {
      onSuccess: (r) => {
        const c = r.candidates[0];
        if (!c)
          return setToast(t(r.provider === 'none' ? 'loc.geo.noProvider' : 'loc.geo.notFound'));
        set('ll', formatLatLng(c.lat, c.lng));
        setEstimated(c.label);
        setToast(null); // ล้าง "ไม่พบ…" ของครั้งก่อน
      },
      onError: () => setToast(t('loc.geo.error')),
    });
  };

  // ---------- ตรวจในฟอร์ม (กฎจาก spec/02 §2; ข้อความตามต้นแบบ) ----------
  const local: Record<string, string> = {};
  if (!f.name.trim()) local.name = t('loc.v.name');
  if (!f.addr.trim()) local.address = t('loc.v.addr');
  const ll = parseLatLng(f.ll);
  if (f.ll.trim() && !ll) local.lat = t('loc.v.ll');

  const r = /^\d{1,4}$/.test(f.r.trim()) ? Number(f.r) : NaN;
  if (!(r >= 50 && r <= 2000)) local.geofenceRadiusM = t('loc.v.r');
  if (!!f.open !== !!f.close) local.openTime = t('loc.v.hrs');
  else if (f.open && f.open === f.close) local.openTime = t('field.same_time');
  const svc = f.svc.trim() === '' ? null : /^\d{1,3}$/.test(f.svc.trim()) ? Number(f.svc) : NaN;
  if (svc !== null && !(svc >= 0 && svc <= 720)) local.serviceTimeMin = t('loc.v.svc');
  const contact = parseContact(f.ct);
  // พิกัดนอกกรอบไทย → เตือน (ไม่บล็อก) + ปุ่มสลับถ้าสลับแล้วเข้ากรอบ
  const swapped = ll && !inThaiBox(ll) && inThaiBox({ lat: ll.lng, lng: ll.lat });
  // นอกกรอบไทย: สลับแล้วเข้ากรอบ = "อาจสลับกัน" + ปุ่มสลับ; ไม่งั้น = "อยู่นอกประเทศไทย…" (ไม่บล็อก)
  const llWarn = ll && !inThaiBox(ll) ? t(swapped ? 'loc.v.llSwap' : 'loc.v.llOut') : undefined;
  // lat เกิน ±90 ส่งไม่ได้ (API 422) — บอกให้สลับถ้าช่วยได้ ไม่งั้นรูปแบบผิด
  if (ll && Math.abs(ll.lat) > 90) local.lat = t(swapped ? 'loc.v.llSwap' : 'loc.v.ll');

  const server = fieldErrors(m.error, t);
  for (const [k, v] of Object.entries(server)) {
    const top = k.split('.')[0]!;
    server[top] ??= v;
  }
  if (server.lng && !server.lat) server.lat = server.lng;
  if (server.closeTime && !server.openTime) server.openTime = server.closeTime;
  const errs = { ...(tried ? local : {}), ...server };
  const topErr =
    m.error && !Object.keys(fieldErrors(m.error, t)).length
      ? m.error instanceof ApiError && m.error.problem.code === 'precondition_failed'
        ? t('loc.stale')
        : problemText(m.error, t)
      : null;

  const body = (): SiteCreate => ({
    name: f.name.trim(),
    kind: f.kind,
    customerId: f.cust?.id ?? null,
    address: { ...(site?.address ?? {}), line1: f.addr.trim() },
    lat: ll ? ll.lat : null,
    lng: ll ? ll.lng : null,
    geofenceRadiusM: r,
    maxVehicleClass: f.mx || null,
    openTime: f.open || null,
    closeTime: f.close || null,
    contact: contact,
    aliases: parseAliases(f.aliases),
    serviceTimeMin: svc,
    notes: f.notes.trim() || null,
  });

  /** แก้ไข: ส่งเฉพาะช่องที่เปลี่ยน */
  const diff = (s: Site): SiteInput => {
    const a = toForm(s);
    const b = body();
    const out: SiteInput = {};
    if (a.name !== f.name) out.name = b.name;
    if (a.kind !== f.kind) out.kind = b.kind!;
    if (a.cust?.id !== f.cust?.id) out.customerId = b.customerId ?? null;
    if (a.addr !== f.addr) out.address = b.address;
    if (a.ll !== f.ll) {
      out.lat = b.lat ?? null;
      out.lng = b.lng ?? null;
    }
    if (a.r !== f.r) out.geofenceRadiusM = b.geofenceRadiusM!;
    if (a.mx !== f.mx) out.maxVehicleClass = b.maxVehicleClass ?? null;
    if (a.open !== f.open || a.close !== f.close) {
      out.openTime = b.openTime ?? null;
      out.closeTime = b.closeTime ?? null;
    }
    // คงช่องที่ฟอร์มนี้ไม่มี (เช่น อีเมลที่ตั้งผ่าน API) — แก้ได้แค่ชื่อ/เบอร์
    if (a.ct !== f.ct)
      out.contact = b.contact
        ? { ...(s.contact?.email ? { email: s.contact.email } : {}), ...b.contact }
        : null;
    if (a.aliases !== f.aliases) out.aliases = b.aliases!;
    if (a.svc !== f.svc) out.serviceTimeMin = b.serviceTimeMin ?? null;
    if (a.notes !== f.notes) out.notes = b.notes ?? null;
    if (a.ext !== f.ext) out.externalId = f.ext.trim() || null;
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
    if (site) {
      const d = diff(site);
      if (!Object.keys(d).length) {
        submitting.current = false;
        return onClose();
      }
      const save = (version: number, retried: boolean) =>
        update.mutate(
          { id: site.id, version, body: d },
          {
            ...done,
            onSuccess: (s) => onSaved(s, false),
            onError: (e) => {
              if (retried || !isStale(e)) return;
              // 412 เพราะงาน geocode อัตโนมัติเพิ่งเขียนผล (DM-013 เพิ่ม version) → ข้อมูลที่ผู้ใช้เห็นไม่ได้เปลี่ยน
              // → บันทึกซ้ำด้วย version ล่าสุดเอง · คนอื่นแก้ช่องอื่น → แสดง "ถูกแก้โดยผู้อื่น" ตามเดิม
              void fetchSite(site.id).then(
                (fresh) => {
                  if (onlyGeocodeChanged(site, fresh)) {
                    submitting.current = true;
                    save(fresh.version, true);
                  }
                },
                () => undefined,
              );
            },
          },
        );
      save(site.version, false);
    } else
      create.mutate(
        {
          idempotencyKey: idemKey,
          body: { ...body(), ...(f.ext.trim() ? { externalId: f.ext.trim() } : {}) },
        },
        { ...done, onSuccess: (s) => onSaved(s, true) },
      );
  };

  const input =
    (
      k: Exclude<keyof Form, 'cust'>,
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
  const label = editing ? t('common.save') : t('loc.add');

  return (
    <FormDrawer
      open={open}
      title={editing ? t('loc.edit.title') : t('loc.create.title')}
      subtitle={editing ? site?.code : t('loc.create.sub')}
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
            {label}
          </button>
        </>
      }
    >
      {topErr && <div className="tms-alert">{topErr}</div>}
      <section className="tms-fsec">
        <div className="tms-fgrid tms-fgrid--create">
          <FormField label={t('loc.f.name')} required span={2} error={errs.name}>
            {input('name', { autoFocus: true, maxLength: 150 })}
          </FormField>
          <FormField label={t('loc.f.kind')} required error={errs.kind}>
            {(p) => (
              <select
                {...p}
                className="tms-select"
                style={SEL}
                value={f.kind}
                onChange={(e) => set('kind', e.target.value as SiteKind)}
              >
                {/* ลำดับตามต้นแบบ: ปลายทาง, ต้นทาง, คลัง / ศูนย์กระจาย */}
                {(['DROPOFF', 'PICKUP', 'WAREHOUSE'] as const)
                  .filter((k) => SITE_KINDS.includes(k))
                  .map((k) => (
                    <option key={k} value={k}>
                      {t(`loc.k.${k}` as MessageKey)}
                    </option>
                  ))}
              </select>
            )}
          </FormField>
          <FormField label={t('loc.f.cust')} error={errs.customerId}>
            {(p) => (
              <RefPicker
                id={p.id}
                invalid={p['aria-invalid']}
                queryKey="customers"
                value={f.cust}
                onChange={(v) => set('cust', v)}
                search={searchCustomers}
                clearLabel={t('loc.f.custPick')}
                placeholder={t('table.search')}
                noResult={t('table.emptyTitle')}
              />
            )}
          </FormField>
          <FormField label={t('loc.f.addr')} required span={2} error={errs.address}>
            {(p) => (
              <textarea
                {...p}
                className="tms-textarea"
                style={AREA}
                rows={3}
                placeholder={t('loc.f.addrPh')}
                value={f.addr}
                onChange={(e) => set('addr', e.target.value)}
              />
            )}
          </FormField>
          <FormField
            label={t('loc.f.ll')}
            span={2}
            error={errs.lat}
            hint={
              llWarn
                ? undefined
                : estimated !== null
                  ? t('loc.geo.estimated', { label: estimated })
                  : t('loc.f.llHint')
            }
          >
            {(p) => (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <div style={{ display: 'flex', gap: 8 }}>
                  <TextInput
                    {...p}
                    style={{ flex: 1, minWidth: 0 }}
                    placeholder={t('loc.f.llPh')}
                    value={f.ll}
                    onChange={(e) => {
                      set('ll', e.target.value);
                      setEstimated(null);
                    }}
                    onBlur={() => ll && set('ll', formatLatLng(ll.lat, ll.lng))}
                  />
                  <button
                    type="button"
                    style={{
                      ...PILL,
                      cursor: estimate.isPending ? 'progress' : 'pointer',
                      opacity: estimate.isPending ? 0.7 : 1,
                    }}
                    disabled={estimate.isPending}
                    aria-busy={estimate.isPending}
                    onClick={runEstimate}
                  >
                    <Icon n="map-pin" s={16} />
                    {t('loc.f.geocode')}
                  </button>
                </div>
                <MapBox lat={ll?.lat ?? null} lng={ll?.lng ?? null} offLabel={t('loc.f.mapOff')} />
                {llWarn && (
                  <span className="tms-field-hint" style={{ color: '#8F5500' }}>
                    {errs.lat !== llWarn && llWarn}
                    {swapped && ll && (
                      <button
                        type="button"
                        className="tms-textlink"
                        style={{ marginLeft: errs.lat !== llWarn ? 8 : 0 }}
                        onClick={() => set('ll', formatLatLng(ll.lng, ll.lat))}
                      >
                        {t('loc.v.swap')}
                      </button>
                    )}
                  </span>
                )}
              </div>
            )}
          </FormField>
          <FormField label={t('loc.f.r')} required error={errs.geofenceRadiusM}>
            {input('r', {
              inputMode: 'numeric',
              placeholder: '0',
              style: { textAlign: 'right', fontVariantNumeric: 'tabular-nums' },
            })}
          </FormField>
          <FormField label={t('loc.f.mx')} required error={errs.maxVehicleClass}>
            {(p) => (
              <select
                {...p}
                className="tms-select"
                style={SEL}
                value={f.mx}
                onChange={(e) => set('mx', e.target.value as Form['mx'])}
              >
                {/* ลำดับตามต้นแบบ: 10 ล้อ, 6 ล้อ, พ่วง, เทรลเลอร์ */}
                {(['10W', '6W', 'TRAILER', 'SEMI_TRAILER'] as const)
                  .filter((k) => VEHICLE_CLASSES.includes(k))
                  .map((k) => (
                    <option key={k} value={k}>
                      {t(`loc.vc.${k}` as MessageKey)}
                    </option>
                  ))}
                {f.mx === '' && <option value="">{t('loc.vc.none')}</option>}
              </select>
            )}
          </FormField>
          <FormField label={t('loc.f.hrs')} error={errs.openTime}>
            {(p) => (
              // ต้นแบบแสดงช่องเวลาเดียว — แยกเวลาเปิด/ปิด (ข้ามเที่ยงคืนได้) [OPEN spec/12 §3]
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <TextInput
                  {...p}
                  type="time"
                  aria-label={t('loc.f.open')}
                  style={{ flex: 1, minWidth: 0 }}
                  value={f.open}
                  onChange={(e) => set('open', e.target.value)}
                />
                <span style={{ color: '#59606B' }}>–</span>
                <TextInput
                  type="time"
                  aria-label={t('loc.f.close')}
                  aria-invalid={p['aria-invalid']}
                  style={{ flex: 1, minWidth: 0 }}
                  value={f.close}
                  onChange={(e) => set('close', e.target.value)}
                />
              </div>
            )}
          </FormField>
          <FormField
            label={t('loc.f.ct')}
            error={errs.contact ?? (contact && !contact.name ? t('loc.v.ct') : undefined)}
          >
            {input('ct', { placeholder: t('loc.f.ctPh') })}
          </FormField>
        </div>
      </section>
      <FormSection title={t('loc.sec.extra')}>
        <FormField
          label={t('loc.f.alias')}
          span={2}
          hint={t('loc.f.aliasHint')}
          error={errs.aliases}
        >
          {(p) => (
            <textarea
              {...p}
              className="tms-textarea"
              style={AREA}
              rows={2}
              value={f.aliases}
              onChange={(e) => set('aliases', e.target.value)}
            />
          )}
        </FormField>
        <FormField label={t('loc.f.svc')} hint={t('loc.f.svcHint')} error={errs.serviceTimeMin}>
          {input('svc', {
            inputMode: 'numeric',
            style: { textAlign: 'right', fontVariantNumeric: 'tabular-nums' },
          })}
        </FormField>
        <FormField label={t('loc.f.ext')} error={errs.externalId}>
          {input('ext')}
        </FormField>
        <FormField label={t('loc.f.notes')} span={2} error={errs.notes}>
          {(p) => (
            <textarea
              {...p}
              className="tms-textarea"
              style={AREA}
              rows={2}
              maxLength={1000}
              value={f.notes}
              onChange={(e) => set('notes', e.target.value)}
            />
          )}
        </FormField>
      </FormSection>
      <Toast message={toast} onClose={() => setToast(null)} closeLabel={t('drawer.close')} />
    </FormDrawer>
  );
}

/**
 * กรอบแผนที่ของต้นแบบ (สูง 200, ขอบ #CDD1C8, พื้น #F4F5F2) — ยังไม่มี tile เพราะยังไม่เลือกผู้ให้บริการแผนที่
 * (Q-D3 / spec/12 §3 "แผนที่") · มีพิกัด = แสดงหมุดกลางกรอบ + พิกัด
 */
export function MapBox({
  lat,
  lng,
  offLabel,
  height = 200,
  border = '#CDD1C8',
  background = '#F4F5F2',
}: {
  lat: number | null;
  lng: number | null;
  offLabel: string;
  height?: number;
  border?: string;
  background?: string;
}) {
  return (
    <div
      data-testid="map-placeholder"
      style={{
        position: 'relative',
        height,
        border: `1px solid ${border}`,
        borderRadius: 8,
        overflow: 'hidden',
        background,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 6,
        color: '#59606B',
        fontSize: 12.5,
      }}
    >
      {lat !== null && lng !== null && (
        <>
          <span style={{ color: '#2257C4' }}>
            <Icon n="map-pin" s={28} />
          </span>
          <span className="tms-num" style={{ color: '#101418', fontSize: 13 }}>
            {formatLatLng(lat, lng)}
          </span>
        </>
      )}
      <span>{offLabel}</span>
    </div>
  );
}
