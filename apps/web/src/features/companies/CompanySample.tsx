import {
  Badge,
  Button,
  DataTable,
  DocNo,
  Drawer,
  DrawerFooterButtons,
  EmptyState,
  Field,
  KeyValues,
  StatusDot,
  TextInput,
  type Column,
} from '@tms/ui';
import { useEffect, useState, type FormEvent } from 'react';
import { ApiError } from '../../api';
import { formatDateTime, useI18n, type T } from '../../i18n';
import type { MessageKey } from '../../i18n/th';
import {
  useChangeCompanyStatus,
  useCompanyList,
  useSaveCompany,
  type Company,
} from './useCompanies';

/** ตัวอย่าง ST0-T14: รายการ → drawer → ฟอร์ม ใช้ component ของ @tms/ui ล้วน และเรียก /v1/companies จริง */
export function CompanySample() {
  const { t, lang } = useI18n();
  const list = useCompanyList();
  const [openId, setOpenId] = useState<string | null>(null);
  const [mode, setMode] = useState<'view' | 'edit' | 'create' | 'status'>('view');
  // drawer ถือข้อมูลของตัวเอง — ไม่ปิดเองเมื่อแถวหลุดจากผลกรอง/หน้าปัจจุบันหลังแก้ไข
  const [selected, setSelected] = useState<Company | null>(null);
  const current = openId ? (list.rows.find((r) => r.id === openId) ?? selected) : null;
  const statusLabel = (s: string) => (s === 'active' ? t('company.active') : t('company.inactive'));

  const columns: Column<Company>[] = [
    {
      key: 'legalName',
      label: t('company.legalName'),
      render: (r) => <span style={{ color: '#101418' }}>{r.legalName}</span>,
      csv: (r) => r.legalName,
    },
    {
      key: 'taxId',
      label: t('company.taxId'),
      render: (r) => <DocNo>{r.taxId}</DocNo>,
      csv: (r) => r.taxId,
    },
    {
      key: 'vat',
      label: t('company.vat'),
      render: (r) => (r.vatRegistered ? t('company.yes') : t('company.no')),
      csv: (r) => String(r.vatRegistered),
    },
    {
      key: 'status',
      label: t('company.status'),
      filter: {
        type: 'select',
        options: [
          { value: '', label: t('table.all') },
          { value: 'active', label: t('company.active') },
          { value: 'inactive', label: t('company.inactive') },
        ],
      },
      render: (r) => (
        <StatusDot label={statusLabel(r.status)} tone={r.status === 'active' ? 'ok' : 'off'} />
      ),
      csv: (r) => r.status,
    },
    {
      key: 'updatedAt',
      label: t('company.updatedAt'),
      render: (r) => <span style={{ color: '#3B424C' }}>{formatDateTime(r.updatedAt, lang)}</span>,
      csv: (r) => r.updatedAt,
    },
  ];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div className="tms-toolbar">
        <Button
          variant="secondary"
          size="sm"
          icon="plus"
          onClick={() => {
            setOpenId(null);
            setMode('create');
          }}
        >
          {t('company.add')}
        </Button>
        <span style={{ marginLeft: 'auto', color: '#3B424C', fontSize: 13 }}>
          {t('table.total', { n: list.page.rowsOnPage })}
        </span>
      </div>
      <DataTable
        columns={columns}
        rows={list.rows}
        rowId={(r) => r.id}
        activeId={openId}
        loading={list.q.isLoading}
        labels={tableLabels(t)}
        filters={{ status: list.status }}
        onFilterChange={(k, v) => k === 'status' && list.setStatus(v)}
        onRowClick={(r) => {
          setOpenId(r.id);
          setSelected(r);
          setMode('view');
        }}
        rowMenu={(r) => [
          {
            label: t('common.edit'),
            icon: 'pencil',
            run: () => {
              setOpenId(r.id);
              setSelected(r);
              setMode('edit');
            },
          },
        ]}
        empty={<EmptyState title={t('company.emptyTitle')} description={t('company.emptyDesc')} />}
        page={list.page}
        onPageSize={list.setSize}
        onNext={list.next}
        onPrev={list.prev}
        onGoto={list.goto}
      />
      {(mode === 'create' || current) && (
        <CompanyDrawer
          key={`${openId}-${mode}`}
          company={mode === 'create' ? null : current}
          mode={mode}
          setMode={setMode}
          onSaved={setSelected}
          onClose={() => {
            setOpenId(null);
            setSelected(null);
            setMode('view');
          }}
          statusLabel={statusLabel}
        />
      )}
    </div>
  );
}

