import { Button, DataTable, DocNo, EmptyState, StatusDot, Tag, type Column } from '@tms/ui';
import { useState } from 'react';
import { formatDateTime, useI18n } from '../../i18n';
import { tableLabels } from '../companies/CompanySample';
import { problemText } from '../master/problems';
import type { QueueTab } from './erpq';
import {
  classKey,
  isErrorClass,
  queueErrorText,
  queueFields,
  queueStatusKey,
  queueType,
  type QueueItem,
} from './queue';
import { QueueDialog, type QueueDialogKind } from './QueueDialogs';
import { QueueDrawer } from './QueueDrawer';
import { useQueueAction, useQueueList } from './useQueue';

export type ColFilter = { no: string; type: string; cust: string; fields: string; st: string };

/**
 * ตารางแท็บคิว รอคิว / ล้มเหลว / สำเร็จ (PO #86 24 พ.ย. 2569 — ต้นแบบ `erp` specErp: คอลัมน์ เลขเอกสาร / ประเภท / ลูกค้า / ฟิลด์ที่ต่าง /
 * ครั้งที่ส่ง / ส่งล่าสุด / สถานะ · เมนูแถว ดูรายละเอียด / ส่งซ้ำ / … / ดู log) — รายการ = `GET /connectors/{id}/queue?tab=`
 * แท็บล้มเหลว "จัดกลุ่มตาม ErrorClass" (docs/01 §6.4) = ตัวกรองคอลัมน์สถานะเป็นกลุ่ม ErrorClass + ตัวนับ (`failedByClass`) → API `errorClass`
 * เมนูแถวเพิ่ม (docs): ข้ามพร้อมเหตุผล · กรอกเลขเอง · อนุมัติแทนที่ (ST8-T13) — แสดงตาม `actions` ของรายการ + สิทธิ์
 */
