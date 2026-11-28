import { useMutation, useQuery } from '@tanstack/react-query';
import { color, Icon, useEscapeLayer, useModalFocus } from '@tms/ui';
import { useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, unwrap } from '../api';
import { formatDate, useI18n } from '../i18n';
import type { MessageKey } from '../i18n/th';

/** ข้อมูลที่แถบต้องใช้ (ส่วนหนึ่งของ GET /v1/me) */
export interface BannerInput {
  impersonating: boolean;
  status: string;
  account: {
    trialEndsAt: string | null;
    trialDaysLeft: number | null;
    pastDueSince: string | null;
    readOnlyInDays: number | null;
    cancelAtPeriodEnd: boolean;
    currentPeriodEnd: string | null;
    vehicles: { active: number; limit: number | null };
    accountingSoftware: string | null;
  };
}

export type BannerKind =
  'read_only' | 'past_due' | 'pending' | 'trial_soon' | 'quota' | 'trial' | 'cancel';

/** แถบที่ปิดได้ (spec/01 §5 คอลัมน์ "ปิดได้") — ปิดแล้วกลับมาวันถัดไป */
export const DISMISSIBLE: readonly BannerKind[] = ['trial', 'quota', 'cancel'];

/** ปลายทาง "ดูสถานะ" ของ pending_verification — หน้าตั้งค่า → ข้อมูลบริษัท */
export const PENDING_STATUS_PATH = '/settings?sec=org';

/** quota ≥ 90% (spec/01 §5 · §7) */
export const QUOTA_WARN = 0.9;

/**
 * PLT-050 แสดงทีละ 1 แถบตามลำดับ: impersonation > read_only > past_due > pending_verification > trial ≤ 7 > quota > trial > 7
 * > cancelAtPeriodEnd · impersonation ใช้แถบลอยส้มของ AppShell (ImpersonationBanner) → ที่นี่ไม่แสดงอะไร
 * `dismissed` = ชนิดที่ผู้ใช้ปิดไว้วันนี้ (ข้ามไปชนิดถัดไป)
 */
export function pickBanner(
  m: BannerInput,
  dismissed: readonly BannerKind[] = [],
): BannerKind | null {
  if (m.impersonating) return null;
  const a = m.account;
  const q = a.vehicles.limit && a.vehicles.active / a.vehicles.limit >= QUOTA_WARN;
  const cand: [BannerKind, boolean][] = [
    ['read_only', m.status === 'read_only'],
    ['past_due', m.status === 'past_due'],
    ['pending', m.status === 'pending_verification'],
    ['trial_soon', m.status === 'trialing' && a.trialDaysLeft !== null && a.trialDaysLeft <= 7],
    ['quota', !!q],
    ['trial', m.status === 'trialing' && a.trialDaysLeft !== null && a.trialDaysLeft > 7],
    ['cancel', a.cancelAtPeriodEnd],
  ];
  const hit = cand.find(([k, on]) => on && !(DISMISSIBLE.includes(k) && dismissed.includes(k)));
  return hit?.[0] ?? null;
}

// โทนสีตามต้นแบบ vBanner (info/warn/err) + เทาของ soft('off') สำหรับ "ร่าง" (spec/01 §5 cancelAtPeriodEnd)
const TONE = {
  info: [color.infoSoft, color.accentFocus, color.info],
  warn: [color.warnSoft, '#E9C98F', color.warn],
  err: [color.errSoft, '#EBB5AF', color.err],
  off: [color.offSoft, color.line, color.off],
} as const;

const SPEC: Record<
  BannerKind,
  { tone: keyof typeof TONE; icon: string; t: MessageKey; d: MessageKey; btn?: MessageKey }
