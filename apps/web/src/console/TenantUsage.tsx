import type { components } from '@tms/contracts';
import { useQuery } from '@tanstack/react-query';
import { Icon } from '@tms/ui';
import { useState } from 'react';
import { queryClient } from '../api';
import { formatDate, formatMonth, useI18n } from '../i18n';
import { ActionDialog } from './Tenants';
import { can, consoleApi, cunwrap, useStaff } from './session';

type TenantDetail = components['schemas']['PlatformTenantDetailDto'];
type Usage = components['schemas']['PlatformActiveVehicleUsageDto'];
type Row = Usage['data'][number];

/** เดือนปฏิทินเวลาไทยย้อนหลัง n เดือน (YYYY-MM) */
function months(n: number, now = new Date()): string[] {
  const bkk = new Date(now.getTime() + 7 * 3600_000);
  let y = bkk.getUTCFullYear();
  let m = bkk.getUTCMonth() + 1;
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    out.push(`${y}-${String(m).padStart(2, '0')}`);
    m -= 1;
    if (m === 0) {
      m = 12;
      y -= 1;
    }
  }
  return out;
}

type Dlg = { kind: 'exclude' | 'include'; row: Row } | { kind: 'add' } | null;

/**
 * แท็บ "การใช้งาน" ของลูกค้า (P1-ST1-T06) — ต้นแบบ Console `dtab use`: ส่วน "การใช้งานเดือนนี้" แถบ "รถ active u / q คัน" (isBars)
 * + แถวรายการแบบ `isRows` (ทะเบียน · ประเภท / จำนวนเที่ยว · วันที่วิ่ง / ป้าย) + ปุ่มแบบ `isBtns`
 * [DECISION — lead 28 พ.ย. 2569, ย้อนได้] spec/12 §3: ต้นแบบแสดงเฉพาะแถบของเดือนนี้ — เพิ่มตัวเลือกเดือน (ปรับยอดเดือนที่ปิดแล้ว),
 * รายการทะเบียนที่ถูกนับ และปุ่มตัดออก/นับกลับ/เพิ่มทะเบียน (spec/01 PLT-074 "หลัง finalize แก้ได้เฉพาะ finance ใน Console")
 * แถบเมตริกอื่น (ผู้ใช้ / API / AI / POD) = P1-ST1-T07 — ยังไม่แสดงตัวเลขสมมุติ
 */
