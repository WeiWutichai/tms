import { ActivityTimeline, Badge, Drawer, DrawerFooterButtons, statusOf } from '@tms/ui';
import { Link } from 'react-router-dom';
import { formatDateTime, type T, useI18n } from '../../i18n';
import type { MessageKey } from '../../i18n/th';
import { DoneNote, KvSection, logTimeline, MsgBar, Step } from './ErpDrawer';
import { classKey, queueMessage, queueStatusKey, queueType, type QueueItem } from './queue';
import type { QueueDialogKind } from './QueueDialogs';
import { useCommandSyncLog } from './useQueue';
import { connectorGuideUrl } from '../../help/routes';

/**
 * drawer รายการคิว (PO #86 24 พ.ย. 2569 — หน้าตา vPanel kind `erp` ของต้นแบบ): หัว "คิวเชื่อมระบบบัญชี · {ประเภท}" + เลข + ลูกค้า + ป้ายสถานะ ·
 * แท็บ สรุป (ข้อมูล · แถบแดงข้อความ · คู่มือต่อ error (docs/01 §6.4) + ลิงก์หน้าที่ต้องแก้ · ช่องที่ระบบบัญชีแจ้งว่าผิด) / กิจกรรม
 * (สถานะการซิงก์ + บันทึกการเรียกของคำสั่งนี้ = sync log `commandId`) · footer แท็บล้มเหลว: ข้ามพร้อมเหตุผล · กรอกเลขเอง (รอง) ·
 * ส่งซ้ำ หรือ อนุมัติแทนที่ (หลัก) — รอคิว/สำเร็จ = "ปิดหน้าต่าง" (ระบบส่งเอง / จบแล้ว)
 * ต่างจากต้นแบบ: ไม่มีตาราง "เทียบข้อมูล TMS กับ {ERP}" (คำสั่งที่ส่งไม่สำเร็จยังไม่มีเอกสารฝั่งระบบบัญชีให้เทียบ) · ไม่มีแท็บเอกสารแนบ
 */
