import type { components } from '@tms/contracts';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { queryClient } from '../api';
import { useI18n } from '../i18n';
import type { MessageKey } from '../i18n/th';
import { ActionDialog } from './Tenants';
import { can, consoleApi, cunwrap, useStaff } from './session';

type Row = components['schemas']['ApiUsageRowDto'];

const num = (n: number) => n.toLocaleString('en-US');
/** อัตรา error ทศนิยม 1 ตำแหน่ง · ไม่มีคำขอ = — */
const pct = (n: number, total: number) =>
  total ? `${((n / total) * 100).toFixed(1).replace(/\.0$/, '')}%` : '—';

/**
 * หน้า "การใช้งาน API" (pg === 'use' ในต้นแบบ Platform Console — P1-ST4-T05)
 * - ต้นแบบมีคอลัมน์ AI credit / ค่าใช้จ่าย AI / MCP + สวิตช์ AI/MCP → ไม่แสดง (D-48, spec/12 §3)
 * - คอลัมน์ Error 5xx/4xx, p95, 429 ตาม spec/01 §10.7 (ต้นแบบไม่มี) ใช้เซลล์ตัวเลข + sub ของตารางเดิม
 * - สวิตช์ "API" = TG ของต้นแบบ (togSvc 'Open API (REST)') + dialog เหตุผล · ปุ่ม "ปรับ" (rate limit — PLT-116) ยังไม่ทำ
 * [DECISION — lead 28 พ.ย. 2569, ย้อนได้]
 */