> = {
  read_only: {
    tone: 'err',
    icon: 'eye',
    t: 'acctBn.readOnly.t',
    d: 'acctBn.readOnly.d',
    btn: 'acctBn.btn.pay',
  },
  past_due: {
    tone: 'warn',
    icon: 'circle-alert',
    t: 'acctBn.pastDue.t',
    d: 'acctBn.pastDue.d',
    btn: 'acctBn.btn.pay',
  },
  // ปุ่ม "ดูสถานะ" → หน้าตั้งค่าบริษัท (ข้อมูลที่กำลังตรวจ) — ทุกคนกดได้ ไม่ขึ้นกับสิทธิ์ billing
  // [DECISION — lead 28 พ.ย. 2569, ย้อนได้] (D-83)
  pending: {
    tone: 'warn',
    icon: 'hourglass',
    t: 'acctBn.pending.t',
    d: 'acctBn.pending.d',
    btn: 'acctBn.btn.status',
  },
  trial_soon: {
    tone: 'warn',
    icon: 'flask-conical',
    t: 'acctBn.trialSoon.t',
    d: 'acctBn.trial.d',
    btn: 'acctBn.btn.plan',
  },
  quota: {
    tone: 'warn',
    icon: 'gauge',
    t: 'acctBn.quota.t',
    d: 'acctBn.quota.d',
    btn: 'acctBn.btn.quota',
  },
  trial: {
    tone: 'info',
    icon: 'flask-conical',
    t: 'acctBn.trial.t',
    d: 'acctBn.trial.d',
    btn: 'acctBn.btn.plan',
  },
  cancel: {
    tone: 'off',
    icon: 'calendar-x',
    t: 'acctBn.cancel.t',
    d: 'acctBn.cancel.d',
    btn: 'acctBn.btn.undoCancel',
  },
};

/** วันที่ไทย (UTC+7) ของ instant — ให้ "ถึง {date}" ตรงกับวันที่ที่ API นับ (PLT-051) */
const bkkDate = (iso: string) => {
  const d = new Date(Date.parse(iso) + 7 * 3600_000);
  return new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
};
const ymdDate = (ymd: string) =>
  new Date(Number(ymd.slice(0, 4)), Number(ymd.slice(5, 7)) - 1, Number(ymd.slice(8, 10)));

const todayKey = () => new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10);
const storeKey = (tenantId: string) => `tms.acctBn.dismissed.${tenantId}`;
function readDismissed(tenantId: string): BannerKind[] {
  try {
    const v = JSON.parse(localStorage.getItem(storeKey(tenantId)) ?? 'null') as {
      day: string;
      kinds: BannerKind[];
    } | null;
    return v && v.day === todayKey() ? v.kinds : [];
  } catch {
    return [];
  }
}
function writeDismissed(tenantId: string, kinds: BannerKind[]) {
  try {
    localStorage.setItem(storeKey(tenantId), JSON.stringify({ day: todayKey(), kinds }));
  } catch {
    /* ที่เก็บในเบราว์เซอร์ใช้ไม่ได้ — ปิดได้เฉพาะรอบนี้ */
  }
}

/**
 * แถบสถานะบัญชี (P1-ST1-T05) — หน้าตาตาม `bn.show` ของต้นแบบ TMS v4 (การ์ดมน 12, ไอคอน 18, หัวข้อ + คำอธิบาย, ปุ่มกลมน้ำเงิน)
 * อยู่บนสุดของ <main> ทุกหน้า · ปุ่มชำระเงิน/เลือกแพ็กเกจ เฉพาะผู้มีสิทธิ์ `billing.manage` (ตอนนี้ `settings:write`)
 * คนอื่นเห็น "แจ้งผู้ดูแลระบบ" → dialog รายชื่อผู้ดูแล + ส่งอีเมลแจ้ง (spec/01 §5 ข้อ 8)
 */