export function QueueDrawer({
  x,
  erp,
  connectorId,
  tab,
  onTab,
  canAct,
  canApprove,
  busy = false,
  onClose,
  onRetry,
  onAsk,
}: {
  x: QueueItem;
  erp: string;
  connectorId: string;
  tab: string;
  onTab: (k: string) => void;
  canAct: boolean;
  canApprove: boolean;
  /** กำลังส่งซ้ำ — ปิดปุ่มกันกดซ้ำ (review q86 L2) */
  busy?: boolean;
  onClose: () => void;
  onRetry: (x: QueueItem) => void;
  onAsk: (kind: QueueDialogKind, x: QueueItem) => void;
}) {
  const { t, lang } = useI18n();
  const labels = { close: t('drawer.close'), more: t('drawer.more') };
  const stLabel = t(queueStatusKey(x));
  const b = statusOf(stLabel);
  const at = (iso: string) => formatDateTime(iso, lang);
  const msg = queueMessage(t, x, at);
  const failed = x.tab === 'failed';
  const approval = x.errorCode === 'replace_requires_approval';
  const retryHint = !canAct
    ? t('erpq.hint.noAct')
    : x.actions.retry
      ? null
      : t('erpq.hint.noRetry');
  // ผู้ขอ/ผู้ออกใบอนุมัติเองไม่ได้ (`requestedByMe` — API ตอบ 403 `erp_replace_self_approval`)
  const approveHint = !canApprove
    ? t('erpq.hint.noApprove')
    : x.requestedByMe
      ? t('erpq.hint.self')
      : null;
  const secondary = canAct
    ? [
        ...(x.actions.skip ? [{ label: t('erpq.q.skip'), onClick: () => onAsk('skip', x) }] : []),
        ...(x.actions.externalId
          ? [{ label: t('erpq.q.extId'), onClick: () => onAsk('externalId', x) }]
          : []),
      ]
    : [];
  return (
    <Drawer
      open
      onClose={onClose}
      kind={t('erpq.kind', { type: queueType(t, x) })}
      title={x.documentNo ?? x.id}
      {...(x.partyName ? { subtitle: x.partyName } : {})}
      badge={<Badge label={stLabel} tone={b.tone} icon={b.icon} />}
      tabs={[
        { key: 'sum', label: t('bill.tab.sum') },
        { key: 'log', label: t('bill.tab.log') },
      ]}
      tab={tab}
      onTab={onTab}
      labels={labels}
      footer={
        <>
          <span style={{ flex: 1 }} />
          {failed ? (
            <DrawerFooterButtons
              secondary={secondary}
              primary={
                approval
                  ? {
                      label: t('erpq.q.approve'),
                      icon: 'refresh-cw',
                      disabled: !!approveHint,
                      onClick: () => onAsk('approve', x),
                      ...(approveHint ? { title: approveHint } : {}),
                    }
                  : {
                      label: t('erpq.q.retry'),
                      icon: 'refresh-cw',
                      disabled: !!retryHint || busy,
                      onClick: () => onRetry(x),
                      ...(retryHint ? { title: retryHint } : {}),
                    }
              }
            />
          ) : (
            <DrawerFooterButtons
              primary={{ label: t('erpq.closeWin'), icon: 'x', onClick: onClose }}
            />
          )}
        </>
      }
    >
      {tab === 'sum' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
          <KvSection
            items={[
              { k: t('erpq.col.type'), v: queueType(t, x) },
              { k: t('erpq.col.cust'), v: x.partyName ?? '—' },
              { k: t('erpq.col.att'), v: String(x.attempt) },
              { k: t('erpq.col.last'), v: at(x.updatedAt) },
              { k: t('erpq.kv.dest'), v: erp },
              { k: t('erpq.kv.code'), v: x.errorCode ?? '—' },
            ]}
          />
          {msg && <MsgBar>{msg}</MsgBar>}
          {x.tab === 'done' && <DoneNote>{doneText(t, x, erp)}</DoneNote>}
          {x.guide && x.tab !== 'done' && (
            <section style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <h3 style={{ margin: 0, fontSize: 15, fontWeight: 600 }}>
                {t('erpq.q.guide')}
                {x.errorClass && (
                  <span style={{ fontSize: 13, fontWeight: 400, color: '#3B424C' }}>
                    {' · '}
                    {t(classKey(x.errorClass))}
                  </span>
                )}
              </h3>
              <span style={{ color: '#101418' }}>{x.guide.action}</span>
              {/* P1-ST6-T02 (docs/04 G3 "คู่มือต่อ error code (ลิงก์ help)" · K7) — หัวข้อของรหัสนี้ใน help center */}
              <a
                href={connectorGuideUrl(x.guide.key)}
                target="_blank"
                rel="noopener noreferrer"
                style={{ color: '#2257C4', fontWeight: 500, textDecoration: 'none' }}
              >
                {t('erpq.q.manual')}
              </a>
              {x.link && (
                <Link to={x.link} style={{ color: '#2257C4', fontWeight: 500 }}>
                  {t('erpq.q.goFix')}
                </Link>
              )}
            </section>
          )}
          {(x.fields.length > 0 || x.missing.length > 0) && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <h3 style={{ margin: 0, fontSize: 15, fontWeight: 600 }}>
                {t('erpq.q.fields', { erp })}
              </h3>
              <div
                role="table"
                style={{ border: '1px solid #D9DCD4', borderRadius: 8, overflow: 'hidden' }}
              >
                <div
                  role="row"
                  style={{
                    display: 'grid',
                    gridTemplateColumns: '1fr 1.6fr',
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
                    {t('erpq.q.message')}
                  </span>
                </div>
                {[
                  ...x.fields.map((f) => ({ k: `f:${f.field}`, f: f.field, m: f.message })),
                  ...x.missing.map((m, i) => ({
                    k: `m:${i}`,
                    f: m.nameTh ?? m.code ?? m.value ?? m.kind ?? '—',
                    m: t('erpq.q.missing'),
                  })),
                ].map((r) => (
                  <div
                    key={r.k}
                    role="row"
                    style={{
                      display: 'grid',
                      gridTemplateColumns: '1fr 1.6fr',
                      alignItems: 'center',
                      minHeight: 44,
                      borderTop: '1px solid #D9DCD4',
                      background: '#FBE9E7',
                    }}
                  >
                    <span role="cell" style={{ padding: '6px 10px' }}>
                      {r.f}
                    </span>
                    <span role="cell" style={{ padding: '6px 10px', fontSize: 13 }}>
                      {r.m}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
      {tab === 'log' && <QueueLog x={x} erp={erp} connectorId={connectorId} />}
    </Drawer>
  );
}

/** สำเร็จ: วิธีจบ + เหตุผล (ผู้ทำอยู่ใน audit) */
function doneText(t: T, x: QueueItem, erp: string): string {
  const r = x.resolution;
  if (r?.kind === 'SKIPPED')
    return r.reason ? `${t('erpq.q.res.skipped')} · ${r.reason}` : t('erpq.q.res.skipped');
  if (r?.kind === 'MANUAL_EXTERNAL_ID') {
    const how = t('erpq.q.res.manual', { ext: r.externalId ?? '—' });
    return r.reason ? `${how} · ${r.reason}` : how;
  }
  if (x.status === 'SKIPPED') {
    const code = x.errorCode ? t(`cnx.ec.${x.errorCode}` as MessageKey) : '—';
    return t('erpq.q.res.sysSkip', { why: code });
  }
  return t('erpq.q.res.done', { erp });
}

function QueueLog({ x, erp, connectorId }: { x: QueueItem; erp: string; connectorId: string }) {
  const { t, lang } = useI18n();
  const log = useCommandSyncLog(connectorId, x.id);
  const ok = t('bill.step.done');
  const fail = t('erpq.step.fail');
  const pending = t('bill.step.pending');
  const skip = t('bill.step.skip');
  // ขั้นส่ง: สำเร็จ = จบแล้ว (DONE) · ล้มเหลว = แท็บล้มเหลว · รอคิว = รอดำเนินการ · ระบบไม่ส่ง = ข้าม
  const send =
    x.status === 'DONE' ? ok : x.tab === 'failed' ? fail : x.tab === 'queued' ? pending : skip;
  const items = logTimeline(t, log.data?.data ?? [], erp, lang);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <div style={{ display: 'flex', flexDirection: 'column' }}>
        <h3 style={{ margin: '0 0 12px', fontSize: 15, fontWeight: 600 }}>{t('erpq.steps')}</h3>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <Step title={t('erpq.step.payload')} state={ok} at={formatDateTime(x.createdAt, lang)} />
          <Step title={t('erpq.step.check')} state={ok} />
          <Step
            title={t('erpq.step.send', { erp, n: Math.max(1, x.attempt) })}
            state={send}
            at={formatDateTime(x.updatedAt, lang)}
            note={send === fail ? queueMessage(t, x, (s) => formatDateTime(s, lang)) : null}
          />
          <Step title={t('erpq.step.post', { erp })} state={x.status === 'DONE' ? pending : skip} />
        </div>
      </div>
      {x.bodiesHidden && (
        <span style={{ fontSize: 12.5, color: '#59606B' }}>{t('erpq.q.bodiesHidden')}</span>
      )}
      {items.length > 0 && <ActivityTimeline items={items} />}
    </div>
  );
}
