import { Icon } from '@tms/ui';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { ApiError } from '../../api';
import { useI18n } from '../../i18n';
import type { MessageKey } from '../../i18n/th';
import { Toggle } from './Settings';
import {
  useBranches,
  useCompaniesAll,
  stepUp,
  useSaveTenantSettings,
  useTenantSettings,
} from './useSettings';

/**
 * ตั้งค่า → องค์กร / ภาษี / ความปลอดภัย (ST1-T17) — ฟอร์มตามต้นแบบ (vSet: org, taxR, wht, secT, sto) + ปุ่ม "บันทึก" ลอยมุมขวาล่าง
 * เลขผู้เสียภาษี/ที่อยู่มาจากนิติบุคคลหลัก (แก้ที่ "นิติบุคคลและสาขา" — ข้อมูลบนเอกสารภาษีผูกกับนิติบุคคล/สาขา)
 * IP allowlist ของต้นแบบเป็น P1 (spec/01 §13.6) — ยังไม่แสดง
 */
type Values = Record<string, unknown>;

function useDraft(keys: string[]) {
  const q = useTenantSettings();
  const save = useSaveTenantSettings();
  const server = useMemo(() => {
    const out: Values = {};
    for (const s of q.data?.data ?? []) if (keys.includes(s.key)) out[s.key] = s.value;
    return out;
  }, [q.data]); // eslint-disable-line react-hooks/exhaustive-deps
  const versions = useMemo(
    () => Object.fromEntries((q.data?.data ?? []).map((s) => [s.key, s.version])),
    [q.data],
  );
  const [draft, setDraft] = useState<Values>({});
  useEffect(() => setDraft(server), [server]);
  const dirty = Object.fromEntries(
    Object.entries(draft).filter(([k, v]) => JSON.stringify(server[k]) !== JSON.stringify(v)),
  );
  return {
    q,
    save,
    draft,
    versions,
    set: (k: string, v: unknown) => setDraft((d) => ({ ...d, [k]: v })),
    dirty,
  };
}

function Card({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section
      className="set-card"
      style={{
        padding: '20px 24px',
        display: 'flex',
        flexDirection: 'column',
        gap: 18,
        overflow: 'visible',
      }}
    >
      <h2>{title}</h2>
      {children}
    </section>
  );
}

const lbl = { fontSize: 12.5, fontWeight: 500, color: '#3B424C' } as const;

/** radio แบบ pill ของต้นแบบ (this.radio) */
function Radio({
  label,
  options,
  value,
  onChange,
  disabled,
}: {
  label: string;
  options: Array<{ v: unknown; l: string }>;
  value: unknown;
  onChange: (v: unknown) => void;
  disabled?: boolean;
}) {
  return (
    <div
      role="radiogroup"
      aria-label={label}
      style={{ display: 'flex', flexDirection: 'column', gap: 8 }}
    >
      <span style={lbl}>{label}</span>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
        {options.map((o) => {
          const on = o.v === value;
          return (
            <button
              key={String(o.v)}
              type="button"
              role="radio"
              aria-checked={on}
              disabled={disabled}
              onClick={() => onChange(o.v)}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                padding: '8px 12px',
                border: `1px solid ${on ? '#2257C4' : '#D9DCD4'}`,
                background: on ? '#EEF0EC' : '#FFFFFF',
                borderRadius: 14,
                cursor: disabled ? 'not-allowed' : 'pointer',
                color: '#101418',
                textAlign: 'left',
                font: 'inherit',
              }}
            >
              <span
                style={{
                  width: 16,
                  height: 16,
                  borderRadius: '50%',
                  border: `1.5px solid ${on ? '#2257C4' : '#C9CDC3'}`,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  flexShrink: 0,
                }}
              >
                <span
                  style={{
                    width: 8,
                    height: 8,
                    borderRadius: '50%',
                    background: on ? '#2257C4' : 'transparent',
                  }}
                />
              </span>
              {o.l}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function ToggleRow({
  label,
  on,
  onChange,
  disabled,
}: {
  label: string;
  on: boolean;
  onChange: () => void;
  disabled?: boolean;
}) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
      <Toggle on={on} onChange={onChange} disabled={disabled} label={label} />
      <span>{label}</span>
    </div>
  );
}

const inputStyle = {
  height: 36,
  padding: '0 10px',
  border: '1px solid #C9CDC3',
  borderRadius: 8,
  background: '#FFFFFF',
  color: '#101418',
  font: 'inherit',
} as const;

/** ปุ่ม "บันทึก" ลอย + toast ของต้นแบบ */
function SaveBar({
  dirty,
  onSave,
  busy,
  saved,
  error,
}: {
  dirty: boolean;
  onSave: () => void;
  busy: boolean;
  saved: string | null;
  error: string | null;
}) {
  const { t } = useI18n();
  return (
    <>
      {saved || error ? (
        <div
          role="status"
          style={{
            position: 'fixed',
            right: 24,
            bottom: 24,
            zIndex: 80,
            background: '#FFFFFF',
            border: '1px solid #D9DCD4',
            borderRadius: 14,
            boxShadow: '0 12px 32px rgba(16,24,40,.16)',
            padding: '12px 16px',
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            maxWidth: 440,
          }}
        >
          <span
            style={{
              width: 24,
              height: 24,
              borderRadius: 6,
              background: error ? '#B3322A' : '#17733F',
              color: '#FFFFFF',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              flexShrink: 0,
            }}
          >
            <Icon n={error ? 'x' : 'check'} s={14} />
          </span>
          <span>{error ?? saved}</span>
        </div>
      ) : (
        <div style={{ position: 'fixed', right: 24, bottom: 24, zIndex: 25 }}>
          <button
            type="button"
            onClick={onSave}
            disabled={busy}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 8,
              height: 40,
              padding: '0 16px',
              border: '1px solid #2257C4',
              borderRadius: 999,
              background: '#2257C4',
              color: '#FFFFFF',
              fontWeight: 500,
              cursor: 'pointer',
              whiteSpace: 'nowrap',
              boxShadow: '0 8px 20px rgba(16,24,40,.16)',
              font: 'inherit',
            }}
          >
            <Icon n="save" s={16} />
            {t('common.save')}
          </button>
        </div>
      )}
    </>
  );
}

