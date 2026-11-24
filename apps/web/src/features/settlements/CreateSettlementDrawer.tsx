import { FormDrawer, FormField, FormSection, Icon, TextInput } from '@tms/ui';
import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { useI18n } from '../../i18n';
import type { MessageKey } from '../../i18n/th';
import { problemText } from '../master/problems';
import { money, useDateText } from '../rate-cards/rateFormat';
import { fromSatang, parseCost, toSatang } from '../trips/subconHire';
import {
  useCreateSettlement,
  useSettlementQueue,
  type SettlementQueueTrip,
} from './useSettlements';

const DEDUCTION_TYPES = ['CASH_ADVANCE', 'FUEL_PROVIDED', 'FINE', 'DAMAGE'] as const;
type DeductionType = (typeof DEDUCTION_TYPES)[number];
interface Deduction {
  key: number;
  type: DeductionType;
  description: string;
  amount: string;
  reference: string;
}

/** ค่าเดียวกับตารางคิววางบิลของหน้า `bill` (ต้นแบบ TMS v4 ส่วน "ออกใบแจ้งหนี้จาก DO ที่ส่งแล้ว") */
const TH: CSSProperties = {
  height: 40,
  padding: '4px 8px',
  textAlign: 'left',
  fontWeight: 600,
  fontSize: 13,
  lineHeight: 1.3,
  color: '#3B424C',
  background: '#F4F5F2',
  borderBottom: '1px solid #D9DCD4',
};
const TD: CSSProperties = {
  height: 44,
  padding: '0 8px',
  borderBottom: '1px solid #E4E6E0',
  color: '#101418',
  fontSize: 14,
};
/** ปุ่มรองที่มีไอคอน — ระยะไอคอน/ข้อความ 6 px (review L7) */
const ICON_BTN: CSSProperties = { display: 'inline-flex', alignItems: 'center', gap: 6 };
const NUM: CSSProperties = { fontVariantNumeric: 'tabular-nums', textAlign: 'right' };
const BOX: CSSProperties = {
  border: '1px solid #D9DCD4',
  borderRadius: 10,
  overflow: 'hidden',
  gridColumn: 'span 2',
};
const CHECK: CSSProperties = {
  width: 16,
  height: 16,
  accentColor: '#2257C4',
  margin: 0,
  cursor: 'pointer',
};

/** ค่าเที่ยว (CARRIER_FEE) / ค่าใช้จ่ายหน้างาน (อื่น ๆ) ของเที่ยว — คอลัมน์เดียวกับใบสำคัญจ่าย #pv */
export function tripAmounts(x: SettlementQueueTrip): { fee: string; site: string } {
  let fee = 0n;
  let site = 0n;
  for (const l of x.lines) {
    if (!l.buyAmount) continue;
    if (l.costType === 'CARRIER_FEE') fee += toSatang(l.buyAmount);
    else site += toSatang(l.buyAmount);
  }
  return { fee: fromSatang(fee), site: fromSatang(site) };
}

/** ยอดรวมฝั่งฟอร์ม (สตางค์ — ไม่ใช้ float) · สุทธิก่อนหัก ณ ที่จ่าย = ยอดซื้อ − รายการหัก (WHT คิดที่ server — ST6-T08) */
export function draftTotals(trips: SettlementQueueTrip[], deductions: { amount: string }[]) {
  const gross = trips.reduce((a, x) => a + (x.buyTotal ? toSatang(x.buyTotal) : 0n), 0n);
  const ded = deductions.reduce((a, d) => {
    const v = parseCost(d.amount);
    return v ? a + toSatang(v) : a;
  }, 0n);
  return { gross: fromSatang(gross), ded: fromSatang(ded), net: fromSatang(gross - ded) };
}

/**
 * "สร้างงวดใหม่" (หน้า `settle` — ST6-T03 `POST /v1/settlements` จากคิวจ่าย ST6-T02)
 * ต้นแบบมีแต่ปุ่ม (toast) → **[DECISION — PO 24 พ.ย. 2569 ประกอบจากโครงสร้างต้นแบบ]** ฟอร์มสร้าง (cfOpen = FormDrawer) +
 * ตารางติ๊กรายการแบบ "ออกใบแจ้งหนี้จาก DO ที่ส่งแล้ว" ของหน้า `bill` + คอลัมน์ค่าเที่ยว/ค่าใช้จ่ายหน้างานของใบสำคัญจ่าย #pv:
 * ผู้รับเหมา (เฉพาะรายที่มีเที่ยวรอจ่าย) · ช่วงวันที่เที่ยวจบ · ติ๊กเที่ยว · รายการหัก (ชนิด/รายละเอียด/ยอด/เอกสารอ้างอิง — BIL-134) ·
 * เลขใบแจ้งหนี้/วันที่ของผู้รับเหมา · หมายเหตุ → ร่าง (DRAFT ยังไม่มีเลข) แล้วเปิด drawer ใบนั้น
 * เงิน: แสดงยอดซื้อ/หัก/สุทธิก่อนหัก ณ ที่จ่าย (สตางค์) — หัก ณ ที่จ่าย (ประมาณการ) คิดที่ server แสดงใน drawer หลังสร้าง
 */