export function StatusBanner({
  input,
  tenantId,
  planName,
  canManageBilling,
  yearStyle,
}: {
  input: BannerInput;
  tenantId: string;
  planName: string;
  canManageBilling: boolean;
  yearStyle: 'BE' | 'CE';
}) {
  const { t, lang } = useI18n();
  const nav = useNavigate();
  const [dismissed, setDismissed] = useState<BannerKind[]>(() => readDismissed(tenantId));
  const [admins, setAdmins] = useState(false);
  const kind = pickBanner(input, dismissed);
  if (!kind) return null;
  const s = SPEC[kind];
  const a = input.account;
  const date = (d: Date) => formatDate(d, lang, yearStyle);
  const vars = {
    plan: planName,
    n: (kind === 'past_due' ? a.readOnlyInDays : a.trialDaysLeft) ?? 0,
    date:
      kind === 'past_due' && a.pastDueSince
        ? date(ymdDate(a.pastDueSince))
        : kind === 'cancel' && a.currentPeriodEnd
          ? date(bkkDate(a.currentPeriodEnd))
          : a.trialEndsAt
            ? date(bkkDate(a.trialEndsAt))
            : '',
    x: a.vehicles.active,
    limit: a.vehicles.limit ?? 0,
  };
  const titleKey: MessageKey =
    kind === 'past_due' && a.readOnlyInDays === null
      ? 'acctBn.pastDue.t0'
      : kind === 'trial_soon' && a.trialDaysLeft === 0
        ? 'acctBn.trialToday.t'
        : s.t;
  const title = t(titleKey, vars);
  // R-02: ผู้สมัครที่ไม่มีโปรแกรมบัญชี — บอกชัดว่าใบกำกับภาษี/ใบเสร็จออกจากโปรแกรมบัญชี (ข้อความเดียวกับการ์ด "ไม่เชื่อม")
  const r02 =
    a.accountingSoftware === 'none' && ['pending', 'trial_soon', 'trial'].includes(kind)
      ? ' · ' + t('acctBn.noAcc')
      : '';
  const [bg, bd, c] = TONE[s.tone];
  const close = () => {
    const next = [...dismissed, kind];
    setDismissed(next);
    writeDismissed(tenantId, next);
  };
  return (
    <>
      <div
        role="status"
        data-banner={kind}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          padding: '10px 16px',
          background: bg,
          border: `1px solid ${bd}`,
          borderRadius: 12,
          flexWrap: 'wrap',
        }}
      >
        <Icon n={s.icon} s={18} style={{ color: c, flexShrink: 0 }} />
        <div style={{ flex: 1, minWidth: 240, display: 'flex', flexDirection: 'column' }}>
          <span style={{ fontWeight: 600, color: c }}>{title}</span>
          <span style={{ fontSize: 13, color: color.text2 }}>
            {kind === 'past_due' && !a.pastDueSince ? t('acctBn.pastDue.d0') : t(s.d, vars)}
            {r02}
          </span>
        </div>
        {s.btn && (
          <button
            type="button"
            onClick={() =>
              kind === 'pending'
                ? nav(PENDING_STATUS_PATH)
                : canManageBilling
                  ? nav('/billing')
                  : setAdmins(true)
            }
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 8,
              height: 36,
              padding: '0 16px',
              border: `1px solid ${color.accent}`,
              borderRadius: 999,
              background: color.accent,
              color: color.surface,
              font: 'inherit',
              fontWeight: 500,
              cursor: 'pointer',
              whiteSpace: 'nowrap',
            }}
          >
            {kind === 'pending' || canManageBilling ? t(s.btn) : t('acctBn.btn.notify')}
          </button>
        )}
        {DISMISSIBLE.includes(kind) && (
          <button
            type="button"
            aria-label={t('acctBn.dismiss')}
            title={t('acctBn.dismiss')}
            onClick={close}
            style={{
              width: 32,
              height: 32,
              border: 0,
              borderRadius: 999,
              background: 'transparent',
              color: color.text2,
              cursor: 'pointer',
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              flexShrink: 0,
            }}
          >
            <Icon n="x" s={16} />
          </button>
        )}
      </div>
      {admins && <AdminsDialog onClose={() => setAdmins(false)} />}
    </>
  );
}

/**
 * spec/01 §5 ข้อ 8 — ผู้ใช้ไม่มีสิทธิ์ billing กดปุ่ม → รายชื่อผู้ดูแลระบบ (ชื่ออย่างเดียว — PDPA) + "ส่งอีเมลแจ้ง"
 * ระบบส่งแจ้งเตือนในแอป + อีเมลถึงผู้ดูแลเอง (POST /v1/me/billing-admins/notify — กันส่งซ้ำ 24 ชม.)
 */
