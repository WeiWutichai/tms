import {
  ActivityTimeline,
  Badge,
  Drawer,
  DrawerFooterButtons,
  EmptyState,
  KeyValues,
  ReasonDialog,
} from '@tms/ui';
import { useState } from 'react';
import { useI18n } from '../../i18n';
import type { MessageKey } from '../../i18n/th';
import { problemText } from '../master/problems';
import { useDateTimeText } from '../rate-cards/rateFormat';
import { TripDrawer } from '../trips/TripDrawer';
import { eventLabel, flagDetail, flagTypeLabel, SEQ_BADGE, STATUS_BADGE } from './flagText';
import {
  useResolveFlag,
  useStopSequence,
  type Decision,
  type StopEventFlag,
} from './useStopEventFlags';

/**
 * Drawer ข้อยกเว้น (ต้นแบบ TMS v4 exc drawer: หัว 3 บรรทัด · แท็บ รายละเอียด/กิจกรรม · footer ปุ่ม)
 * - รายละเอียด: ส่วน "ข้อมูล" แบบ key-value (ไม่มี SLA/ผู้รับผิดชอบในเฟส 0) + "การตัดสิน" เมื่อปิดแล้ว
 * - กิจกรรม: ลำดับ event ของจุด (GET /v1/stops/{id}/events) ให้ผู้จัดรถเห็นก่อนตัดสิน
 * - footer: "เปิดเอกสารอ้างอิง" (drawer เที่ยว) · "ปิดเหตุ" = ใช้เหตุการณ์นี้ (ACCEPT) · เมนู ⋯ "ไม่ใช้เหตุการณ์นี้" (IGNORE)
 *   ทั้งสองผ่าน ReasonDialog (เหตุผล ≥ 10 ตัวอักษร — ลง audit) · "มอบหมายคนอื่น" ไม่มีในเฟส 0
 */
