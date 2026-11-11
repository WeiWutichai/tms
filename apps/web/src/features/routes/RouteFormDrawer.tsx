import { FormDrawer, FormField, FormSection, Icon, TextInput } from '@tms/ui';
import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { ApiError } from '../../api';
import { useI18n } from '../../i18n';
import { RefPicker, type RefOption } from '../master/RefPicker';
import { fieldErrors, isStale, problemText } from '../master/problems';
import {
  searchSites,
  useCreateRoute,
  useRouteEstimate,
  useUpdateRoute,
  type Route,
  type RouteCreate,
  type RouteInput,
} from './useRoutes';

interface Form {
  origin: RefOption | null;
  dest: RefOption | null;
  km: string;
  min: string;
  toll: string;
  notes: string;
  ext: string;
}

const EMPTY: Form = { origin: null, dest: null, km: '', min: '', toll: '', notes: '', ext: '' };

const opt = (s: Route['origin']): RefOption => ({ id: s.id, label: s.name, sub: s.code });
function toForm(r: Route): Form {
  return {
    origin: opt(r.origin),
    dest: opt(r.destination),
    km: String(r.distanceKm),
    min: r.standardMinutes === null ? '' : String(r.standardMinutes),
    toll: r.tollAmount ?? '',
    notes: r.notes ?? '',
    ext: r.externalId ?? '',
  };
}

/** สไตล์ช่องของฟอร์มต้นแบบ (cfOpen: สูง 40, ขอบ #CDD1C8) และปุ่มรอง "ประมาณจากที่อยู่" ของฟอร์มสถานที่ */
const SEL: CSSProperties = { height: 40, borderColor: '#CDD1C8', width: '100%' };
const AREA: CSSProperties = { padding: '8px 12px', borderColor: '#CDD1C8', width: '100%' };
const NUM = { textAlign: 'right', fontVariantNumeric: 'tabular-nums' } as const;
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
const KM_RE = /^\d{1,7}(\.\d)?$/;
const MONEY_RE = /^\d{1,12}(\.\d{1,2})?$/;

/**
 * "เพิ่มเส้นทาง" / "แก้ไขเส้นทาง" — ต้นแบบไม่มีฟอร์มนี้ [OPEN spec/12 §3] → แบบเดียวกับฟอร์มสถานที่/ประเภทรถ (cfOpen)
 * ต้นทาง/ปลายทางเลือกจากสถานที่ (ค้นหาได้) · ระยะทางกรอกเอง หรือ "คำนวณจากพิกัด" แล้วตรวจก่อนบันทึก
 */
