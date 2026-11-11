import { Badge, Drawer, DrawerFooterButtons, EmptyState, Icon, TextInput } from '@tms/ui';
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { ApiError } from '../../api';
import { formatDate, useI18n, type T } from '../../i18n';
import type { MessageKey } from '../../i18n/th';
import { useMe } from '../../shell/AppShell';
import { searchCarriers } from '../carriers/useCarriers';
import { HistoryTab } from '../master/HistoryTab';
import { fieldErrors, isStale, problemText } from '../master/problems';
import { RefPicker, type RefOption } from '../master/RefPicker';
import { vehPlate } from '../vehicles/useVehicles';
import {
  EMPLOYMENT_TYPES,
  LICENCE_ALERT_DAYS,
  LICENCE_CLASSES,
  searchDefaultVehicles,
  useCreateDriver,
  useUpdateDriver,
  type Driver,
  type DriverCreate,
  type DriverInput,
  type DriverStatus,
  type EmploymentType,
  type LicenceClass,
} from './useDrivers';

type Tab = 'sum' | 'score' | 'docs' | 'act';

interface Form {
  name: string;
  phone: string;
  employmentType: EmploymentType;
  licenceClass: LicenceClass | '';
  licenceExpiresOn: string;
  carrier: RefOption | null;
  vehicle: RefOption | null;
  status: DriverStatus;
  /** แก้รายการที่มีเลขแล้ว: ว่าง = คงเลขเดิม (เลขเต็มไม่ส่งมาที่หน้าจอ) */
  nationalId: string;
  licenceNo: string;
}

/** ค่าเริ่มต้นของคนขับใหม่ตามต้นแบบ (พขร.มีเงินเดือน, ท.2, พร้อมใช้) — วันหมดอายุไม่เดา (ต้องกรอก) */
const EMPTY: Form = {
  name: '',
  phone: '',
  employmentType: 'EMPLOYEE_SALARIED',
  licenceClass: 'T2',
  licenceExpiresOn: '',
  carrier: null,
  vehicle: null,
  status: 'active',
  nationalId: '',
  licenceNo: '',
};

function toForm(d: Driver, t: T): Form {
  return {
    name: d.name,
    phone: d.phone,
    employmentType: d.employmentType,
    licenceClass: d.licenceClass ?? '',
    licenceExpiresOn: d.licenceExpiresOn ?? '',
    carrier: d.carrier
      ? { id: d.carrier.id, label: d.carrier.legalName, sub: d.carrier.code }
      : null,
    vehicle: d.defaultVehicle
      ? {
          id: d.defaultVehicle.id,
          label: vehPlate(t, d.defaultVehicle),
          sub: d.defaultVehicle.vehicleTypeName,
        }
      : null,
    status: d.status,
    nationalId: '',
    licenceNo: d.licenceNo ?? '',
  };
}

const digits = (s: string) => s.replace(/[\s-]/g, '');
const DATE_MIN = '2000-01-01';
const DATE_MAX = '2100-12-31';

/** เลขบัตร 13 หลัก check digit (mod 11) — เหมือน API (IsThaiTaxId) */
function validNid(v: string): boolean {
  if (!/^[1-8]\d{12}$/.test(v)) return false;
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += Number(v[i]) * (13 - i);
  return (11 - (sum % 11)) % 10 === Number(v[12]);
}
/** เบอร์ไทย (ตัด +66/ขีด/ช่องว่าง) — เหมือน phoneNorm ของ API */
function phoneOk(v: string): boolean {
  if (!/^(\+66|0)[0-9 -]{8,16}$/.test(v.trim())) return false;
  const d = v.replace(/\D/g, '');
  const n =
    d.startsWith('66') && d.length >= 10 ? (d[2] === '0' ? d.slice(2) : `0${d.slice(2)}`) : d;
  // มือถือ 0[689] + 8 หลัก · บ้าน/สำนักงาน 0[2-7] + 7 หลัก
  return /^0[689]\d{8}$/.test(n) || /^0[2-7]\d{7}$/.test(n);
}

/** ค่าที่แสดงแทนเลขลับ (spec/11 NFR-304) */
export const masked = (last4: string | null | undefined) => (last4 ? `•••• ${last4}` : '—');
export const typeLabel = (t: T, e: EmploymentType) => t(`drv.type.${e}`);
export const licLabel = (t: T, c: string | null | undefined) =>
  c ? t(`vt.lic.${c as LicenceClass}`) : '—';