function useSaveFlow(section: MessageKey, d: ReturnType<typeof useDraft>) {
  const { t } = useI18n();
  const [saved, setSaved] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** server ขอ step-up (ลดความปลอดภัย) → แสดงช่องกรอกรหัส 6 หลักในการ์ด */
  const [needStepUp, setNeedStepUp] = useState(false);
  useEffect(() => {
    if (!saved && !error) return;
    const id = setTimeout(() => {
      setSaved(null);
      setError(null);
    }, 3600);
    return () => clearTimeout(id);
  }, [saved, error]);
  const fail = (e: unknown) => {
    const code = e instanceof ApiError ? e.problem.code : 'internal_error';
    if (code === 'step_up_required') return setNeedStepUp(true);
    if (code === 'precondition_failed') void d.q.refetch();
    setError(t(`problem.${code}` as MessageKey));
  };
  const send = (stepUpToken?: string) =>
    d.save.mutate(
      {
        values: d.dirty,
        versions: Object.fromEntries(Object.keys(d.dirty).map((k) => [k, d.versions[k] ?? 0])),
        stepUp: stepUpToken,
      },
      {
        onSuccess: () => {
          setNeedStepUp(false);
          setSaved(t('set.saved', { section: t(section) }));
        },
        onError: fail,
      },
    );
  // ต้นแบบ: ปุ่มบันทึกกดได้เสมอ → ไม่มีอะไรเปลี่ยนก็แสดง toast เหมือนบันทึก (ไม่เรียก API)
  const onSave = () =>
    Object.keys(d.dirty).length === 0 ? setSaved(t('set.saved', { section: t(section) })) : send();
  const confirmStepUp = async (otp: string) => {
    try {
      send(await stepUp(otp));
    } catch (e) {
      fail(e);
    }
  };
  return {
    saved,
    error,
    onSave,
    needStepUp,
    cancelStepUp: () => setNeedStepUp(false),
    confirmStepUp,
  };
}