export function RouteFormDrawer({
  open,
  route,
  onClose,
  onSaved,
  onActivateExisting,
}: {
  open: boolean;
  /** มีค่า = แก้ไข */
  route?: Route | null;
  onClose: () => void;
  onSaved: (r: Route, created: boolean) => void;
  /** คู่ซ้ำกับเส้นทางที่ปิดใช้อยู่ → ปุ่ม "เปิดใช้เส้นทางเดิม" (หน้ารายการเปิดใช้แล้วเปิด drawer) */
  onActivateExisting?: (id: string) => void;
}) {
  const { t } = useI18n();
  const editing = !!route;
  const create = useCreateRoute();
  const update = useUpdateRoute();
  const estimate = useRouteEstimate();
  const m = editing ? update : create;
  const [f, setF] = useState<Form>(EMPTY);
  const [tried, setTried] = useState(false);
  const [estMsg, setEstMsg] = useState<{ text: string; warn: boolean } | null>(null);
  const [idemKey, setIdemKey] = useState(() => crypto.randomUUID());
  const submitting = useRef(false);
  // ล้างฟอร์มตั้งแต่ render แรกที่เปิด (ไม่รอ effect) — กันค่าเก่าค้าง (QA ST2-T04/T05)
  const openKey = open ? (route?.id ?? 'new') : null;
  const [shownFor, setShownFor] = useState<string | null>(null);
  if (openKey !== shownFor) {
    setShownFor(openKey);
    if (openKey !== null) {
      setF(route ? toForm(route) : EMPTY);
      setTried(false);
      setEstMsg(null);
    }
  }
  useEffect(() => {
    if (open) {
      setIdemKey(crypto.randomUUID());
      submitting.current = false;
      create.reset();
      update.reset();
      estimate.reset();
    }
  }, [open, route?.id]);

  const set = <K extends keyof Form>(k: K, v: Form[K]) => setF((x) => ({ ...x, [k]: v }));

  // ---------- ตรวจในฟอร์ม ----------
  const local: Record<string, string> = {};
  if (!f.origin) local.originId = t('rt.v.origin');
  if (!f.dest) local.destinationId = t('rt.v.dest');
  else if (f.origin && f.origin.id === f.dest.id) local.destinationId = t('rt.v.same');
  const km = KM_RE.test(f.km.trim()) ? Number(f.km) : NaN;
  if (!(km > 0)) local.distanceKm = t('rt.v.km');
  const min = f.min.trim() === '' ? null : /^\d{1,5}$/.test(f.min.trim()) ? Number(f.min) : NaN;
  if (min !== null && !(min >= 1 && min <= 10080)) local.standardMinutes = t('rt.v.min');
  const toll = f.toll.trim() === '' ? null : f.toll.trim().replace(/,/g, '');
  if (toll !== null && !MONEY_RE.test(toll)) local.tollAmount = t('rt.v.toll');

  const server = fieldErrors(m.error, t);
  const dupErr =
    m.error instanceof ApiError && m.error.problem.code === 'duplicate'
      ? (m.error.problem as { existing?: { id?: string; code?: string; status?: string } }).existing
      : undefined;
  const dupOff = dupErr?.status === 'inactive';
  if (dupErr?.code)
    server.destinationId = t(dupOff ? 'rt.v.dupOff' : 'rt.v.dup', { c: dupErr.code });
  const errs = { ...(tried ? local : {}), ...server };
  const topErr =
    m.error && !Object.keys(server).length
      ? isStale(m.error)
        ? t('rt.stale')
        : problemText(m.error, t)
      : null;

  const body = (): RouteCreate => ({
    originId: f.origin!.id,
    destinationId: f.dest!.id,
    distanceKm: km,
    standardMinutes: min,
    tollAmount: toll,
    notes: f.notes.trim() || null,
    ...(f.ext.trim() ? { externalId: f.ext.trim() } : {}),
  });
  /** แก้ไข: ส่งเฉพาะช่องที่เปลี่ยน */
  const diff = (r: Route): RouteInput => {
    const a = toForm(r);
    const b = body();
    const out: RouteInput = {};
    if (a.origin?.id !== f.origin?.id) out.originId = b.originId;
    if (a.dest?.id !== f.dest?.id) out.destinationId = b.destinationId;
    if (a.km !== f.km) out.distanceKm = b.distanceKm;
    if (a.min !== f.min) out.standardMinutes = b.standardMinutes ?? null;
    if (a.toll !== f.toll) out.tollAmount = b.tollAmount ?? null;
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
    if (route) {
      const d = diff(route);
      if (!Object.keys(d).length) {
        submitting.current = false;
        return onClose();
      }
      update.mutate(
        { id: route.id, version: route.version, body: d },
        { ...done, onSuccess: (r) => onSaved(r, false) },
      );
    } else
      create.mutate(
        { idempotencyKey: idemKey, body: body() },
        { ...done, onSuccess: (r) => onSaved(r, true) },
      );
  };

  /** "คำนวณจากพิกัด" — เติมระยะทาง (และเวลา ถ้ายังว่าง) ให้ผู้ใช้ตรวจก่อนบันทึก */
  const runEstimate = () => {
    if (!f.origin || !f.dest || f.origin.id === f.dest.id)
      return setEstMsg({ text: t('rt.est.pick'), warn: true });
    estimate.mutate(
      { originId: f.origin.id, destinationId: f.dest.id },
      {
        onSuccess: (r) => {
          if (r.result === 'ok' && r.distanceKm !== null) {
            const kmV = String(r.distanceKm);
            setF((x) => ({
              ...x,
              km: kmV,
              min: x.min.trim() === '' && r.standardMinutes ? String(r.standardMinutes) : x.min,
            }));
            setEstMsg({ text: t('rt.est.ok', { km: kmV }), warn: false });
          } else
            setEstMsg({
              text: t(r.result === 'no_coords' ? 'rt.est.noCoords' : 'rt.est.unavailable'),
              warn: true,
            });
        },
        onError: (e) => setEstMsg({ text: problemText(e, t) ?? '', warn: true }),
      },
    );
  };

  const input =
    (
      k: 'km' | 'min' | 'toll' | 'ext',
      extra: Partial<React.InputHTMLAttributes<HTMLInputElement>> = {},
    ) =>
    (p: { id: string; 'aria-invalid': boolean }) => (
      <TextInput
        {...p}
        {...extra}
        value={f[k]}
        onChange={(e) => {
          const v = e.target.value;
          setF((x) => ({ ...x, [k]: v }));
          if (k === 'km') setEstMsg(null);
        }}
      />
    );
  const sitePicker = (k: 'origin' | 'dest') => (p: { id: string; 'aria-invalid': boolean }) => (
    <RefPicker
      id={p.id}
      invalid={p['aria-invalid']}
      queryKey="route-sites"
      value={f[k]}
      onChange={(v) => {
        set(k, v);
        setEstMsg(null);
        // เปลี่ยนต้นทาง/ปลายทาง = ข้อความ "มีเส้นทางนี้แล้ว" ของคู่เดิมไม่ใช้แล้ว (review ST2-T09)
        create.reset();
        update.reset();
      }}
      search={searchSites}
      placeholder={t('rt.f.pick')}
      noResult={t('table.emptyTitle')}
      style={SEL}
    />
  );

  return (
    <FormDrawer
      open={open}
      title={editing ? t('rt.edit.title') : t('rt.create.title')}
      subtitle={editing ? route?.code : t('rt.create.sub')}
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
            {editing ? t('common.save') : t('rt.add')}
          </button>
        </>
      }
    >
      {topErr && <div className="tms-alert">{topErr}</div>}
      <section className="tms-fsec">
        <div className="tms-fgrid tms-fgrid--create">
          <FormField label={t('rt.f.origin')} required span={2} error={errs.originId}>
            {sitePicker('origin')}
          </FormField>
          <FormField label={t('rt.f.dest')} required span={2} error={errs.destinationId}>
            {(p) => (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {sitePicker('dest')(p)}
                {dupOff && dupErr?.id && onActivateExisting && (
                  <button
                    type="button"
                    className="tms-textlink"
                    style={{ alignSelf: 'flex-start' }}
                    onClick={() => onActivateExisting(dupErr.id!)}
                  >
                    {t('rt.openExisting')}
                  </button>
                )}
              </div>
            )}
          </FormField>
          <FormField
            label={t('rt.f.km')}
            required
            span={2}
            error={errs.distanceKm}
            hint={estMsg && !estMsg.warn ? estMsg.text : t('rt.f.kmHint')}
          >
            {(p) => (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <div style={{ display: 'flex', gap: 8 }}>
                  {input('km', {
                    inputMode: 'decimal',
                    placeholder: '0',
                    style: { ...NUM, flex: 1, minWidth: 0 },
                  })(p)}
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
                    <Icon n="route" s={16} />
                    {t('rt.estimate')}
                  </button>
                </div>
                {estMsg?.warn && (
                  <span className="tms-field-hint" role="status" style={{ color: '#8F5500' }}>
                    {estMsg.text}
                  </span>
                )}
              </div>
            )}
          </FormField>
          <FormField label={t('rt.f.min')} error={errs.standardMinutes}>
            {input('min', { inputMode: 'numeric', placeholder: '0', style: NUM })}
          </FormField>
          <FormField label={t('rt.f.toll')} error={errs.tollAmount}>
            {input('toll', { inputMode: 'decimal', placeholder: '0.00', style: NUM })}
          </FormField>
        </div>
      </section>
      <FormSection title={t('rt.sec.extra')}>
        <FormField label={t('rt.f.ext')} error={errs.externalId}>
          {input('ext')}
        </FormField>
        <FormField label={t('rt.f.notes')} span={2} error={errs.notes}>
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
    </FormDrawer>
  );
}