export function QueuePanel({
  connectorId,
  erp,
  tab,
  col,
  setCol,
  hidden,
  setHidden,
  byClass,
  canAct,
  canApprove,
  onToast,
}: {
  connectorId: string;
  erp: string;
  tab: QueueTab;
  col: ColFilter;
  setCol: (f: (c: ColFilter) => ColFilter) => void;
  hidden: string[] | null;
  setHidden: (h: string[] | null) => void;
  byClass: Record<string, number>;
  canAct: boolean;
  canApprove: boolean;
  onToast: (m: string) => void;
}) {
  const { t, lang } = useI18n();
  const cls = tab === 'failed' && isErrorClass(col.st) ? col.st : '';
  const list = useQueueList(connectorId, tab, cls);
  const act = useQueueAction(connectorId);
  const [open, setOpen] = useState<string | null>(null);
  const [ptab, setPtab] = useState('sum');
  const [dialog, setDialog] = useState<{ kind: QueueDialogKind; x: QueueItem } | null>(null);
  const shown = list.rows.filter(
    (x) =>
      (!col.no || (x.documentNo ?? '').includes(col.no)) &&
      (!col.type || x.entityType === col.type) &&
      (!col.cust || (x.partyName ?? '').includes(col.cust)) &&
      (!col.fields || queueFields(x).includes(col.fields)),
  );
  const cur = open ? (list.rows.find((x) => x.id === open) ?? null) : null;
  const view = (x: QueueItem, p = 'sum') => {
    setPtab(p);
    setOpen(x.id);
  };
  const retry = (x: QueueItem) =>
    act.mutate(
      { action: 'retry', id: x.id },
      {
        onSuccess: () => {
          setOpen(null);
          onToast(t('erpq.qt.retry', { no: x.documentNo ?? x.id, erp }));
        },
        onError: (e) => onToast(queueErrorText(e, t) ?? t('erpq.loadError')),
      },
    );
  const ask = (kind: QueueDialogKind, x: QueueItem) => setDialog({ kind, x });
  const classes = Object.keys(byClass).filter(isErrorClass);

  const columns: Column<QueueItem>[] = [
    {
      key: 'no',
      label: t('erpq.col.no'),
      width: '1%',
      filter: { type: 'text', placeholder: t('table.search') },
      render: (x) => <DocNo>{x.documentNo ?? '—'}</DocNo>,
      csv: (x) => x.documentNo ?? '',
    },
    {
      key: 'type',
      label: t('erpq.col.type'),
      width: '1%',
      filter: {
        type: 'select',
        options: [
          { value: '', label: t('table.all') },
          { value: 'invoice', label: t('erpq.type.INVOICE') },
          { value: 'settlement', label: t('erpq.type.SETTLEMENT') },
        ],
      },
      render: (x) => <Tag>{queueType(t, x)}</Tag>,
      csv: (x) => queueType(t, x),
    },
    {
      key: 'cust',
      label: t('erpq.col.cust'),
      filter: { type: 'text', placeholder: t('table.search') },
      render: (x) => <span style={{ color: '#101418' }}>{x.partyName ?? '—'}</span>,
      csv: (x) => x.partyName ?? '',
    },
    {
      key: 'fields',
      label: t('erpq.col.fields'),
      filter: { type: 'text', placeholder: t('table.search') },
      render: (x) => {
        const f = queueFields(x);
        return <span style={{ color: f === '—' ? '#3B424C' : '#101418' }}>{f}</span>;
      },
      csv: (x) => queueFields(x),
    },
    {
      key: 'att',
      label: t('erpq.col.att'),
      align: 'right',
      width: '1%',
      render: (x) => <span className="tms-num">{x.attempt}</span>,
      csv: (x) => String(x.attempt),
    },
    {
      key: 'last',
      label: t('erpq.col.last'),
      width: '1%',
      render: (x) => (
        <span style={{ whiteSpace: 'nowrap' }}>{formatDateTime(x.updatedAt, lang)}</span>
      ),
      csv: (x) => formatDateTime(x.updatedAt, lang),
    },
    {
      key: 'st',
      label: t('erpq.col.st'),
      width: '1%',
      ...(tab === 'failed'
        ? {
            filter: {
              type: 'select' as const,
              options: [
                { value: '', label: t('table.all') },
                ...classes.map((c) => ({
                  value: c,
                  label: `${t(classKey(c))} (${byClass[c]})`,
                })),
              ],
            },
          }
        : {}),
      render: (x) => <StatusDot label={t(queueStatusKey(x))} />,
      csv: (x) => t(queueStatusKey(x)),
    },
  ];

  return (
    <>
      {list.q.isError ? (
        <EmptyState
          icon="circle-alert"
          title={t('erpq.loadError')}
          description={problemText(list.q.error, t) ?? ''}
          action={
            <Button variant="secondary" icon="refresh-cw" onClick={() => list.q.refetch()}>
              {t('cust.retry')}
            </Button>
          }
        />
      ) : (
        <DataTable
          columns={columns}
          rows={shown}
          rowId={(x) => x.id}
          activeId={open}
          loading={list.loading}
          labels={tableLabels(t)}
          filters={{ ...col, st: tab === 'failed' ? cls : '' }}
          hiddenColumns={hidden}
          onHiddenColumnsChange={setHidden}
          onFilterChange={(k, v) => setCol((c) => ({ ...c, [k]: v }))}
          onRowClick={(x) => view(x)}
          rowMenu={(x) => [
            { label: t('erpq.menu.view'), icon: 'eye', run: () => view(x) },
            ...(canAct && x.actions.retry
              ? [{ label: t('erpq.q.retry'), icon: 'refresh-cw', run: () => retry(x) }]
              : []),
            ...(canApprove && x.actions.approve
              ? [{ label: t('erpq.q.approve'), icon: 'refresh-cw', run: () => ask('approve', x) }]
              : []),
            ...(canAct && x.actions.skip
              ? [{ label: t('erpq.q.skip'), icon: 'skip-forward', run: () => ask('skip', x) }]
              : []),
            ...(canAct && x.actions.externalId
              ? [{ label: t('erpq.q.extId'), icon: 'file-pen', run: () => ask('externalId', x) }]
              : []),
            { label: t('erpq.menu.log'), icon: 'history', run: () => view(x, 'log') },
          ]}
          empty={
            <EmptyState
              icon="inbox"
              title={t('table.emptyTitle')}
              description={t('table.emptyDesc')}
            />
          }
          page={list.page}
          onPageSize={list.setSize}
          onNext={list.next}
          onPrev={list.prev}
          onGoto={list.goto}
        />
      )}
      {cur && (
        <QueueDrawer
          x={cur}
          erp={erp}
          connectorId={connectorId}
          tab={ptab}
          onTab={setPtab}
          canAct={canAct}
          canApprove={canApprove}
          onClose={() => setOpen(null)}
          onRetry={retry}
          onAsk={ask}
        />
      )}
      {dialog && (
        <QueueDialog
          kind={dialog.kind}
          x={dialog.x}
          erp={erp}
          connectorId={connectorId}
          onClose={() => setDialog(null)}
          onDone={(msg) => {
            setDialog(null);
            setOpen(null);
            onToast(msg);
          }}
        />
      )}
    </>
  );
}
