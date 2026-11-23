import {
  ActivityTimeline,
  Badge,
  Drawer,
  DrawerFooterButtons,
  EmptyState,
  Icon,
  statusOf,
  type TimelineItem,
} from '@tms/ui';
import { formatDateTime, useI18n } from '../../i18n';
import { problemText } from '../master/problems';
import { compareRows, messageOf, rowStatus, statusKey } from './erpq';
import { type ReconcileResult, useDocumentSyncLog, useReconcileResult } from './useReconcile';

/** แถวขั้นตอน (ต้นแบบ vPanel `steps`: กล่องเทา ไอคอน + ชื่อ + ✓ หรือป้าย · เวลา · หมายเหตุ) */
function Step({
  title,
  state,
  at,
  note,
}: {
  title: string;
  state: string;
  at?: string | null;
  note?: string | null;
}) {
  const { t } = useI18n();
  const done = state === t('bill.step.done');
  const b = statusOf(state);
  const fail = state === t('erpq.step.fail');
  const wait = state === t('bill.step.pending');
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: 12,
        padding: '10px 12px',
        background: '#F4F5F2',
        border: '1px solid #E4E6E0',
        borderRadius: 12,
      }}
    >
      <span
        style={{
          width: 28,
          height: 28,
          borderRadius: 8,
          background: '#FFFFFF',
          border: '1px solid #D9DCD4',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          flexShrink: 0,
          color: done ? '#2257C4' : fail ? '#B3322A' : wait ? '#8F5500' : '#59606B',
        }}
      >
        <Icon
          n={done ? 'circle-check' : fail ? 'circle-alert' : wait ? 'clock' : 'circle-dashed'}
          s={16}
        />
      </span>
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
        <div
          style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}
        >
          <span style={{ fontWeight: 500 }}>{title}</span>
          {done ? (
            <Icon n="check" s={18} style={{ color: '#2257C4' }} />
          ) : (
            <Badge label={state} tone={b.tone} icon={b.icon} />
          )}
        </div>
        {at && <span style={{ fontSize: 12, color: '#3B424C' }}>{at}</span>}
        {note && <span style={{ color: '#3B424C' }}>{note}</span>}
      </div>
    </div>
  );
}

const CMP_GRID = '1.1fr 1fr 1fr 64px';

/**
 * drawer รายการไม่ตรง (ต้นแบบ TMS v4 vPanel kind `erp`): หัว "คิวเชื่อมระบบบัญชี · {ประเภท}" + เลข + ป้ายสถานะ ·
 * แท็บ สรุป (แถบแดงข้อความ + ตาราง "เทียบข้อมูล TMS กับ {ERP}" / ต่าง n ฟิลด์) / เอกสารแนบ / กิจกรรม (สถานะการซิงก์ + บันทึกการเรียก JSON)
 * footer: รับค่า {ERP} · ขออนุมัติแก้ (รอง) · ใช้ค่า TMS ส่งซ้ำ (หลัก) — ปิดแล้ว = "ปิดหน้าต่าง"
 * ความต่างจากต้นแบบ [DECISION spec/12 §3 แถว ST8-T12]: ไม่มียอด "ยอดก่อน VAT ตาม TMS" ที่ footer (DTO ไม่มียอด) · เมนู ⋯ (แก้ไข/คัดลอก/พิมพ์/ยกเลิก
 * ของเอกสารทั่วไป) ไม่มี · ปุ่ม "ลองใหม่" ในขั้นตรวจเทียบไม่มี (ส่งทับต้องอนุมัติ) · "ใช้ค่า TMS ส่งซ้ำ" = ผู้อนุมัติอนุมัติคำขอ (คนละคนกับผู้ขอ)
 */