export function FlagDrawer({
  flag,
  canResolve,
  onClose,
  onResolved,
}: {
  flag: StopEventFlag;
  canResolve: boolean;
  onClose: () => void;
  onResolved: (f: StopEventFlag) => void;
}) {
  const { t } = useI18n();
  const dt = useDateTimeText();
  const [tab, setTab] = useState<'detail' | 'activity'>('detail');
  const [dialog, setDialog] = useState<Decision | null>(null);
  const [trip, setTrip] = useState(false);
  const seq = useStopSequence(tab === 'activity' ? flag.stopId : null);
  const resolve = useResolveFlag();
  const isOpen = flag.status === 'OPEN';
  const type = flagTypeLabel(t, flag);
  const detail = flagDetail(t, flag, dt);
  const e = flag.event;
  const res = flag.resolution;
  const sb = STATUS_BADGE[flag.status]!;

  const submit = (decision: Decision, reason: string) =>
    resolve.mutate(
      { id: flag.id, decision, reason },
      {
        onSuccess: (f) => {
          setDialog(null);
          onResolved(f);
        },
      },
    );

  if (trip) return <TripDrawer id={flag.tripId} canEdit={false} onClose={() => setTrip(false)} />;

  return (
    <>
      <Drawer
        open
        onClose={onClose}
        kind={t('exc.kind', { type })}
        title={flag.tripNo ?? '—'}
        badge={
          <Badge label={t(`exc.st.${flag.status}` as MessageKey)} tone={sb.tone} icon={sb.icon} />
        }
        subtitle={t('exc.stop', { n: flag.stopSequence, site: flag.siteName })}
        labels={{ close: t('drawer.close'), more: t('drawer.more') }}
        menu={
          // ธงแจ้งอย่างเดียว (ผลจุดขัด DO — ST4-T03) รับทราบได้อย่างเดียว ไม่มี "ไม่ใช้"
          isOpen && canResolve && !flag.flags.every((f) => f === 'OUTCOME_MISMATCH')
            ? [
                {
                  label: t('exc.act.ignore'),
                  icon: 'circle-slash',
                  onClick: () => setDialog('IGNORE'),
                },
              ]
            : undefined
        }
        tabs={[
          { key: 'detail', label: t('exc.tab.detail') },
          { key: 'activity', label: t('exc.tab.activity') },
        ]}
        tab={tab}
        onTab={(k) => setTab(k as 'detail' | 'activity')}
        footer={
          <DrawerFooterButtons
            secondary={[{ label: t('exc.act.open'), onClick: () => setTrip(true) }]}
            {...(isOpen && canResolve
              ? {
                  primary: {
                    label: t('exc.act.resolve'),
                    icon: 'circle-check',
                    onClick: () => setDialog('ACCEPT'),
                  },
                }
              : {})}
          />
        }
      >
        {tab === 'detail' ? (
          <>
            <KeyValues
              title={t('exc.d.info')}
              items={[
                { k: t('exc.d.type'), v: type },
                { k: t('exc.d.detail'), v: detail },
                { k: t('exc.d.ref'), v: flag.tripNo ?? '—' },
                { k: t('exc.d.do'), v: flag.doNos.length ? flag.doNos.join(', ') : '—' },
                { k: t('exc.d.veh'), v: flag.vehiclePlate ?? '—' },
                { k: t('exc.d.cust'), v: flag.customerName ?? '—' },
                { k: t('exc.d.at'), v: dt(e.receivedAt) },
                { k: t('exc.d.occurred'), v: dt(e.occurredAt) },
                { k: t('exc.d.source'), v: t(`exc.src.${e.source}` as MessageKey) },
                { k: t('exc.d.by'), v: flag.recordedByName ?? e.recordedBy ?? '—' },
              ]}
            />
            {res && (
              <KeyValues
                title={t('exc.d.resolution')}
                items={[
                  { k: t('exc.d.decision'), v: t(`exc.dec.${res.decision}` as MessageKey) },
                  { k: t('exc.d.reason'), v: res.reason },
                  { k: t('exc.d.resolvedBy'), v: flag.resolvedByName ?? res.resolvedBy ?? '—' },
                  { k: t('exc.d.resolvedAt'), v: dt(res.resolvedAt) },
                ]}
              />
            )}
          </>
        ) : seq.isError ? (
          <EmptyState icon="circle-alert" title={problemText(seq.error, t) ?? ''} />
        ) : !seq.data ? (
          <span style={{ color: '#3B424C' }}>{t('exc.seq.loading')}</span>
        ) : (
          <section style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <h3 style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>{t('exc.seq.title')}</h3>
            <ActivityTimeline
              items={seq.data.data.map((x) => {
                const b = SEQ_BADGE[x.seqStatus]!;
                return {
                  key: x.id,
                  title: (
                    <span style={{ fontWeight: x.id === flag.id ? 600 : 500 }}>
                      {eventLabel(t, x)}
                    </span>
                  ),
                  sub: t('exc.seq.sub', {
                    o: dt(x.occurredAt),
                    r: dt(x.receivedAt),
                    src: t(`exc.src.${x.source}` as MessageKey),
                  }),
                  badge: {
                    label: t(`exc.seq.${x.seqStatus}` as MessageKey),
                    tone: b.tone,
                    icon: b.icon,
                  },
                  ...(x.resolution
                    ? {
                        detail: `${t(`exc.dec.${x.resolution.decision}` as MessageKey)} — ${x.resolution.reason}`,
                      }
                    : {}),
                };
              })}
            />
          </section>
        )}
      </Drawer>
      <ReasonDialog
        open={dialog !== null}
        title={t(dialog === 'IGNORE' ? 'exc.dlg.ignoreTitle' : 'exc.dlg.resolveTitle', {
          no: flag.tripNo ?? '',
        })}
        description={`${type} · ${detail}`}
        diff={{
          labels: t('exc.dlg.cols').split('|') as [string, string, string],
          rows: [
            { f: t('exc.dlg.status'), b: t('exc.st.OPEN'), a: t('exc.st.RESOLVED') },
            {
              f: t('exc.dlg.use'),
              b: t('exc.dlg.pending'),
              a: t(dialog === 'IGNORE' ? 'exc.dec.IGNORE' : 'exc.dec.ACCEPT'),
            },
          ],
        }}
        label={t('exc.dlg.reason')}
        placeholder={t(dialog === 'IGNORE' ? 'exc.dlg.ignorePh' : 'exc.dlg.resolvePh')}
        hint={(n, ok) => (ok ? t('ord.dlg.hintOk') : t('ord.dlg.hintMin', { n }))}
        okLabel={dialog === 'IGNORE' ? t('exc.act.ignore') : t('exc.act.resolve')}
        okIcon={dialog === 'IGNORE' ? 'circle-slash' : 'circle-check'}
        cancelLabel={t('common.cancel')}
        closeLabel={t('drawer.close')}
        busy={resolve.isPending}
        error={resolve.error ? problemText(resolve.error, t) : null}
        onOk={(reason) => submit(dialog!, reason)}
        onClose={() => {
          setDialog(null);
          resolve.reset();
        }}
      />
    </>
  );
}