/** ป้ายใบขับขี่ในตาราง/drawer — ต้นแบบ: หมดแล้ว = "หมดอายุ", เหลือ < 30 วัน = "ใกล้หมดอายุ" */
export function licenceAlert(d: Pick<Driver, 'licenceDaysToExpiry'>): 'expired' | 'soon' | null {
  const n = d.licenceDaysToExpiry;
  if (n === null || n === undefined) return null;
  if (n < 0) return 'expired';
  return n < LICENCE_ALERT_DAYS ? 'soon' : null;
}

/** "YYYY-MM-DD" → "31 มี.ค. 2571" */
export function dayText(
  iso: string | null | undefined,
  lang: Parameters<typeof formatDate>[1],
  ys: 'BE' | 'CE',
) {
  return iso ? formatDate(new Date(`${iso}T00:00:00`), lang, ys) : '—';
}

const BADGE: Record<DriverStatus, MessageKey> = {
  active: 'drv.st.active',
  on_leave: 'drv.st.on_leave',
  inactive: 'drv.st.inactive',
};
export function DriverBadge({ d, t }: { d: Pick<Driver, 'status'> | null; t: T }) {
  if (!d) return <Badge label={t('car.st.draft')} />;
  return <Badge label={t(BADGE[d.status])} />;
}

/** ช่องใน drawer (label 12.5/500 + input 36px — ต้นแบบ this.fld()) */
function Fld({
  label,
  span = 1,
  error,
  hint,
  children,
}: {
  label: ReactNode;
  span?: 1 | 2;
  error?: string | undefined;
  hint?: ReactNode;
  children: (id: string) => ReactNode;
}) {
  const id = useId();
  return (
    <div className="tms-ffield" style={{ gridColumn: `span ${span}` }}>
      <label htmlFor={id} className="tms-label">
        {label}
      </label>
      {children(id)}
      {error ? (
        <span className="tms-field-error">{error}</span>
      ) : hint ? (
        <span className="tms-field-hint">{hint}</span>
      ) : null}
    </div>
  );
}

/** ข้อความ error ของช่องรถประจำ/ผู้รับเหมาที่เฉพาะคนขับ (code ร่วมกับ master อื่นแต่ความหมายต่าง) */
const VEH_ERR: Record<string, MessageKey> = {
  vehicle_retired: 'drv.v.vehRetired',
  vehicle_trailer: 'drv.v.vehTrailer',
  vehicle_other_carrier: 'drv.v.vehOtherCarrier',
  vehicle_not_own: 'drv.v.vehNotOwn',
};

/**
 * Drawer คนขับ — ต้นแบบ vPanel drv: หัว "คนขับ · {ประเภท}" / "เพิ่มคนขับใหม่", แท็บ ข้อมูลคนขับ / คะแนนการขับขี่ / เอกสารแนบ / กิจกรรม
 * ฟอร์มตามลำดับต้นแบบ (ชื่อ-นามสกุล, เบอร์โทร, ประเภท, ประเภทใบขับขี่, ใบขับขี่หมดอายุ, สังกัด, รถประจำ, สถานะ) + กล่องเตือนใบขับขี่ < 30 วัน
 * ปุ่ม "บันทึก" เดียว (สร้าง = POST + Idempotency-Key, แก้ = PATCH + If-Match) · เปลี่ยนสถานะ → dialog เหตุผล (POST /status)
 * ส่วนที่ต้นแบบไม่มี [OPEN spec/12 §3]: "ข้อมูลเพิ่มเติม" (เลขบัตรประชาชน — เข้ารหัส แสดง •••• 1234, เลขที่ใบขับขี่),
 * สถานะ "ปิดใช้งาน" · สังกัดของคนขับรถร่วม = เลือกผู้รับเหมา (ต้นแบบเป็นช่องข้อความ) · คะแนนการขับขี่ = P2 (แสดงสถานะว่างของต้นแบบ)
 * เอกสารแนบ (รูปใบขับขี่/บัตร) ยังไม่มีที่เก็บต่อคนขับ
 */