export function ErpDrawer({
  id,
  tab,
  onTab,
  erpName,
  can,
  onClose,
  onAccept,
  onAskFix,
  onUseTms,
}: {
  id: string;
  tab: string;
  onTab: (k: string) => void;
  erpName: (x: ReconcileResult) => string;
  can: { act: boolean; approve: boolean };
  onClose: () => void;
  onAccept: (x: ReconcileResult) => void;
  onAskFix: (x: ReconcileResult) => void;
  onUseTms: (x: ReconcileResult) => void;
}) {
  const { t, lang } = useI18n();
  const q = useReconcileResult(id);
  const x = q.data;
  const labels = { close: t('drawer.close'), more: t('drawer.more') };
  if (!x)
    return (
      <Drawer open onClose={onClose} kind={t('page.erp.title')} title="…" labels={labels}>
        {q.isError ? (
          <EmptyState
            icon="circle-alert"
            title={t('erpq.loadError')}
            description={problemText(q.error, t) ?? ''}
          />
        ) : (
          <span style={{ color: '#3B424C' }}>{t('erpq.loading')}</span>
        )}
      </Drawer>
    );
  const erp = erpName(x);
  const st = rowStatus(x);
  const stLabel = t(statusKey(st));
  const b = statusOf(stLabel);
  const open = st !== 'closed';
  const msg = messageOf(t, x, erp);
  const rows = compareRows(t, x, erp);
  const nd = rows.filter((r) => r.diff).length;
  const no = x.localNumber ?? x.invoiceId ?? x.id;
  const useTmsHint = !can.approve
    ? t('erpq.hint.noApprove')
    : st !== 'appr'
      ? t('erpq.hint.askFirst')
      : x.overwrite?.requestedByMe
        ? t('erpq.hint.self')
        : null;
  return (
    <Drawer
      open
      onClose={onClose}
      kind={t('erpq.kind', { type: t('erpq.type.INVOICE') })}
      title={no}
      badge={<Badge label={stLabel} tone={b.tone} icon={b.icon} />}
      tabs={[
        { key: 'sum', label: t('bill.tab.sum') },
        { key: 'docs', label: t('bill.tab.docs') },
        { key: 'log', label: t('bill.tab.log') },
      ]}
      tab={tab}
      onTab={onTab}
      labels={labels}
      footer={
        open ? (
          <>
            <span style={{ flex: 1 }} />
            <DrawerFooterButtons
              secondary={
                can.act
                  ? [
                      { label: t('erpq.menu.accept', { erp }), onClick: () => onAccept(x) },
                      ...(st === 'mm'
                        ? [{ label: t('erpq.menu.askFix'), onClick: () => onAskFix(x) }]
                        : []),
                    ]
                  : []
              }
              primary={{
                label: t('erpq.menu.useTms'),
                icon: 'refresh-cw',
                disabled: !!useTmsHint,
                onClick: () => onUseTms(x),
                ...(useTmsHint ? { title: useTmsHint } : {}),
              }}
            />
          </>
        ) : (
          <>
            <span style={{ flex: 1 }} />
            <DrawerFooterButtons
              primary={{ label: t('erpq.closeWin'), icon: 'x', onClick: onClose }}
            />
          </>
        )
      }
    >
      {tab === 'sum' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
          {msg && (
            <div
              role="alert"
              style={{
                background: '#FBE9E7',
                borderRadius: 8,
                padding: '12px 14px',
                display: 'flex',
                gap: 8,
              }}
            >
              <Icon n="circle-alert" s={16} style={{ color: '#B3322A', marginTop: 3 }} />
              <span>{msg}</span>
            </div>
          )}
          {!open && <ClosedNote x={x} />}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div
              style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between' }}
            >
              <h3 style={{ margin: 0, fontSize: 15, fontWeight: 600 }}>
                {t('erpq.cmp.title', { erp })}
              </h3>
              <span style={{ fontSize: 13, color: '#3B424C' }}>{t('erpq.cmp.n', { n: nd })}</span>
            </div>
            <div
              role="table"
              style={{ border: '1px solid #D9DCD4', borderRadius: 8, overflow: 'hidden' }}
            >
              <div
                role="row"
                style={{
                  display: 'grid',
                  gridTemplateColumns: CMP_GRID,
                  background: '#EBEDE8',
                  fontSize: 12.5,
                  fontWeight: 500,
                  color: '#3B424C',
                }}
              >
                <span role="columnheader" style={{ padding: '8px 10px' }}>
                  {t('erpq.cmp.field')}
                </span>
                <span role="columnheader" style={{ padding: '8px 10px' }}>
                  TMS
                </span>
                <span role="columnheader" style={{ padding: '8px 10px' }}>
                  {erp}
                </span>
                <span />
              </div>
              {rows.map((r) => (
                <div
                  key={r.key}
                  role="row"
                  style={{
                    display: 'grid',
                    gridTemplateColumns: CMP_GRID,
                    alignItems: 'center',
                    minHeight: 44,
                    borderTop: '1px solid #D9DCD4',
                    background: r.diff ? '#FBE9E7' : '#FFFFFF',
                  }}
                >
                  <span role="cell" style={{ padding: '6px 10px' }}>
                    {r.f}
                  </span>
                  <span
                    role="cell"
                    style={{ padding: '6px 10px', fontSize: 13, wordBreak: 'break-word' }}
                  >
                    {r.tms}
                  </span>
                  <span
                    role="cell"
                    style={{
                      padding: '6px 10px',
                      fontSize: 13,
                      color: '#101418',
                      wordBreak: 'break-word',
                    }}
                  >
                    {r.erp}
                  </span>
                  <span style={{ padding: '0 8px', display: 'flex', justifyContent: 'flex-end' }}>
                    {r.diff ? (
                      <span
                        style={{
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: 4,
                          height: 24,
                          padding: '0 8px',
                          borderRadius: 6,
                          background: '#B3322A',
                          color: '#FFFFFF',
                          fontSize: 12,
                          fontWeight: 600,
                        }}
                      >
                        <Icon n="circle-alert" s={12} />
                        {t('erpq.cmp.diff')}
                      </span>
                    ) : (
                      <span
                        style={{
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: 4,
                          color: '#17733F',
                          fontSize: 13,
                          fontWeight: 500,
                        }}
                      >
                        <Icon n="check" s={16} />
                        {t('erpq.cmp.same')}
                      </span>
                    )}
                  </span>
                </div>
              ))}
            </div>
            {x.documentDiff?.truncated && (
              <span style={{ fontSize: 12.5, color: '#59606B' }}>{t('erpq.cmp.truncated')}</span>
            )}
          </div>
        </div>
      )}
      {tab === 'docs' && <EmptyState icon="paperclip" title={t('erpq.docs.none')} />}
      {tab === 'log' && <LogTab x={x} erp={erp} lang={lang} />}
    </Drawer>
  );
}