function AdminsDialog({ onClose }: { onClose: () => void }) {
  const { t } = useI18n();
  const box = useRef<HTMLDivElement>(null);
  useEscapeLayer(true, onClose);
  useModalFocus(true, box);
  const q = useQuery({
    queryKey: ['me', 'billing-admins'],
    queryFn: () => unwrap(api.GET('/v1/me/billing-admins')),
  });
  const send = useMutation({
    mutationFn: () => unwrap(api.POST('/v1/me/billing-admins/notify')),
  });
  const list = q.data?.data ?? [];
  const muted = { fontSize: 14, color: color.text3 } as const;
  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 75,
        background: 'rgba(10, 23, 52, 0.32)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 24,
      }}
    >
      <div
        ref={box}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={t('acctBn.adm.title')}
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 480,
          maxWidth: '100%',
          background: color.surface,
          border: `1px solid ${color.cardBorder}`,
          borderRadius: 16,
          boxShadow: '0 18px 44px rgba(10, 23, 52, 0.14)',
          display: 'flex',
          flexDirection: 'column',
          outline: 'none',
        }}
      >
        <div style={{ padding: '20px 24px 0', display: 'flex', flexDirection: 'column', gap: 4 }}>
          <h2 style={{ margin: 0, fontSize: 18, fontWeight: 600, color: color.text }}>
            {t('acctBn.adm.title')}
          </h2>
          <span style={{ fontSize: 13, color: color.text3 }}>{t('acctBn.adm.sub')}</span>
        </div>
        <div style={{ padding: '16px 24px', display: 'flex', flexDirection: 'column', gap: 8 }}>
          {q.isPending && <span style={muted}>{t('acctBn.adm.loading')}</span>}
          {q.isError && (
            <span role="alert" style={{ ...muted, color: color.err }}>
              {t('acctBn.adm.error')}
            </span>
          )}
          {q.isSuccess && list.length === 0 && <span style={muted}>{t('acctBn.adm.empty')}</span>}
          {list.map((u, i) => (
            <div
              key={`${u.name}-${i}`}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                padding: '8px 12px',
                border: `1px solid ${color.line}`,
                borderRadius: 10,
              }}
            >
              <Icon n="user" s={16} style={{ color: color.text2 }} />
              <span style={{ fontWeight: 500, color: color.text }}>{u.name}</span>
            </div>
          ))}
          {send.isSuccess && (
            <span role="status" style={{ ...muted, color: color.ok }}>
              {send.data.alreadyRequested ? t('acctBn.adm.already') : t('acctBn.adm.sent')}
            </span>
          )}
          {send.isError && (
            <span role="alert" style={{ ...muted, color: color.err }}>
              {t('acctBn.adm.sendError')}
            </span>
          )}
        </div>
        <div
          style={{ padding: '0 24px 20px', display: 'flex', justifyContent: 'flex-end', gap: 8 }}
        >
          <button
            type="button"
            onClick={onClose}
            style={{
              height: 36,
              padding: '0 16px',
              border: `1px solid ${color.cardBorder}`,
              borderRadius: 999,
              background: color.surface,
              color: color.text,
              font: 'inherit',
              fontWeight: 500,
              cursor: 'pointer',
            }}
          >
            {t('acctBn.adm.close')}
          </button>
          {list.length > 0 && !send.isSuccess && (
            <button
              type="button"
              disabled={send.isPending}
              onClick={() => send.mutate()}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 8,
                height: 36,
                padding: '0 16px',
                border: `1px solid ${color.accent}`,
                borderRadius: 999,
                background: color.accent,
                color: color.surface,
                font: 'inherit',
                fontWeight: 500,
                cursor: 'pointer',
              }}
            >
              <Icon n="mail" s={16} />
              {t('acctBn.adm.send')}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