export function TenantUsage({ x, onToast }: { x: TenantDetail; onToast: (m: string) => void }) {
  const { t, lang } = useI18n();
  const role = useStaff().data?.role;
  const opts = months(13);
  const [period, setPeriod] = useState(opts[0]!);
  const [dlg, setDlg] = useState<Dlg>(null);
  const key = ['console', 'tenant', x.id, 'usage', period];
  const q = useQuery({
    queryKey: key,
    queryFn: () =>
      cunwrap(
        consoleApi.GET('/v1/platform/tenants/{id}/usage/active-vehicles', {
          params: { path: { id: x.id }, query: { period } },
        }),
      ),
  });
  const u = q.data;
  const edit = can.usage(role) && u?.status === 'finalized';
  const pct = u?.limit ? Math.min(100, (u.activeVehicles / u.limit) * 100) : 0;
  const tone = pct >= 90 ? '#B3322A' : pct >= 75 ? '#8F5500' : '#2257C4';
  const m = formatMonth(period, lang);
  const done = (next: Usage) => {
    queryClient.setQueryData(key, next);
    setDlg(null);
    onToast(t('con.toast.usage', { n: x.name }));
  };

  return (
    <>
      <section className="con-sec">
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <span className="con-sec__t" style={{ flex: 1 }}>
            {period === opts[0] ? t('con.use.t') : t('con.use.tOf', { m })}
          </span>
          <label
            className="con-field"
            style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}
          >
            <span className="con-field__l">{t('con.use.month')}</span>
            <select
              aria-label={t('con.use.month')}
              value={period}
              onChange={(e) => setPeriod(e.target.value)}
            >
              {opts.map((p) => (
                <option key={p} value={p}>
                  {formatMonth(p, lang)}
                </option>
              ))}
            </select>
          </label>
        </div>
        {q.isError && <span style={{ color: '#59606B' }}>{t('con.loadFailed')}</span>}
        {u && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }} data-testid="use-bar">
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
              <span>{t('con.use.veh')}</span>
              <span style={{ fontVariantNumeric: 'tabular-nums', color: '#3B424C' }}>
                {t('con.use.vehV', {
                  u: u.activeVehicles,
                  q: u.limit ?? t('con.unlimited'),
                })}
              </span>
            </div>
            <div style={{ height: 6, borderRadius: 3, background: '#EBEDE8', overflow: 'hidden' }}>
              <div style={{ height: '100%', width: `${pct.toFixed(0)}%`, background: tone }} />
            </div>
            <span style={{ fontSize: 12.5, color: '#59606B' }}>
              {u.status === 'open'
                ? t('con.use.open')
                : t('con.use.final', {
                    d: u.finalizedAt ? formatDate(new Date(u.finalizedAt), lang) : '—',
                  })}
            </span>
          </div>
        )}
      </section>
      {u && (
        <section className="con-sec">
          <span className="con-sec__t">{t('con.use.list')}</span>
          <div style={{ display: 'flex', flexDirection: 'column' }} data-testid="use-rows">
            {u.data.map((r) => (
              <div
                key={r.id}
                style={{
                  display: 'grid',
                  gridTemplateColumns: `minmax(0,1fr) auto auto${edit ? ' auto' : ''}`,
                  gap: 12,
                  alignItems: 'center',
                  padding: '8px 0',
                  borderBottom: '1px solid #EBEDE8',
                  opacity: r.excluded ? 0.6 : 1,
                }}
              >
                <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
                  <span
                    style={{
                      fontWeight: 500,
                      textDecoration: r.excluded ? 'line-through' : 'none',
                    }}
                  >
                    {r.plate ?? t('usage.noPlate')}
                    {r.vehicleType ? ` · ${r.vehicleType}` : ''}
                  </span>
                  <span style={{ fontSize: 12.5, color: '#59606B' }}>
                    {[
                      r.subcontract ? `${t('con.use.sub')} · ${r.carrierName ?? '—'}` : null,
                      r.firstTripNo ? t('con.use.first', { no: r.firstTripNo }) : null,
                    ]
                      .filter(Boolean)
                      .join(' · ') || '—'}
                  </span>
                </div>
                <span
                  style={{
                    fontVariantNumeric: 'tabular-nums',
                    color: '#3B424C',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {t('con.use.row', {
                    n: r.trips,
                    d: formatDate(new Date(r.firstCountedAt), lang),
                  })}
                </span>
                {r.excluded || r.adjusted ? (
                  <span
                    className="con-badge"
                    style={
                      r.excluded
                        ? { background: '#EEF0EC', color: '#59606B' }
                        : { background: '#E9F0FA', color: '#2257C4' }
                    }
                  >
                    {t(r.excluded ? 'con.use.excluded' : 'con.use.adjusted')}
                  </span>
                ) : (
                  <span />
                )}
                {edit && (
                  <button
                    type="button"
                    className={`con-sbtn${r.excluded ? '' : ' con-sbtn--danger'}`}
                    style={{ height: 30, padding: '0 10px' }}
                    onClick={() => setDlg({ kind: r.excluded ? 'include' : 'exclude', row: r })}
                  >
                    <Icon n={r.excluded ? 'rotate-ccw' : 'minus'} s={14} strokeWidth={1.8} />
                    {t(r.excluded ? 'con.use.include' : 'con.use.exclude')}
                  </button>
                )}
              </div>
            ))}
            {!u.data.length && <span style={{ color: '#59606B' }}>{t('con.use.empty')}</span>}
          </div>
          {edit && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
              <button type="button" className="con-sbtn" onClick={() => setDlg({ kind: 'add' })}>
                <Icon n="plus" s={16} strokeWidth={1.8} />
                {t('con.use.add')}
              </button>
            </div>
          )}
        </section>
      )}
      {dlg && dlg.kind !== 'add' && (
        <ActionDialog
          title={t(dlg.kind === 'exclude' ? 'con.use.dlg.exT' : 'con.use.dlg.inT', {
            p: dlg.row.plate ?? t('usage.noPlate'),
          })}
          desc={t('con.use.dlg.d', { m })}
          okL={t(dlg.kind === 'exclude' ? 'con.use.exclude' : 'con.use.include')}
          danger={dlg.kind === 'exclude'}
          onClose={() => setDlg(null)}
          onOk={async (_v, reason) => {
            const path = { id: x.id, rowId: dlg.row.id };
            done(
              await cunwrap(
                dlg.kind === 'exclude'
                  ? consoleApi.POST(
                      '/v1/platform/tenants/{id}/usage/active-vehicles/{rowId}/exclude',
                      { params: { path }, body: { reason } },
                    )
                  : consoleApi.POST(
                      '/v1/platform/tenants/{id}/usage/active-vehicles/{rowId}/include',
                      { params: { path }, body: { reason } },
                    ),
              ),
            );
          }}
        />
      )}
      {dlg && dlg.kind === 'add' && (
        <ActionDialog
          title={t('con.use.dlg.addT', { m })}
          desc={t('con.use.dlg.d', { m })}
          fields={[{ k: 'plate', l: 'con.use.f.plate', type: 'in' }]}
          okL={t('con.use.add')}
          check={(v) => ((v.plate ?? '').trim() ? '' : ' ')}
          onClose={() => setDlg(null)}
          onOk={async (v, reason) => {
            done(
              await cunwrap(
                consoleApi.POST('/v1/platform/tenants/{id}/usage/active-vehicles', {
                  params: { path: { id: x.id } },
                  body: { period, plate: (v.plate ?? '').trim(), reason },
                }),
              ),
            );
          }}
        />
      )}
    </>
  );
}