/** ปิดแล้ว: วิธีปิด + เหตุผล (ผู้ทำอยู่ใน audit) */
function ClosedNote({ x }: { x: ReconcileResult }) {
  const { t } = useI18n();
  const how = x.acknowledgedAt
    ? t('erpq.closed.ack')
    : x.resolution
      ? t(`erpq.closed.${x.resolution}` as never)
      : t('erpq.closed.superseded');
  const why = x.ackReason ?? x.resolutionReason;
  return (
    <div
      style={{
        background: '#EEF0EC',
        borderRadius: 8,
        padding: '10px 14px',
        display: 'flex',
        gap: 8,
      }}
    >
      <Icon n="circle-check" s={16} style={{ color: '#17733F', marginTop: 4, flexShrink: 0 }} />
      <span>{why ? `${how} · ${why}` : how}</span>
    </div>
  );
}

function LogTab({ x, erp, lang }: { x: ReconcileResult; erp: string; lang: 'th' | 'en' | 'zh' }) {
  const { t } = useI18n();
  const log = useDocumentSyncLog(x.connector.id, x.localNumber);
  const st = rowStatus(x);
  const ok = t('bill.step.done');
  const fail = t('erpq.step.fail');
  const pending = t('bill.step.pending');
  const skip = t('bill.step.skip');
  const sendAt = x.sends?.lastSentAt ? formatDateTime(x.sends.lastSentAt, lang) : null;
  const compare = st === 'closed' ? ok : st === 'appr' || st === 'resend' ? pending : fail;
  const items: TimelineItem[] = (log.data?.data ?? []).map((l) => {
    const good = l.statusCode !== null && l.statusCode >= 200 && l.statusCode < 300;
    const parse = (s: string | null) => {
      if (s === null) return null;
      try {
        return JSON.parse(s) as unknown;
      } catch {
        return s;
      }
    };
    return {
      key: l.id,
      title:
        l.method === 'GET'
          ? t('erpq.log.fetch', { erp })
          : t('erpq.log.send', { erp, n: l.attempt ?? 1 }),
      sub: `${formatDateTime(l.occurredAt, lang)} · ${l.statusCode ?? l.errorCode ?? '—'}`,
      badge: good
        ? { label: ok, tone: 'ok', icon: 'check' }
        : { label: fail, tone: 'err', icon: 'x' },
      detail: (
        <pre
          style={{
            margin: '4px 0 0',
            padding: 12,
            background: '#EBEDE8',
            borderRadius: 8,
            fontVariantNumeric: 'tabular-nums',
            fontSize: 13,
            lineHeight: 1.55,
            color: '#101418',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
          }}
        >
          {JSON.stringify(
            {
              request: { method: l.method, url: l.url, body: parse(l.requestBody) },
              response: { status: l.statusCode, body: parse(l.responseBody) },
            },
            null,
            2,
          )}
        </pre>
      ),
    };
  });
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <div style={{ display: 'flex', flexDirection: 'column' }}>
        <h3 style={{ margin: '0 0 12px', fontSize: 15, fontWeight: 600 }}>{t('erpq.steps')}</h3>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <Step title={t('erpq.step.payload')} state={ok} />
          <Step title={t('erpq.step.check')} state={ok} />
          <Step
            title={t('erpq.step.send', { erp, n: x.sends?.count ?? 1 })}
            state={ok}
            at={sendAt}
          />
          <Step
            title={t('erpq.step.compare', { erp })}
            state={compare}
            at={formatDateTime(x.lastSeenAt, lang)}
            note={compare === fail ? messageOf(t, x, erp) : null}
          />
          <Step title={t('erpq.step.post', { erp })} state={st === 'closed' ? pending : skip} />
        </div>
      </div>
      {items.length > 0 && <ActivityTimeline items={items} />}
    </div>
  );
}
