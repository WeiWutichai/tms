import { Badge, Icon } from '@tms/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api, unwrap } from '../../api';
import { useI18n } from '../../i18n';
import { problemText } from '../master/problems';
import { Toggle } from './Settings';
import { stepUpHeaders, useInlineStepUp } from '../stepup/stepUp';

const KEY = ['settings-messaging'];
type Body = { lineChannelAccessToken?: string | null; lineEnabled?: boolean; smsEnabled?: boolean };

/**
 * การ์ด "LINE Official Account" ของ ตั้งค่า → การเชื่อมต่อ (ST3-T21; ต้นแบบ TMS v4 `st.others` — การ์ดขาว ไอคอน message-circle,
 * ชื่อ + ข้อมูล + ป้ายสถานะ + ปุ่มข้อความ) — [DECISION — PO 24 พ.ย. 2569 ประกอบจากโครงสร้างต้นแบบ]
 * API `GET/PATCH /v1/settings/messaging`: token เขียนอย่างเดียว (แสดง 4 ตัวท้าย) · เปิด/ปิด LINE และ SMS ·
 * ปุ่ม "ทดสอบ" ของต้นแบบไม่ทำ — API ยังไม่มีคำสั่งทดสอบการเชื่อมต่อ (ระบบส่งจริงตอนส่งลิงก์ — ดูผลในแท็บเอกสารแนบผู้รับเหมา)
 */
export function LineOaCard({
  canWrite,
  onToast,
}: {
  canWrite: boolean;
  onToast: (m: string, err?: boolean) => void;
}) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: KEY,
    queryFn: () => unwrap(api.GET('/v1/settings/messaging')),
    retry: false,
  });
  // ตั้ง/ลบ token = credential → ยืนยัน 2FA (D-67 ข้อ 2) ด้วยกล่อง StepUpBox ในการ์ด
  const su = useInlineStepUp();
  const save = useMutation({
    mutationFn: (v: { body: Body; token?: string }) =>
      unwrap(
        api.PATCH('/v1/settings/messaging', { body: v.body, headers: stepUpHeaders(v.token) }),
      ),
    onSuccess: (d) => qc.setQueryData(KEY, d),
  });
  const [open, setOpen] = useState(false);
  const [token, setToken] = useState('');
  const [pending, setPending] = useState<{ body: Body; msg: string } | null>(null);
  const s = q.data;
  if (q.isError || !s) return null;
  const on = s.lineEnabled && s.lineConfigured;
  const run = (body: Body, msg: string, tok?: string) =>
    save.mutate(
      { body, ...(tok ? { token: tok } : {}) },
      {
        onSuccess: () => {
          setToken('');
          su.reset();
          onToast(msg);
        },
        onError: (e) => {
          // ต้องยืนยัน 2FA → แสดงกล่องในการ์ด แล้วส่งคำขอเดิมซ้ำพร้อม token
          if (su.onError(e)) return setPending({ body, msg });
          onToast(problemText(e, t) ?? t('line.e.save'), true);
        },
      },
    );
  return (
    <div className="cnx-card" data-on={on || undefined} data-testid="line-oa-card">
      <div className="cnx-card__hd">
        <span className="cnx-ico">
          <Icon n="message-circle" s={18} />
        </span>
        <span className="cnx-card__n">{t('line.n')}</span>
        {on ? (
          <Badge label={t('line.st.on')} tone="ok" icon="circle-check" />
        ) : (
          <Badge
            label={t(s.lineConfigured ? 'line.st.off' : 'line.st.none')}
            tone="off"
            icon="circle-minus"
          />
        )}
      </div>
      <span style={{ color: '#3B424C' }}>{t('line.d')}</span>
      <span className="cnx-card__meta">
        {s.lineConfigured ? t('line.meta', { h: s.lineTokenHint ?? '••••' }) : t('line.metaNone')}
      </span>
      {open && canWrite && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginTop: 4 }}>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <span style={{ fontSize: 12.5, fontWeight: 500, color: '#3B424C' }}>
              {t('line.token')}
            </span>
            <input
              type="password"
              autoComplete="off"
              className="tms-input"
              aria-label={t('line.token')}
              placeholder={s.lineConfigured ? t('line.tokenKeep') : t('line.tokenPh')}
              value={token}
              maxLength={500}
              onChange={(e) => setToken(e.target.value)}
            />
          </label>
          {pending && su.box((tok) => run(pending.body, pending.msg, tok))}
          {su.error && (
            <span className="tms-field-error" role="alert">
              {su.error}
            </span>
          )}
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <Toggle
              on={s.lineEnabled}
              disabled={save.isPending || (!s.lineConfigured && !token.trim())}
              label={t('line.enable')}
              onChange={() =>
                run(
                  { lineEnabled: !s.lineEnabled },
                  t(s.lineEnabled ? 'line.toast.off' : 'line.toast.on'),
                )
              }
            />
            <span>{t('line.enable')}</span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <Toggle
              on={s.smsEnabled}
              disabled={save.isPending}
              label={t('line.sms')}
              onChange={() =>
                run(
                  { smsEnabled: !s.smsEnabled },
                  t(s.smsEnabled ? 'line.toast.smsOff' : 'line.toast.smsOn'),
                )
              }
            />
            <span>{t('line.sms')}</span>
          </div>
        </div>
      )}
      {canWrite && (
        <div className="cnx-card__acts">
          {open ? (
            <>
              <button
                type="button"
                className="cnx-tog"
                disabled={save.isPending || !token.trim()}
                onClick={() =>
                  run(
                    { lineChannelAccessToken: token.trim(), lineEnabled: true },
                    t('line.toast.saved'),
                  )
                }
              >
                <Icon n="save" s={16} />
                {t('line.saveToken')}
              </button>
              {s.lineConfigured && (
                <button
                  type="button"
                  className="cnx-tog"
                  disabled={save.isPending}
                  onClick={() => run({ lineChannelAccessToken: null }, t('line.toast.removed'))}
                >
                  <Icon n="trash-2" s={16} />
                  {t('line.remove')}
                </button>
              )}
              <button type="button" className="cnx-tog" onClick={() => setOpen(false)}>
                {t('drawer.close')}
              </button>
            </>
          ) : (
            <button type="button" className="cnx-tog" onClick={() => setOpen(true)}>
              <Icon n="settings" s={16} />
              {t('line.setup')}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