export function ApiUsagePage() {
  const { t } = useI18n();
  const nav = useNavigate();
  const role = useStaff().data?.role;
  const allowed = can.api(role);
  const q = useQuery({
    queryKey: ['console', 'api-usage'],
    queryFn: () => cunwrap(consoleApi.GET('/v1/platform/api-usage')),
  });
  const [tog, setTog] = useState<Row | null>(null);
  const [toast, setToast] = useState('');
  useEffect(() => {
    if (!toast) return;
    const h = setTimeout(() => setToast(''), 3400);
    return () => clearTimeout(h);
  }, [toast]);

  const rows = q.data?.rows ?? [];
  const cols: [MessageKey, 'left' | 'right'][] = [
    ['con.apiu.col.co', 'left'],
    ['con.apiu.col.plan', 'left'],
    ['con.apiu.col.rest', 'right'],
    ['con.apiu.col.e5', 'right'],
    ['con.apiu.col.e4', 'right'],
    ['con.apiu.col.p95', 'right'],
    ['con.apiu.col.th', 'right'],
    ['con.apiu.col.rl', 'right'],
    ['con.apiu.col.api', 'left'],
  ];

  return (
    <>
      <div className="con-title">
        <div style={{ flex: 1, minWidth: 260 }}>
          <h1>{t('con.apiu.title')}</h1>
          <p>
            {t('con.apiu.sub', {
              d: String(q.data?.days ?? 30),
              n: q.data ? num(q.data.totalRequests) : '—',
            })}
          </p>
        </div>
      </div>
      <section className="con-card">
        <table className="con-tbl">
          <thead>
            <tr>
              {cols.map(([c, al]) => (
                <th key={c} style={{ textAlign: al }}>
                  {t(c)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {q.isLoading
              ? Array.from({ length: 6 }, (_, i) => (
                  <tr key={i} aria-hidden="true">
                    {[160, 70, 60, 50, 50, 60, 40, 90, 38].map((w, j) => (
                      <td key={j}>
                        <span className="con-skel" style={{ width: w }} />
                      </td>
                    ))}
                  </tr>
                ))
              : rows.map((r) => {
                  const e5 = r.requests ? r.errors5xx / r.requests : 0;
                  const on = !r.apiDisabled;
                  return (
                    <tr key={r.tenantId} onClick={() => nav(`/console/tenants/${r.tenantId}`)}>
                      <td>
                        <span style={{ fontWeight: 500, whiteSpace: 'nowrap' }}>{r.name}</span>
                      </td>
                      <td style={{ whiteSpace: 'nowrap' }}>{r.planName}</td>
                      <td className="con-num">{num(r.requests)}</td>
                      <td className="con-num">
                        <Cell
                          v={pct(r.errors5xx, r.requests)}
                          sub={r.errors5xx ? t('con.apiu.times', { n: num(r.errors5xx) }) : ''}
                          c={e5 >= 0.01 ? '#B3322A' : undefined}
                        />
                      </td>
                      <td className="con-num">
                        <Cell
                          v={pct(r.errors4xx, r.requests)}
                          sub={r.errors4xx ? t('con.apiu.times', { n: num(r.errors4xx) }) : ''}
                        />
                      </td>
                      <td className="con-num">
                        {r.p95Ms == null
                          ? '—'
                          : t(r.p95Over ? 'con.apiu.msOver' : 'con.apiu.ms', { n: num(r.p95Ms) })}
                      </td>
                      <td className="con-num">{num(r.throttled)}</td>
                      <td className="con-num">
                        {r.apiInPlan || r.apiDisabled ? (
                          <Cell
                            v={t('con.apiu.perMin', { n: num(r.rateLimit.tenantPerMinute) })}
                            sub={
                              r.rateLimit.override
                                ? t('con.apiu.override')
                                : t('con.apiu.perKey', { n: num(r.rateLimit.keyPerMinute) })
                            }
                          />
                        ) : (
                          '—'
                        )}
                      </td>
                      <td>
                        {r.apiInPlan || r.apiDisabled ? (
                          <button
                            type="button"
                            role="switch"
                            aria-checked={on}
                            aria-label={`${t('con.apiu.col.api')} · ${r.name}`}
                            className="con-tog"
                            title={t(on ? 'con.apiu.tipOn' : 'con.apiu.tipOff')}
                            style={{
                              background: on ? '#2257C4' : '#C9CDC3',
                              opacity: allowed ? 1 : 0.5,
                            }}
                            onClick={(e) => {
                              e.stopPropagation();
                              if (!allowed) return setToast(t('con.apiu.noPerm'));
                              setTog(r);
                            }}
                          >
                            <span style={{ left: on ? 18 : 2 }} />
                          </button>
                        ) : (
                          <span style={{ color: '#59606B', whiteSpace: 'nowrap' }}>
                            {t('con.apiu.notInPlan')}
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })}
          </tbody>
        </table>
        {q.isError && <div className="con-empty">{t('con.loadFailed')}</div>}
        {!q.isLoading && !q.isError && !rows.length && (
          <div className="con-empty">{t('con.apiu.empty')}</div>
        )}
      </section>
      {tog && (
        <ToggleApiDialog
          row={tog}
          onClose={() => setTog(null)}
          onDone={(r, off) => {
            setTog(null);
            setToast(t(off ? 'con.apiu.toastOff' : 'con.apiu.toastOn', { n: r.name }));
          }}
        />
      )}
      {toast && (
        <div className="con-toast" role="status">
          {toast}
        </div>
      )}
    </>
  );
}

function Cell({ v, sub, c }: { v: string; sub?: string; c?: string }) {
  return (
    <div className="con-cell" style={{ alignItems: 'flex-end' }}>
      <span style={{ color: c }}>{v}</span>
      {sub ? <span className="con-cell__sub">{sub}</span> : null}
    </div>
  );
}

/** togSvc ของต้นแบบ (k = 'apiOn') — เหตุผล ≥ 10 ตัว · ปิด = danger */
function ToggleApiDialog({
  row,
  onClose,
  onDone,
}: {
  row: Row;
  onClose: () => void;
  onDone: (r: Row, off: boolean) => void;
}) {
  const { t } = useI18n();
  const off = !row.apiDisabled;
  const m = useMutation({
    mutationFn: (reason: string) =>
      cunwrap(
        off
          ? consoleApi.POST('/v1/platform/tenants/{id}/api/disable', {
              params: { path: { id: row.tenantId } },
              body: { reason },
            })
          : consoleApi.POST('/v1/platform/tenants/{id}/api/enable', {
              params: { path: { id: row.tenantId } },
              body: { reason },
            }),
      ),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['console', 'api-usage'] }),
  });
  return (
    <ActionDialog
      title={t(off ? 'con.apiu.offT' : 'con.apiu.onT', { n: row.name })}
      desc={t(off ? 'con.apiu.offD' : 'con.apiu.onD')}
      danger={off}
      okL={t(off ? 'con.apiu.offOk' : 'con.apiu.onOk')}
      onClose={onClose}
      onOk={async (_v, reason) => {
        await m.mutateAsync(reason);
        onDone(row, off);
      }}
    />
  );
}
