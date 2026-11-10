import { Drawer, DrawerFooterButtons, Field, Icon, TextInput } from '@tms/ui';
import { useState, type FormEvent } from 'react';
import { ApiError } from '../../api';
import { useI18n } from '../../i18n';
import type { MessageKey } from '../../i18n/th';
import { CompanyDrawer, fieldErrors } from '../companies/CompanySample';
import type { Company } from '../companies/useCompanies';
import { Toggle } from './Settings';
import { useBranches, useCompaniesAll, useSaveBranch, type Branch } from './useSettings';

const HQ = '00000';

/**
 * ตั้งค่า → นิติบุคคลและสาขา (ST1-T14) — ตารางของต้นแบบ
 * สวิตช์ "ใช้ออกใบกำกับ" = สาขาออกใบกำกับภาษีในนามตัวเอง; ปิด = สำนักงานใหญ่ออกแทน (คำตอบ PO 10 พ.ย. 2569)
 * ฟอร์มเพิ่ม/แก้เป็น Drawer แบบเดียวกับต้นแบบ (คำตอบ PO 10 พ.ย. 2569 — spec/12 §3)
 */
export function EntitiesSection({ canWrite }: { canWrite: boolean }) {
  const { t } = useI18n();
  const companies = useCompaniesAll();
  const branches = useBranches();
  const save = useSaveBranch();
  const [drawer, setDrawer] = useState<{ branch: Branch | null } | null>(null);
  const [companyDrawer, setCompanyDrawer] = useState<Company | 'new' | null>(null);

  const cos = companies.data?.data ?? [];
  const brs = branches.data?.data ?? [];
  const rows = cos.flatMap((c) => {
    const own = brs
      .filter((b) => b.companyId === c.id)
      .sort((a, b) => a.branchCode.localeCompare(b.branchCode));
    return own.length ? own.map((b) => ({ c, b })) : [{ c, b: null as Branch | null }];
  });

  return (
    <section className="set-card">
      <div className="set-card__hd">
        <h2>{t('set.menu.ent')}</h2>
        {canWrite && (
          <button type="button" className="set-btn2" onClick={() => setDrawer({ branch: null })}>
            <Icon n="plus" s={16} />
            {t('ent.addBranch')}
          </button>
        )}
      </div>
      <table className="set-tbl">
        <thead>
          <tr>
            <th>{t('ent.col.name')}</th>
            <th>{t('ent.col.tax')}</th>
            <th>{t('ent.col.branch')}</th>
            <th>{t('ent.col.issue')}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(({ c, b }) => (
            <tr
              key={b?.id ?? c.id}
              className={canWrite ? 'click' : undefined}
              onClick={() =>
                canWrite && (b ? setDrawer({ branch: b }) : setCompanyDrawer(c as Company))
              }
            >
              <td>
                {b
                  ? b.branchCode === HQ
                    ? `${c.legalName} (${b.branchLabel})`
                    : `${c.legalName} ${b.branchLabel}`
                  : c.legalName}
              </td>
              <td className="num">{c.taxId}</td>
              <td className="num">{b?.branchCode ?? '—'}</td>
              <td>
                {b && (
                  <Toggle
                    on={c.vatRegistered && b.issuesTaxInvoice}
                    label={t('ent.col.issue')}
                    disabled={
                      !canWrite || !c.vatRegistered || b.branchCode === HQ || save.isPending
                    }
                    onChange={() =>
                      save.mutate({
                        id: b.id,
                        version: b.version,
                        body: { issuesTaxInvoice: !b.issuesTaxInvoice },
                      })
                    }
                  />
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {drawer && (
        <BranchDrawer
          branch={drawer.branch}
          companies={cos as Company[]}
          onClose={() => setDrawer(null)}
          onNewCompany={() => setCompanyDrawer('new')}
          onEditCompany={(c) => setCompanyDrawer(c)}
        />
      )}
      {companyDrawer && (
        <CompanyDrawer
          company={companyDrawer === 'new' ? null : companyDrawer}
          mode={companyDrawer === 'new' ? 'create' : 'edit'}
          setMode={(m) => m === 'view' && setCompanyDrawer(null)}
          onSaved={() => setCompanyDrawer(null)}
          onClose={() => setCompanyDrawer(null)}
          statusLabel={(s) => (s === 'active' ? t('company.active') : t('company.inactive'))}
        />
      )}
    </section>
  );
}

const ADDRESS_FIELDS = [
  'line1',
  'line2',
  'subdistrict',
  'district',
  'province',
  'postcode',
] as const;

function BranchDrawer({
  branch,
  companies,
  onClose,
  onNewCompany,
  onEditCompany,
}: {
  branch: Branch | null;
  companies: Company[];
  onClose: () => void;
  onNewCompany: () => void;
  onEditCompany: (c: Company) => void;
}) {
  const { t } = useI18n();
  const save = useSaveBranch();
  const company = companies.find((c) => c.id === branch?.companyId);
  const [form, setForm] = useState({
    companyId: branch?.companyId ?? companies[0]?.id ?? '',
    branchCode: branch?.branchCode ?? '',
    branchLabel: branch?.branchLabel ?? '',
    issuesTaxInvoice: branch?.issuesTaxInvoice ?? true,
    isDefaultIssuer: branch?.isDefaultIssuer ?? false,
    address: {
      line1: branch?.address.line1 ?? '',
      line2: branch?.address.line2 ?? '',
      subdistrict: branch?.address.subdistrict ?? '',
      district: branch?.address.district ?? '',
      province: branch?.address.province ?? '',
      postcode: branch?.address.postcode ?? '',
    },
  });
  const errs = fieldErrors(save.error, t);
  const topError =
    save.error instanceof ApiError ? t(`problem.${save.error.problem.code}` as MessageKey) : null;
  const isHq = form.branchCode === HQ;
  // เปิด drawer ก่อนรายการนิติบุคคลโหลดเสร็จ → ใช้ตัวแรกที่โหลดมาแทนค่าว่าง (QA พบ 10 พ.ย. 2569)
  const companyId = form.companyId || companies[0]?.id || '';

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const address = Object.fromEntries(
      Object.entries(form.address).filter(([k, v]) => k !== 'line2' || v),
    );
    const body: Record<string, unknown> = {
      address,
      issuesTaxInvoice: isHq || form.issuesTaxInvoice,
      ...(form.branchLabel ? { branchLabel: form.branchLabel } : {}),
    };
    if (!branch?.isDefaultIssuer) body.isDefaultIssuer = form.isDefaultIssuer;
    if (!branch) Object.assign(body, { companyId, branchCode: form.branchCode });
    save.mutate(branch ? { id: branch.id, version: branch.version, body } : { body }, {
      onSuccess: onClose,
    });
  };

  const check = (
    key: 'issuesTaxInvoice' | 'isDefaultIssuer',
    label: MessageKey,
    disabled: boolean,
  ) => (
    <label className="tms-field" style={{ gridColumn: '1 / -1' }}>
      <span style={{ display: 'flex', alignItems: 'center', gap: 10, minHeight: 28 }}>
        <input
          type="checkbox"
          className="set-check"
          checked={form[key]}
          disabled={disabled}
          onChange={(e) => setForm({ ...form, [key]: e.target.checked })}
        />
        {t(label)}
      </span>
    </label>
  );

  return (
    <Drawer
      open
      onClose={onClose}
      kind={t('ent.kind')}
      title={branch ? `${company?.legalName ?? ''} ${branch.branchLabel}` : t('ent.addBranch')}
      subtitle={branch ? `${t('ent.col.branch')} ${branch.branchCode}` : undefined}
      labels={{ close: t('drawer.close'), more: t('drawer.more') }}
      menu={
        branch && company
          ? [{ label: t('ent.editCompany'), icon: 'pencil', onClick: () => onEditCompany(company) }]
          : undefined
      }
      footer={
        <DrawerFooterButtons
          secondary={[{ label: t('common.cancel'), onClick: onClose }]}
          primary={{
            label: t('common.save'),
            icon: 'check',
            type: 'submit',
            form: 'branch-form',
            disabled: save.isPending,
          }}
        />
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
      <form
        id="branch-form"
        onSubmit={submit}
        style={{
          display: 'grid',
          gridTemplateColumns: 'minmax(0,1fr) minmax(0,1fr)',
          gap: '14px 16px',
        }}
      >
        <div style={{ gridColumn: '1 / -1' }}>
          <Field
            label={t('company.kind')}
            error={errs.companyId}
            hint={
              !branch && (
                <button
                  type="button"
                  onClick={onNewCompany}
                  style={{
                    border: 0,
                    padding: 0,
                    background: 'none',
                    color: '#2257C4',
                    cursor: 'pointer',
                    font: 'inherit',
                  }}
                >
                  + {t('company.add')}
                </button>
              )
            }
          >
            {(a) => (
              <select
                {...a}
                className="tms-input"
                value={companyId}
                disabled={!!branch}
                onChange={(e) => setForm({ ...form, companyId: e.target.value })}
              >
                {companies.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.legalName}
                  </option>
                ))}
              </select>
            )}
          </Field>
        </div>
        <Field label={t('ent.col.branch')} error={errs.branchCode} hint={t('ent.codeHint')}>
          {(a) => (
            <TextInput
              {...a}
              value={form.branchCode}
              disabled={!!branch}
              inputMode="numeric"
              maxLength={5}
              onChange={(e) => setForm({ ...form, branchCode: e.target.value })}
            />
          )}
        </Field>
        <Field label={t('ent.label')} error={errs.branchLabel} hint={t('ent.labelHint')}>
          {(a) => (
            <TextInput
              {...a}
              value={form.branchLabel}
              onChange={(e) => setForm({ ...form, branchLabel: e.target.value })}
            />
          )}
        </Field>
        {ADDRESS_FIELDS.map((k) => (
          <div
            key={k}
            style={k === 'line1' || k === 'line2' ? { gridColumn: '1 / -1' } : undefined}
          >
            <Field label={t(`ent.addr.${k}`)} error={errs[`address.${k}`]}>
              {(a) => (
                <TextInput
                  {...a}
                  value={form.address[k]}
                  inputMode={k === 'postcode' ? 'numeric' : undefined}
                  maxLength={k === 'postcode' ? 5 : undefined}
                  onChange={(e) =>
                    setForm({ ...form, address: { ...form.address, [k]: e.target.value } })
                  }
                />
              )}
            </Field>
          </div>
        ))}
        {check('issuesTaxInvoice', 'ent.issueOwn', isHq)}
        {check('isDefaultIssuer', 'ent.default', !!branch?.isDefaultIssuer)}
      </form>
    </Drawer>
  );
}