/** ยืนยัน 2FA อีกครั้งก่อนบันทึกค่าที่ลดความปลอดภัย — ต้นแบบไม่มี ([OPEN] spec/12) ใช้ช่อง/ปุ่มชุดเดียวกับหน้าตั้งค่า */
function StepUpBox({
  onConfirm,
  onCancel,
}: {
  onConfirm: (otp: string) => void;
  onCancel: () => void;
}) {
  const { t } = useI18n();
  const [otp, setOtp] = useState('');
  return (
    <div
      role="group"
      aria-label={t('stepUp.title')}
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
        padding: '12px 14px',
        background: '#F7F8F5',
        border: '1px solid #E4E6E0',
        borderRadius: 10,
        maxWidth: 420,
      }}
    >
      <span style={{ fontWeight: 600 }}>{t('stepUp.title')}</span>
      <span style={{ color: '#3B424C' }}>{t('stepUp.desc')}</span>
      <div style={{ display: 'flex', gap: 8 }}>
        <input
          aria-label={t('mfa.codeLabel')}
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={6}
          value={otp}
          onChange={(e) => setOtp(e.target.value.replace(/\D/g, ''))}
          style={{ ...inputStyle, width: 140, letterSpacing: '0.2em' }}
        />
        <button
          type="button"
          className="set-btn2"
          disabled={otp.length !== 6}
          onClick={() => onConfirm(otp)}
        >
          {t('mfa.submit')}
        </button>
        <button type="button" className="set-btn2" onClick={onCancel}>
          {t('common.cancel')}
        </button>
      </div>
    </div>
  );
}

export function OrgSection({ canWrite }: { canWrite: boolean }) {
  const { t } = useI18n();
  const d = useDraft(['org.name', 'org.timezone', 'org.yearStyle']);
  const flow = useSaveFlow('set.menu.org', d);
  const companies = useCompaniesAll();
  const branches = useBranches();
  const main = (companies.data?.data ?? []).find((c) => c.status === 'active');
  const hq = (branches.data?.data ?? []).find(
    (b) => b.companyId === main?.id && b.branchCode === '00000',
  );
  const addr = hq
    ? [
        hq.address.line1,
        hq.address.line2,
        hq.address.subdistrict,
        hq.address.district,
        hq.address.province,
        hq.address.postcode,
      ]
        .filter(Boolean)
        .join(' ')
    : '';
  const year = new Date().getFullYear();
  return (
    <Card title={t('set.menu.org')}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
        <div
          style={{
            width: 64,
            height: 64,
            borderRadius: 12,
            background: '#13213F',
            color: '#FFFFFF',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <Icon n="truck" s={28} />
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <span style={lbl}>{t('org.logo')}</span>
          <button
            type="button"
            className="set-btn2"
            disabled
            title={t('set.notReady', { stage: 'ST1-T08' })}
            style={{ alignSelf: 'flex-start' }}
          >
            <Icon n="upload" s={16} />
            {t('org.logoChange')}
          </button>
        </div>
      </div>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'minmax(0,1fr) minmax(0,1fr)',
          gap: '14px 16px',
        }}
      >
        <label style={{ display: 'flex', flexDirection: 'column', gap: 6, gridColumn: '1 / -1' }}>
          <span style={lbl}>{t('org.name')}</span>
          <input
            style={inputStyle}
            value={String(d.draft['org.name'] ?? '')}
            disabled={!canWrite}
            onChange={(e) => d.set('org.name', e.target.value)}
          />
        </label>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <span style={lbl}>{t('org.taxId')}</span>
          <input
            style={{ ...inputStyle, fontVariantNumeric: 'tabular-nums' }}
            value={main?.taxId ?? ''}
            readOnly
            disabled
            title={t('org.fromEntity')}
          />
        </label>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <span style={lbl}>{t('org.timezone')}</span>
          <select
            style={inputStyle}
            value={String(d.draft['org.timezone'] ?? 'Asia/Bangkok')}
            disabled={!canWrite}
            onChange={(e) => d.set('org.timezone', e.target.value)}
          >
            <option value="Asia/Bangkok">{t('org.tzBangkok')}</option>
          </select>
        </label>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 6, gridColumn: '1 / -1' }}>
          <span style={lbl}>{t('org.address')}</span>
          <textarea
            rows={3}
            value={addr}
            readOnly
            disabled
            title={t('org.fromEntity')}
            style={{
              border: '1px solid #C9CDC3',
              borderRadius: 8,
              padding: '8px 10px',
              color: '#101418',
              resize: 'vertical',
              font: 'inherit',
            }}
          />
        </label>
      </div>
      <Radio
        label={t('org.yearStyle')}
        value={d.draft['org.yearStyle']}
        disabled={!canWrite}
        onChange={(v) => d.set('org.yearStyle', v)}
        options={[
          { v: 'BE', l: t('org.yearBE', { y: year + 543 }) },
          { v: 'CE', l: t('org.yearCE', { y: year }) },
        ]}
      />
      {canWrite && (
        <SaveBar
          dirty={Object.keys(d.dirty).length > 0}
          busy={d.save.isPending}
          onSave={flow.onSave}
          saved={flow.saved}
          error={flow.error}
        />
      )}
    </Card>
  );
}