export function DriverDrawer({
  driver: d,
  canWrite,
  tenantName,
  onSaved,
  onStatusChange,
  onDelete,
  onClose,
}: {
  /** null = เพิ่มคนขับใหม่ */
  driver: Driver | null;
  canWrite: boolean;
  tenantName: string;
  onSaved: (d: Driver, created: boolean) => void;
  onStatusChange: (d: Driver, to: DriverStatus) => void;
  onDelete: () => void;
  onClose: () => void;
}) {
  const { t, lang } = useI18n();
  const me = useMe();
  const isNew = !d;
  const [tab, setTab] = useState<Tab>('sum');
  const [base, setBase] = useState<Form>(() => (d ? toForm(d, t) : EMPTY));
  const [baseVersion, setBaseVersion] = useState(d?.version ?? 0);
  const [f, setF] = useState<Form>(base);
  const [tried, setTried] = useState(false);
  const [idemKey, setIdemKey] = useState(() => crypto.randomUUID());
  const submitting = useRef(false);
  const create = useCreateDriver();
  const update = useUpdateDriver();
  const m = isNew ? create : update;
  const set = <K extends keyof Form>(k: K, v: Form[K]) => setF((x) => ({ ...x, [k]: v }));
  const ro = !canWrite || d?.status === 'inactive';
  const sub = f.employmentType === 'CARRIER_DRIVER';
  const stale = !!d && d.version !== baseVersion;

  // ---------- ตรวจในฟอร์ม ----------
  const local: Record<string, string> = {};
  if (!f.name.trim()) local.name = t('drv.v.name');
  if (!f.phone.trim()) local.phone = t('drv.v.phone');
  else if (!phoneOk(f.phone)) local.phone = t('drv.v.phoneBad');
  if (!f.licenceClass) local.licenceClass = t('drv.v.licClass');
  if (!f.licenceExpiresOn) local.licenceExpiresOn = t('drv.v.licExp');
  else if (f.licenceExpiresOn < DATE_MIN || f.licenceExpiresOn > DATE_MAX)
    local.licenceExpiresOn = t('drv.v.licExpRange');
  if (sub && !f.carrier) local.carrierId = t('drv.v.carrier');
  const nid = digits(f.nationalId);
  if (nid && !validNid(nid)) local.nationalId = t('drv.v.nid');
  if (f.licenceNo.trim() && !/^[0-9A-Za-z][0-9A-Za-z\-/. ]{0,29}$/.test(f.licenceNo.trim()))
    local.licenceNo = t('drv.v.licNo');

  const server = fieldErrors(m.error, t);
  const errs0 = m.error instanceof ApiError ? (m.error.problem.errors ?? []) : [];
  for (const e of errs0)
    if (e.field === 'defaultVehicleId' && VEH_ERR[e.code])
      server.defaultVehicleId = t(VEH_ERR[e.code]!);
  const dup =
    m.error instanceof ApiError && m.error.problem.code === 'duplicate'
      ? (m.error.problem as { existing?: { code: string; name: string } }).existing
      : undefined;
  // เลขบัตรซ้ำโดยผู้ไม่มีสิทธิ์ดูเลขเต็ม: API ไม่บอกว่าเป็นของใคร
  if (!dup && errs0.some((e) => e.field === 'nationalId' && e.code === 'duplicate'))
    server.nationalId = t('drv.v.dupNidAnon');
  if (dup) {
    const fld = errs0[0]?.field;
    if (fld === 'phone') server.phone = t('drv.v.dupPhone', { code: dup.code, name: dup.name });
    if (fld === 'nationalId')
      server.nationalId = t('drv.v.dupNid', { code: dup.code, name: dup.name });
  }
  const errs = { ...(tried ? local : {}), ...server };
  const top =
    m.error && !Object.keys(server).length && !isStale(m.error) ? problemText(m.error, t) : null;

  const body = (): DriverCreate => ({
    name: f.name.trim(),
    phone: f.phone.trim(),
    employmentType: f.employmentType,
    licenceClass: f.licenceClass as LicenceClass,
    licenceExpiresOn: f.licenceExpiresOn,
    carrierId: sub ? (f.carrier?.id ?? null) : null,
    defaultVehicleId: f.vehicle?.id ?? null,
    ...(nid ? { nationalId: nid } : {}),
    licenceNo: f.licenceNo.trim() || null,
  });
  /** แก้ไข: ส่งเฉพาะช่องที่เปลี่ยน (สถานะไปทาง POST /status ไม่อยู่ใน PATCH) */
  const diff = (): DriverInput => {
    const a = base;
    const b = body();
    const out: DriverInput = {};
    if (a.name !== f.name) out.name = b.name;
    if (a.phone !== f.phone) out.phone = b.phone;
    if (a.employmentType !== f.employmentType) out.employmentType = b.employmentType;
    if (a.licenceClass !== f.licenceClass) out.licenceClass = b.licenceClass;
    if (a.licenceExpiresOn !== f.licenceExpiresOn) out.licenceExpiresOn = b.licenceExpiresOn;
    if (a.employmentType !== f.employmentType || (a.carrier?.id ?? '') !== (f.carrier?.id ?? ''))
      out.carrierId = b.carrierId ?? null;
    if ((a.vehicle?.id ?? '') !== (f.vehicle?.id ?? ''))
      out.defaultVehicleId = b.defaultVehicleId ?? null;
    if (nid) out.nationalId = nid;
    if (a.licenceNo !== f.licenceNo) out.licenceNo = b.licenceNo ?? null;
    return out;
  };

  const reload = () => {
    if (!d) return;
    const nf = toForm(d, t);
    setBase(nf);
    setF(nf);
    setBaseVersion(d.version);
    update.reset();
  };
  const dirty = d ? Object.keys(diff()).length > 0 : true;
  // ถูกแก้ (เปลี่ยนสถานะ/ผู้อื่นแก้) ระหว่างที่ฟอร์มยังไม่ได้แก้ → โหลดค่าใหม่เงียบ ๆ
  useEffect(() => {
    if (d && d.version !== baseVersion && !dirty) reload();
  }, [d?.version]);

  const submit = () => {
    setTried(true);
    if (Object.keys(local).length || submitting.current || stale) return;
    const done = {
      onError: () => setIdemKey(crypto.randomUUID()),
      onSettled: () => {
        submitting.current = false;
      },
    };
    if (!d) {
      submitting.current = true;
      create.mutate(
        { idempotencyKey: idemKey, body: body() },
        { ...done, onSuccess: (u) => onSaved(u, true) },
      );
      return;
    }
    const statusChanged = f.status !== d.status;
    const df = diff();
    if (!Object.keys(df).length) {
      if (statusChanged) onStatusChange(d, f.status);
      return;
    }
    submitting.current = true;
    update.mutate(
      { id: d.id, version: baseVersion, body: df },
      {
        ...done,
        onSuccess: (u) => {
          const nf = { ...toForm(u, t), status: f.status };
          setBase({ ...nf, status: u.status });
          setF(nf);
          setBaseVersion(u.version);
          onSaved(u, false);
          if (statusChanged) onStatusChange(u, f.status);
        },
      },
    );
  };

  const ys = (me.data?.tenant.yearStyle as 'BE' | 'CE') ?? 'BE';
  const alert = d && d.status !== 'inactive' ? licenceAlert(d) : null;
  const text = (
    k: 'name' | 'phone' | 'nationalId' | 'licenceNo',
    extra: Partial<React.InputHTMLAttributes<HTMLInputElement>> = {},
  ) =>
    function Inp(id: string) {
      return (
        <TextInput
          id={id}
          readOnly={ro}
          aria-invalid={!!errs[k]}
          {...extra}
          value={f[k]}
          onChange={(e) => set(k, e.target.value)}
        />
      );
    };

  return (
    <Drawer
      open
      onClose={onClose}
      kind={d ? t('drv.kindOf', { k: typeLabel(t, d.employmentType) }) : t('drv.new.kind')}
      title={d ? d.name : t('drv.new.title')}
      badge={<DriverBadge d={d} t={t} />}
      labels={{ close: t('drawer.close'), more: t('drawer.more') }}
      {...(canWrite && d
        ? {
            menu: [
              { label: t('drv.menu.delete'), icon: 'trash-2', danger: true, onClick: onDelete },
            ],
          }
        : {})}
      tabs={[
        { key: 'sum', label: t('drv.tab.sum') },
        { key: 'score', label: t('drv.tab.score') },
        { key: 'docs', label: t('car.tab.docs') },
        { key: 'act', label: t('car.tab.act') },
      ]}
      tab={tab}
      onTab={(k) => setTab(k as Tab)}
      footer={
        canWrite && tab === 'sum' ? (
          <DrawerFooterButtons
            primary={{
              label: t('common.save'),
              icon: 'save',
              onClick: submit,
              disabled: m.isPending,
            }}
          />
        ) : undefined
      }
    >
      {(stale || isStale(m.error)) && (
        <div className="tms-alert" style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <span style={{ flex: 1 }}>{t('drv.stale')}</span>
          <button type="button" className="tms-textlink" onClick={reload}>
            {t('car.reload')}
          </button>
        </div>
      )}
      {tried && Object.keys(local).length > 0 && (
        <div className="tms-alert">{t('form.incomplete', { n: Object.keys(local).length })}</div>
      )}
      {top && <div className="tms-alert">{top}</div>}
      {tab === 'sum' && (
        <>
          {alert && (
            <div
              role="note"
              style={{
                background: '#FCF0DC',
                borderRadius: 8,
                padding: '10px 14px',
                display: 'flex',
                gap: 8,
              }}
            >
              <Icon
                n="triangle-alert"
                s={16}
                style={{ color: '#8F5500', marginTop: 3, flexShrink: 0 }}
              />
              <span>
                {t(alert === 'expired' ? 'drv.warn.expired' : 'drv.warn.soon', {
                  d: dayText(d!.licenceExpiresOn, lang, ys),
                })}
              </span>
            </div>
          )}
          <div className="tms-fgrid">
            <Fld label={t('drv.f.name')} span={2} error={errs.name}>
              {text('name', { maxLength: 200, autoFocus: isNew })}
            </Fld>
            <Fld label={t('drv.f.phone')} error={errs.phone}>
              {text('phone', { maxLength: 20, inputMode: 'tel', className: 'tms-num' })}
            </Fld>
            <Fld label={t('drv.f.type')} error={errs.employmentType}>
              {(id) => (
                <select
                  id={id}
                  className="tms-select"
                  disabled={ro}
                  value={f.employmentType}
                  onChange={(e) => {
                    const v = e.target.value as EmploymentType;
                    // เปลี่ยนประเภท (บริษัท ↔ รถร่วม) → รถประจำเดิมไม่ตรงเจ้าของแล้ว ล้างให้เลือกใหม่
                    setF((x) => {
                      const flip =
                        (v === 'CARRIER_DRIVER') !== (x.employmentType === 'CARRIER_DRIVER');
                      return {
                        ...x,
                        employmentType: v,
                        ...(flip ? { vehicle: null, carrier: null } : {}),
                      };
                    });
                  }}
                >
                  {EMPLOYMENT_TYPES.map((e) => (
                    <option key={e} value={e}>
                      {typeLabel(t, e)}
                    </option>
                  ))}
                </select>
              )}
            </Fld>
            <Fld label={t('drv.f.licClass')} error={errs.licenceClass}>
              {(id) => (
                <select
                  id={id}
                  className="tms-select"
                  disabled={ro}
                  aria-invalid={!!errs.licenceClass}
                  value={f.licenceClass}
                  onChange={(e) => set('licenceClass', e.target.value as LicenceClass)}
                >
                  {LICENCE_CLASSES.map((c) => (
                    <option key={c} value={c}>
                      {licLabel(t, c)}
                    </option>
                  ))}
                </select>
              )}
            </Fld>
            <Fld label={t('drv.f.licExp')} error={errs.licenceExpiresOn}>
              {(id) => (
                <input
                  id={id}
                  type="date"
                  min={DATE_MIN}
                  max={DATE_MAX}
                  className="tms-input"
                  readOnly={ro}
                  aria-invalid={!!errs.licenceExpiresOn}
                  value={f.licenceExpiresOn}
                  onChange={(e) => set('licenceExpiresOn', e.target.value)}
                />
              )}
            </Fld>
            <Fld label={t('drv.f.aff')} error={errs.carrierId}>
              {(id) =>
                sub ? (
                  <RefPicker
                    id={id}
                    value={f.carrier}
                    onChange={(v) => setF((x) => ({ ...x, carrier: v, vehicle: null }))}
                    search={(q) => searchCarriers(q)}
                    queryKey="drivers-carrier"
                    placeholder={t('drv.f.affPh')}
                    noResult={t('car.f.parentNone')}
                    invalid={!!errs.carrierId}
                    disabled={ro}
                    style={{ height: 36 }}
                  />
                ) : (
                  <TextInput id={id} readOnly value={tenantName} />
                )
              }
            </Fld>
            <Fld label={t('drv.f.veh')} error={errs.defaultVehicleId}>
              {(id) => (
                <RefPicker
                  id={id}
                  value={f.vehicle}
                  onChange={(v) => set('vehicle', v)}
                  search={(q) =>
                    searchDefaultVehicles(q, t, f.employmentType, f.carrier?.id ?? null)
                  }
                  queryKey={`drivers-veh-${f.employmentType === 'CARRIER_DRIVER' ? (f.carrier?.id ?? 'none') : 'own'}`}
                  placeholder="—"
                  noResult={t('drv.f.vehNone')}
                  clearLabel="—"
                  invalid={!!errs.defaultVehicleId}
                  disabled={ro || (sub && !f.carrier)}
                  style={{ height: 36 }}
                />
              )}
            </Fld>
            <Fld label={t('drv.f.status')}>
              {(id) => (
                <select
                  id={id}
                  className="tms-select"
                  disabled={!canWrite || isNew}
                  value={f.status}
                  onChange={(e) => set('status', e.target.value as DriverStatus)}
                >
                  {(d?.status === 'inactive'
                    ? (['inactive', 'active'] as DriverStatus[])
                    : (['active', 'on_leave', 'inactive'] as DriverStatus[])
                  ).map((s) => (
                    <option key={s} value={s}>
                      {t(BADGE[s])}
                    </option>
                  ))}
                </select>
              )}
            </Fld>
          </div>
          <section className="tms-kv" style={{ borderBottom: 0, paddingBottom: 0 }}>
            <span className="tms-kv__title">{t('car.sec.extra')}</span>
          </section>
          <div className="tms-fgrid">
            <Fld
              label={t('drv.f.nid')}
              error={errs.nationalId}
              hint={d?.nationalIdLast4 && !ro ? t('drv.f.nidKeep') : undefined}
            >
              {text('nationalId', {
                inputMode: 'numeric',
                maxLength: 17,
                className: 'tms-num',
                autoComplete: 'off',
                ...(d?.nationalIdLast4 ? { placeholder: masked(d.nationalIdLast4) } : {}),
              })}
            </Fld>
            <Fld label={t('drv.f.licNo')} error={errs.licenceNo}>
              {text('licenceNo', { maxLength: 30, className: 'tms-num' })}
            </Fld>
            {d && (
              <Fld label={t('car.k.code')}>
                {(id) => <TextInput id={id} readOnly value={d.code} className="tms-num" />}
              </Fld>
            )}
          </div>
        </>
      )}
      {tab === 'score' && (
        <EmptyState icon="gauge" title={t('drv.score.empty')} description={t('drv.score.emptyD')} />
      )}
      {tab === 'docs' && (
        <EmptyState
          icon="file-text"
          title={t('car.docs.empty')}
          description={t('drv.docs.emptyD')}
        />
      )}
      {tab === 'act' &&
        (d ? (
          <HistoryTab
            path="/v1/drivers/{id}/history"
            id={d.id}
            fieldLabel={(k) => fieldLabel(t, k)}
            fieldValue={(k, v) => fieldValue(t, k, v)}
          />
        ) : (
          <EmptyState icon="history" title={t('car.act.empty')} description="" />
        ))}
    </Drawer>
  );
}

const FIELD_KEYS: Record<string, MessageKey> = {
  name: 'drv.f.name',
  code: 'car.k.code',
  phone: 'drv.f.phone',
  employmentType: 'drv.f.type',
  licenceClass: 'drv.f.licClass',
  licenceExpiresOn: 'drv.f.licExp',
  licenceNo: 'drv.f.licNo',
  nationalId: 'drv.f.nid',
  carrierId: 'drv.f.aff',
  defaultVehicleId: 'drv.f.veh',
  status: 'drv.f.status',
  statusReason: 'car.dlg.reason',
  externalId: 'car.f.ext',
};
function fieldLabel(t: T, k: string): string {
  const key = FIELD_KEYS[k];
  return key ? t(key) : k;
}
function fieldValue(t: T, k: string, v: unknown): string | undefined {
  if (v === null || v === undefined) return undefined;
  if (k === 'status') return t(BADGE[v as DriverStatus] ?? 'drv.st.active');
  if (k === 'employmentType') return typeLabel(t, v as EmploymentType);
  if (k === 'licenceClass') return licLabel(t, String(v));
  return undefined;
}
