import { useQuery } from '@tanstack/react-query';
import { Icon } from '@tms/ui';
import { useNavigate } from 'react-router-dom';
import { api, queryClient } from '../../api';
import { useI18n } from '../../i18n';
import type { MessageKey } from '../../i18n/th';

const KEY = ['setup-checklist'] as const;

/** ปลายทางของแต่ละขั้น — import/connector ยังไม่มีหน้า (ST2-T23 / ST7) [OPEN spec/12 §3] */
const GO: Record<string, string | null> = {
  org: '/settings?sec=org',
  branch: '/settings?sec=ent',
  numbering: '/settings?sec=num',
  tax: '/settings?sec=tax',
  import: null,
  team: '/settings?sec=users',
  connector: null,
};

/**
 * การ์ด "เริ่มต้นใช้งาน TMS" บนหน้าภาพรวม (ST1-T21) — ต้นแบบ TMS v4 `chk`: หัว + แถบ progress 200px + "ซ่อน",
 * grid การ์ดขั้น (วงเขียว ✓ = เสร็จ, วงเลข = ยังไม่เสร็จ) · ขั้นตาม backlog/docs/04 A5 (ต้นแบบใช้ชุด รถ/คนขับ/SO) [OPEN]
 * สถานะคำนวณจากข้อมูลจริงทุกครั้งที่เปิดหน้า (ไม่ต้องติ๊กเอง) · ไม่มีสิทธิ์ตั้งค่า/ครบแล้ว/ซ่อน = ไม่แสดง
 */
export function SetupChecklist() {
  const { t } = useI18n();
  const nav = useNavigate();
  const q = useQuery({
    queryKey: KEY,
    queryFn: async () => (await api.GET('/v1/setup-checklist')).data ?? null,
    staleTime: 0,
    refetchOnMount: 'always',
    refetchOnWindowFocus: true,
    retry: false,
  });
  const c = q.data;
  if (!c || c.completed || c.hidden) return null;
  const pct = `${Math.round((c.done / c.total) * 100)}%`;
  return (
    <section
      aria-labelledby="setup-title"
      style={{
        background: '#FFFFFF',
        border: '1px solid #CDD1C8',
        borderRadius: 12,
        boxShadow: '0 1px 2px rgba(16,20,24,.06),0 2px 6px rgba(16,20,24,.04)',
        padding: '16px 20px',
        display: 'flex',
        flexDirection: 'column',
        gap: 14,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minWidth: 220 }}>
          <h2
            id="setup-title"
            style={{ margin: 0, fontSize: 15, fontWeight: 600, color: '#101418' }}
          >
            {t('setup.title')}
          </h2>
          <span style={{ fontSize: 13, color: '#3B424C' }}>
            {t('setup.sub', { n: `${c.done}/${c.total}` })}
          </span>
        </div>
        <div
          role="progressbar"
          aria-label={t('setup.title')}
          aria-valuemin={0}
          aria-valuemax={c.total}
          aria-valuenow={c.done}
          style={{
            width: 200,
            height: 6,
            borderRadius: 3,
            background: '#EBEDE8',
            overflow: 'hidden',
          }}
        >
          <div style={{ height: '100%', width: pct, background: '#2257C4' }} />
        </div>
        <button
          type="button"
          onClick={async () => {
            const r = await api.POST('/v1/setup-checklist/hide');
            if (r.data) queryClient.setQueryData(KEY, r.data);
          }}
          style={{
            border: 0,
            background: 'transparent',
            padding: 0,
            cursor: 'pointer',
            whiteSpace: 'nowrap',
            color: '#3B424C',
            fontWeight: 500,
          }}
        >
          {t('setup.hide')}
        </button>
      </div>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit,minmax(180px,1fr))',
          gap: 10,
        }}
      >
        {c.steps.map((s, i) => {
          const done = s.status !== 'todo';
          const to = GO[s.key];
          return (
            <button
              key={s.key}
              type="button"
              data-step={s.key}
              data-status={s.status}
              onClick={() => to && nav(to)}
              className="tms-setup-step"
              style={{
                display: 'flex',
                alignItems: 'flex-start',
                gap: 10,
                padding: 12,
                border: '1px solid #E4E6E0',
                borderRadius: 10,
                background: '#F7F8F5',
                cursor: to ? 'pointer' : 'default',
                textAlign: 'left',
                color: '#101418',
                minWidth: 0,
              }}
            >
              {done ? (
                <span
                  aria-label={t('setup.done')}
                  style={{
                    width: 24,
                    height: 24,
                    borderRadius: '50%',
                    background: '#17733F',
                    color: '#FFFFFF',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    flexShrink: 0,
                  }}
                >
                  <Icon n="check" s={14} />
                </span>
              ) : (
                <span
                  style={{
                    width: 24,
                    height: 24,
                    borderRadius: '50%',
                    border: '1.5px solid #9DB6E3',
                    color: '#2257C4',
                    fontSize: 12,
                    fontWeight: 600,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    flexShrink: 0,
                  }}
                >
                  {i + 1}
                </span>
              )}
              <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
                <span style={{ fontWeight: 600 }}>{t(`setup.${s.key}` as MessageKey)}</span>
                <span style={{ fontSize: 12.5, color: '#59606B' }}>
                  {t(`setup.${s.key}.d` as MessageKey)}
                </span>
              </div>
            </button>
          );
        })}
      </div>
    </section>
  );
}