export function CreateSettlementDrawer({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const { t } = useI18n();
  const dateText = useDateText();
  const [carrierId, setCarrierId] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [picked, setPicked] = useState<string[]>([]);
  const [deds, setDeds] = useState<Deduction[]>([]);
  const [inv, setInv] = useState({ no: '', date: '', note: '' });
  const [tried, setTried] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const range = { ...(from ? { dateFrom: from } : {}), ...(to ? { dateTo: to } : {}) };
  const all = useSettlementQueue(range);
  const carriers = all.data?.carriers ?? [];
  useEffect(() => {
    if (!carriers.length) return;
    if (!carrierId || !carriers.some((c) => c.carrierId === carrierId))
      setCarrierId(carriers[0]!.carrierId);
  }, [carriers, carrierId]);
  const q = useSettlementQueue({ ...range, ...(carrierId ? { carrierId } : {}) });
  const rows = carrierId ? (q.data?.data ?? []) : [];
  const chosen = rows.filter((x) => picked.includes(x.id));
  const sum = useMemo(() => draftTotals(chosen, deds), [chosen, deds]);
  const create = useCreateSettlement();
  const idem = useRef<{ sig: string; key: string }>({ sig: '', key: '' });

  const dedErr = (d: Deduction) => ({
    description: d.description.trim() ? undefined : t('field.required'),
    amount: parseCost(d.amount) ? undefined : t('settle.new.badAmount'),
    reference: d.reference.trim() ? undefined : t('field.required'),
  });
  const bad =
    (chosen.length ? 0 : 1) +
    deds.reduce((a, d) => a + Object.values(dedErr(d)).filter(Boolean).length, 0);
  const submit = () => {
    setTried(true);
    setErr(null);
    if (bad || create.isPending) return;
    const body = {
      carrierId,
      tripIds: chosen.map((x) => x.id),
      ...(from && to ? { periodFrom: from, periodTo: to } : {}),
      ...(deds.length
        ? {
            deductions: deds.map((d) => ({
              deductionType: d.type,
              description: d.description.trim(),
              amount: `-${parseCost(d.amount)!}`,
              reference: d.reference.trim(),
            })),
          }
        : {}),
      ...(inv.no.trim() ? { carrierInvoiceNo: inv.no.trim() } : {}),
      ...(inv.date ? { carrierInvoiceDate: inv.date } : {}),
      ...(inv.note.trim() ? { note: inv.note.trim() } : {}),
    };
    // Idempotency-Key เดิมตราบที่ข้อมูลเดิม (กดซ้ำ/ส่งใหม่หลังเน็ตหลุด = ได้ใบเดิม) · ข้อมูลเปลี่ยน = key ใหม่ (review L5)
    const sig = JSON.stringify(body);
    if (idem.current.sig !== sig) idem.current = { sig, key: crypto.randomUUID() };
    create.mutate(
      { body, idempotencyKey: idem.current.key },
      {
        onSuccess: (s) => onCreated(s.id),
        onError: (e) => setErr(problemText(e, t)),
      },
    );
  };
  const setDed = (key: number, patch: Partial<Deduction>) =>
    setDeds((xs) => xs.map((d) => (d.key === key ? { ...d, ...patch } : d)));
  const allOn = rows.length > 0 && rows.every((x) => picked.includes(x.id));

  return (
    <FormDrawer
      open
      title={t('settle.newPeriod')}
      subtitle={t('settle.kind')}
      onClose={onClose}
      closeLabel={t('drawer.close')}
      {...(tried && bad ? { alert: t('form.incomplete', { n: bad }) } : {})}
      onSubmit={submit}
      footer={
        <>
          <span
            data-testid="settle-new-sum"
            style={{ color: '#3B424C', fontVariantNumeric: 'tabular-nums' }}
          >
            {t('settle.new.sum', {
              n: chosen.length,
              g: money(sum.gross),
              d: money(sum.ded),
              net: money(sum.net),
            })}
          </span>
          <button type="button" className="tms-fdrawer__cancel" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button
            type="submit"
            className="tms-drawer__pri"
            style={{ height: 40, padding: '0 18px' }}
            disabled={create.isPending || !carrierId}
          >
            {t('settle.new.create')}
          </button>
        </>
      }
    >
      {err && <div className="tms-alert">{err}</div>}
      <FormSection title={t('settle.new.sec.carrier')}>
        <FormField label={t('settle.kv.carrier')} required span={2}>
          {(p) => (
            <select
              {...p}
              className="tms-select"
              value={carrierId}
              onChange={(e) => {
                setCarrierId(e.target.value);
                setPicked([]);
              }}
            >
              {!carriers.length && <option value="">{t('settle.new.noCarrier')}</option>}
              {carriers.map((c) => (
                <option key={c.carrierId} value={c.carrierId}>
                  {t('settle.new.carrierOpt', { n: c.carrierName, c: c.tripCount })}
                </option>
              ))}
            </select>
          )}
        </FormField>
        <FormField label={t('settle.new.from')} hint={t('settle.new.rangeHint')}>
          {(p) => (
            <TextInput
              {...p}
              type="date"
              value={from}
              onChange={(e) => {
                setFrom(e.target.value);
                setPicked([]);
              }}
            />
          )}
        </FormField>
        <FormField label={t('settle.new.to')}>
          {(p) => (
            <TextInput
              {...p}
              type="date"
              value={to}
              onChange={(e) => {
                setTo(e.target.value);
                setPicked([]);
              }}
            />
          )}
        </FormField>
      </FormSection>

      <FormSection title={t('settle.new.sec.trips', { n: rows.length })}>
        <div style={BOX} data-testid="settle-new-trips">
          <table
            style={{
              width: '100%',
              borderCollapse: 'separate',
              borderSpacing: 0,
              tableLayout: 'fixed',
            }}
          >
            <thead>
              <tr>
                <th style={{ ...TH, width: 36 }}>
                  <input
                    type="checkbox"
                    aria-label={t('bill.pickAll')}
                    checked={allOn}
                    onChange={() => setPicked(allOn ? [] : rows.map((x) => x.id))}
                    style={CHECK}
                  />
                </th>
                <th style={TH}>{t('settle.new.c.trip')}</th>
                <th style={{ ...TH, width: 104 }}>{t('settle.new.c.done')}</th>
                <th style={{ ...TH, width: 84 }}>{t('settle.new.c.pod')}</th>
                <th style={{ ...TH, width: 92, textAlign: 'right' }}>{t('settle.new.c.fee')}</th>
                <th style={{ ...TH, width: 92, textAlign: 'right' }}>
                  {t('settle.items.surcharge')}
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((x) => {
                const a = tripAmounts(x);
                const on = picked.includes(x.id);
                return (
                  <tr
                    key={x.id}
                    style={{ background: on ? '#F3F7FD' : undefined, cursor: 'pointer' }}
                    onClick={() =>
                      setPicked((p) => (on ? p.filter((y) => y !== x.id) : [...p, x.id]))
                    }
                  >
                    <td style={TD}>
                      <input
                        type="checkbox"
                        aria-label={x.tripNo ?? x.id}
                        checked={on}
                        onChange={() => undefined}
                        style={CHECK}
                      />
                    </td>
                    <td style={{ ...TD, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>
                      {x.tripNo ?? '—'}
                    </td>
                    <td style={{ ...TD, whiteSpace: 'nowrap' }}>
                      {dateText((x.completedAt ?? x.tripDate).slice(0, 10))}
                    </td>
                    <td style={{ ...TD, whiteSpace: 'nowrap' }}>
                      <span style={{ color: x.pod.complete ? '#17733F' : '#8F5500' }}>
                        {t(x.pod.complete ? 'settle.new.podOk' : 'settle.new.podNo', {
                          a: x.pod.completeCount,
                          b: x.pod.deliveryOrders,
                        })}
                      </span>
                    </td>
                    <td style={{ ...TD, ...NUM }}>{money(a.fee)}</td>
                    <td style={{ ...TD, ...NUM }}>{money(a.site)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {!q.isLoading && !rows.length && (
            <div
              style={{
                padding: '28px 16px',
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                gap: 6,
                textAlign: 'center',
              }}
            >
              <Icon n="wallet" s={32} style={{ color: '#C9CDC3' }} />
              <div style={{ fontWeight: 600 }}>{t('settle.new.emptyTitle')}</div>
              <div style={{ color: '#3B424C' }}>{t('settle.list.emptyDesc')}</div>
            </div>
          )}
        </div>
        {q.data?.hasMore && (
          <span className="tms-field-hint" style={{ gridColumn: 'span 2' }}>
            {t('settle.new.more', { n: rows.length })}
          </span>
        )}
        {tried && !chosen.length && (
          <span className="tms-field-error" style={{ gridColumn: 'span 2' }}>
            {t('settle.new.pickTrip')}
          </span>
        )}
      </FormSection>

      <FormSection title={t('settle.new.sec.ded')}>
        {deds.map((d) => {
          const e: Partial<ReturnType<typeof dedErr>> = tried ? dedErr(d) : {};
          return (
            <div
              key={d.key}
              style={{
                gridColumn: 'span 2',
                display: 'grid',
                gridTemplateColumns: '1fr 1fr',
                gap: 12,
                padding: 12,
                border: '1px solid #E4E6E0',
                borderRadius: 10,
              }}
            >
              <FormField label={t('settle.new.d.type')} required>
                {(p) => (
                  <select
                    {...p}
                    className="tms-select"
                    value={d.type}
                    onChange={(ev) => setDed(d.key, { type: ev.target.value as DeductionType })}
                  >
                    {DEDUCTION_TYPES.map((k) => (
                      <option key={k} value={k}>
                        {t(`stl.ln.deduct.${k}` as MessageKey)}
                      </option>
                    ))}
                  </select>
                )}
              </FormField>
              <FormField label={t('settle.new.d.amount')} required error={e.amount}>
                {(p) => (
                  <TextInput
                    {...p}
                    inputMode="decimal"
                    placeholder="0.00"
                    style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}
                    value={d.amount}
                    onChange={(ev) => setDed(d.key, { amount: ev.target.value })}
                  />
                )}
              </FormField>
              <FormField label={t('settle.new.d.desc')} required error={e.description}>
                {(p) => (
                  <TextInput
                    {...p}
                    maxLength={500}
                    value={d.description}
                    onChange={(ev) => setDed(d.key, { description: ev.target.value })}
                  />
                )}
              </FormField>
              <FormField
                label={t('settle.new.d.ref')}
                required
                error={e.reference}
                hint={t('settle.new.d.refHint')}
              >
                {(p) => (
                  <TextInput
                    {...p}
                    maxLength={200}
                    value={d.reference}
                    onChange={(ev) => setDed(d.key, { reference: ev.target.value })}
                  />
                )}
              </FormField>
              <div style={{ gridColumn: 'span 2', display: 'flex', justifyContent: 'flex-end' }}>
                <button
                  type="button"
                  className="tms-drawer__sec"
                  style={{ ...ICON_BTN, color: '#B3322A' }}
                  onClick={() => setDeds((xs) => xs.filter((x) => x.key !== d.key))}
                >
                  <Icon n="trash-2" s={16} />
                  {t('settle.new.d.remove')}
                </button>
              </div>
            </div>
          );
        })}
        <div style={{ gridColumn: 'span 2' }}>
          <button
            type="button"
            className="tms-drawer__sec"
            style={ICON_BTN}
            onClick={() =>
              setDeds((xs) => [
                ...xs,
                {
                  key: (xs[xs.length - 1]?.key ?? 0) + 1,
                  type: 'CASH_ADVANCE',
                  description: '',
                  amount: '',
                  reference: '',
                },
              ])
            }
          >
            <Icon n="plus" s={16} />
            {t('settle.new.d.add')}
          </button>
        </div>
      </FormSection>

      <FormSection title={t('settle.new.sec.doc')}>
        <FormField label={t('settle.new.invNo')}>
          {(p) => (
            <TextInput
              {...p}
              maxLength={60}
              value={inv.no}
              onChange={(e) => {
                const v = e.target.value;
                setInv((x) => ({ ...x, no: v }));
              }}
            />
          )}
        </FormField>
        <FormField label={t('settle.new.invDate')}>
          {(p) => (
            <TextInput
              {...p}
              type="date"
              value={inv.date}
              onChange={(e) => {
                const v = e.target.value;
                setInv((x) => ({ ...x, date: v }));
              }}
            />
          )}
        </FormField>
        <FormField label={t('settle.new.note')} span={2}>
          {(p) => (
            <TextInput
              {...p}
              maxLength={1000}
              value={inv.note}
              onChange={(e) => {
                const v = e.target.value;
                setInv((x) => ({ ...x, note: v }));
              }}
            />
          )}
        </FormField>
      </FormSection>
    </FormDrawer>
  );
}