export function tableLabels(t: T) {
  return {
    columns: t('table.columns'),
    options: t('table.options'),
    shownColumns: t('table.shownColumns'),
    tableOptions: t('table.tableOptions'),
    showFilters: t('table.showFilters'),
    dense: t('table.dense'),
    exportCsv: t('table.exportCsv'),
    resetColumns: t('table.resetColumns'),
    rowsPerPage: t('table.rowsPerPage'),
    selected: (n: number) => t('table.selected', { n }),
    clearSelection: t('table.clearSelection'),
    rowActions: t('table.rowActions'),
    prev: t('table.prev'),
    next: t('table.next'),
    range: (from: number, to: number) => t('table.range', { from, to }),
    rangeOf: (from: number, to: number, n: number) => t('table.rangeOf', { from, to, n }),
    none: t('table.none'),
    loading: t('table.loading'),
  };
}

/** ข้อความ error ราย field จาก problem+json errors[] → แปลจาก code (plan/02 T-11) */
export function fieldErrors(err: unknown, t: T): Record<string, string> {
  if (!(err instanceof ApiError)) return {};
  const out: Record<string, string> = {};
  for (const e of err.problem.errors ?? []) {
    const key = `field.${e.code}` as MessageKey;
    out[e.field] = t(key) === key ? e.message : t(key);
  }
  return out;
}