export function TaxSection({ canWrite }: { canWrite: boolean }) {
  const { t } = useI18n();
  const d = useDraft([
    'tax.vatDefault',
    'tax.invoiceModePolicy',
    'tax.wht1Enabled',
    'tax.wht3Enabled',
  ]);
  const flow = useSaveFlow('set.menu.tax', d);
  return (
    <Card title={t('set.menu.tax')}>
      <Radio
        label={t('tax.vatDefault')}
        value={d.draft['tax.vatDefault']}
        disabled={!canWrite}
        onChange={(v) => d.set('tax.vatDefault', v)}
        options={[
          { v: 'VAT_7', l: t('tax.vat7') },
          { v: 'EXEMPT_TRANSPORT', l: t('tax.vatExempt') },
        ]}
      />
      <Radio
        label={t('tax.mode')}
        value={d.draft['tax.invoiceModePolicy']}
        disabled={!canWrite}
        onChange={(v) => d.set('tax.invoiceModePolicy', v)}
        options={[
          { v: 'ON_PAYMENT', l: t('tax.modePayment') },
          { v: 'ON_ISSUE', l: t('tax.modeIssue') },
          { v: 'PER_CUSTOMER', l: t('tax.modeCustomer') },
        ]}
      />
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <span style={lbl}>{t('tax.whtEnabled')}</span>
        {(
          [
            ['tax.wht1Enabled', 'tax.wht1'],
            ['tax.wht3Enabled', 'tax.wht3'],
          ] as const
        ).map(([k, l]) => (
          <ToggleRow
            key={k}
            label={t(l)}
            on={d.draft[k] === true}
            disabled={!canWrite}
            onChange={() => d.set(k, !(d.draft[k] === true))}
          />
        ))}
      </div>
      {canWrite && (
        <SaveBar
          dirty={Object.keys(d.dirty).length > 0}
          busy={d.save.isPending}
          onSave={flow.onSave}
          saved={flow.saved}
          error={flow.error}
        />
      )}
    </Card>
  );
}

export function SecuritySection({ canWrite }: { canWrite: boolean }) {
  const { t } = useI18n();
  const d = useDraft([
    'security.require2faAll',
    'security.autoLogout',
    'security.idleTimeoutMinutes',
  ]);
  const flow = useSaveFlow('set.menu.sec', d);
  const auto = d.draft['security.autoLogout'] !== false;
  return (
    <Card title={t('set.menu.sec')}>
      <ToggleRow
        label={t('sec.require2fa')}
        on={d.draft['security.require2faAll'] === true}
        disabled={!canWrite}
        onChange={() =>
          d.set('security.require2faAll', !(d.draft['security.require2faAll'] === true))
        }
      />
      <ToggleRow
        label={t('sec.autoLogout')}
        on={auto}
        disabled={!canWrite}
        onChange={() => d.set('security.autoLogout', !auto)}
      />
      <label style={{ display: 'flex', flexDirection: 'column', gap: 6, maxWidth: 280 }}>
        <span style={lbl}>{t('sec.timeout')}</span>
        <select
          style={inputStyle}
          value={String(d.draft['security.idleTimeoutMinutes'] ?? 480)}
          disabled={!canWrite || !auto}
          onChange={(e) => d.set('security.idleTimeoutMinutes', Number(e.target.value))}
        >
          <option value="30">{t('sec.t30')}</option>
          <option value="60">{t('sec.t60')}</option>
          <option value="480">{t('sec.t480')}</option>
        </select>
      </label>
      {flow.needStepUp && (
        <StepUpBox onConfirm={(otp) => void flow.confirmStepUp(otp)} onCancel={flow.cancelStepUp} />
      )}
      {canWrite && (
        <SaveBar
          dirty={Object.keys(d.dirty).length > 0}
          busy={d.save.isPending}
          onSave={flow.onSave}
          saved={flow.saved}
          error={flow.error}
        />
      )}
    </Card>
  );
}