export function CompanyDrawer({
  company,
  mode,
  setMode,
  onSaved,
  onClose,
  statusLabel,
}: {
  company: Company | null;
  mode: 'view' | 'edit' | 'create' | 'status';
  setMode: (m: 'view' | 'edit' | 'create' | 'status') => void;
  onSaved: (c: Company) => void;
  onClose: () => void;
  statusLabel: (s: string) => string;
}) {
  const { t, lang } = useI18n();
  const save = useSaveCompany();
  const change = useChangeCompanyStatus();
  const [form, setForm] = useState({
    legalName: company?.legalName ?? '',
    legalNameEn: company?.legalNameEn ?? '',
    taxId: company?.taxId ?? '',
    vatRegistered: company?.vatRegistered ?? true,
  });
  const [reason, setReason] = useState('');
  useEffect(() => save.reset(), [mode]); // eslint-disable-line react-hooks/exhaustive-deps
  const errs = { ...fieldErrors(save.error, t), ...fieldErrors(change.error, t) };
  const topError =
    (save.error ?? change.error) instanceof ApiError
      ? t(`problem.${((save.error ?? change.error) as ApiError).problem.code}` as MessageKey)
      : null;
  const action = company?.status === 'active' ? 'deactivate' : 'activate';

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (mode === 'status' && company) {
      change.mutate(
        { id: company.id, action, reason },
        {
          onSuccess: (c) => {
            onSaved(c as Company);
            setMode('view');
          },
        },
      );
      return;
    }
    const body: Record<string, unknown> = {
      legalName: form.legalName,
      vatRegistered: form.vatRegistered,
    };
    if (form.legalNameEn) body.legalNameEn = form.legalNameEn;
    if (mode === 'create') body.taxId = form.taxId;
    save.mutate(company ? { id: company.id, version: company.version, body } : { body }, {
      onSuccess: (c) => {
        if (!company) return onClose();
        onSaved(c as Company);
        setMode('view');
      },
    });
  };

  const editing = mode === 'edit' || mode === 'create' || mode === 'status';
  return (
    <Drawer
      open
      onClose={onClose}
      kind={t('company.kind')}
      title={company ? company.legalName : t('company.add')}
      badge={
        company ? (
          <Badge
            label={statusLabel(company.status)}
            tone={company.status === 'active' ? 'ok' : 'off'}
            icon={company.status === 'active' ? 'check' : 'pause'}
          />
        ) : undefined
      }
      subtitle={company ? `${t('company.taxId')} ${company.taxId}` : undefined}
      labels={{ close: t('drawer.close'), more: t('drawer.more') }}
      menu={
        company && mode === 'view'
          ? [
              { label: t('common.edit'), icon: 'pencil', onClick: () => setMode('edit') },
              {
                label: t(`company.${action}`),
                icon: action === 'deactivate' ? 'pause' : 'play',
                onClick: () => setMode('status'),
                danger: action === 'deactivate',
              },
            ]
          : undefined
      }
      tabs={company ? [{ key: 'sum', label: t('drawer.tab.sum') }] : undefined}
      tab="sum"
      footer={
        editing ? (
          <DrawerFooterButtons
            secondary={[
              { label: t('common.cancel'), onClick: () => (company ? setMode('view') : onClose()) },
            ]}
            primary={{
              label: mode === 'status' ? t(`company.${action}`) : t('common.save'),
              icon: 'check',
              type: 'submit',
              form: 'company-form',
              disabled: save.isPending || change.isPending,
            }}
          />
        ) : (
          <DrawerFooterButtons
            secondary={[{ label: t('common.edit'), onClick: () => setMode('edit') }]}
          />
        )
      }
    >
      {topError && (
        <div
          role="alert"
          style={{
            padding: '10px 16px',
            background: '#FBE9E7',
            border: '1px solid #B3322A',
            borderRadius: 12,
            color: '#B3322A',
            fontWeight: 600,
          }}
        >
          {topError}
        </div>
      )}
      {mode === 'view' && company && (
        <KeyValues
          title={t('drawer.info')}
          items={[
            { k: t('company.legalName'), v: company.legalName },
            { k: t('company.legalNameEn'), v: company.legalNameEn ?? '—' },
            { k: t('company.taxId'), v: company.taxId },
            { k: t('company.vat'), v: company.vatRegistered ? t('company.yes') : t('company.no') },
            { k: t('company.updatedAt'), v: formatDateTime(company.updatedAt, lang) },
          ]}
        />
      )}
      {editing && (
        <form
          id="company-form"
          onSubmit={submit}
          style={{
            display: 'grid',
            gridTemplateColumns: 'minmax(0,1fr) minmax(0,1fr)',
            gap: '14px 16px',
          }}
        >
          {mode === 'status' ? (
            <div style={{ gridColumn: '1 / -1' }}>
              <Field label={t('company.reason')} hint={t('company.reasonHint')} error={errs.reason}>
                {(a) => (
                  <TextInput
                    {...a}
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                    required
                  />
                )}
              </Field>
            </div>
          ) : (
            <>
              <div style={{ gridColumn: '1 / -1' }}>
                <Field label={t('company.legalName')} error={errs.legalName}>
                  {(a) => (
                    <TextInput
                      {...a}
                      value={form.legalName}
                      onChange={(e) => setForm({ ...form, legalName: e.target.value })}
                    />
                  )}
                </Field>
              </div>
              <div style={{ gridColumn: '1 / -1' }}>
                <Field label={t('company.legalNameEn')} error={errs.legalNameEn}>
                  {(a) => (
                    <TextInput
                      {...a}
                      value={form.legalNameEn}
                      onChange={(e) => setForm({ ...form, legalNameEn: e.target.value })}
                    />
                  )}
                </Field>
              </div>
              <Field label={t('company.taxId')} error={errs.taxId}>
                {(a) => (
                  <TextInput
                    {...a}
                    value={form.taxId}
                    disabled={mode !== 'create'}
                    inputMode="numeric"
                    maxLength={13}
                    onChange={(e) => setForm({ ...form, taxId: e.target.value })}
                  />
                )}
              </Field>
              <label className="tms-field" style={{ justifyContent: 'flex-end' }}>
                <span style={{ display: 'flex', alignItems: 'center', gap: 10, minHeight: 36 }}>
                  <input
                    type="checkbox"
                    checked={form.vatRegistered}
                    onChange={(e) => setForm({ ...form, vatRegistered: e.target.checked })}
                    style={{ width: 16, height: 16, accentColor: '#2257C4', margin: 0 }}
                  />
                  {t('company.vat')}
                </span>
              </label>
            </>
          )}
        </form>
      )}
    </Drawer>
  );
}
