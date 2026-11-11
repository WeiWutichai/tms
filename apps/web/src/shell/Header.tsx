import { Icon } from '@tms/ui';
import { api, queryClient } from '../api';
import { formatLongDate, useI18n, type Lang } from '../i18n';
import { Bell } from './Bell';

/** แถบบน — <header> สูง 56 ใน TMS v4: breadcrumb, วันที่, สลับภาษา, กระดิ่ง, ปุ่ม + */
export function Header({
  group,
  title,
  yearStyle,
}: {
  group: string;
  title: string;
  yearStyle: 'BE' | 'CE';
}) {
  const { t, lang, setLang } = useI18n();
  const langs: [Lang, string][] = [
    ['th', 'TH'],
    ['en', 'EN'],
    ['zh', '中文'],
  ];
  return (
    <header
      style={{
        height: 56,
        position: 'sticky',
        top: 0,
        zIndex: 30,
        background: '#FFFFFF',
        borderBottom: '1px solid #E4E6E0',
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        padding: '0 24px',
      }}
    >
      <nav
        aria-label="breadcrumb"
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          color: '#3B424C',
          flex: 1,
          minWidth: 0,
        }}
      >
        <span style={{ whiteSpace: 'nowrap' }}>{group}</span>
        <Icon n="chevron-right" s={14} style={{ flexShrink: 0 }} />
        <span
          style={{
            color: '#101418',
            fontWeight: 500,
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
        >
          {title}
        </span>
      </nav>
      <span style={{ fontSize: 13, color: '#3B424C', whiteSpace: 'nowrap' }}>
        {formatLongDate(new Date(), lang, yearStyle)}
      </span>
      <div
        style={{
          display: 'inline-flex',
          gap: 2,
          padding: 3,
          background: '#EBEDE8',
          border: '1px solid #D9DCD4',
          borderRadius: 999,
        }}
      >
        {langs.map(([k, l]) => {
          const on = lang === k;
          return (
            <button
              key={k}
              type="button"
              aria-pressed={on}
              onClick={() => {
                setLang(k);
                // ST1-T09: เก็บภาษาในโปรไฟล์ — เข้าระบบจากเครื่องอื่นได้ภาษาเดิม
                void api
                  .PATCH('/v1/me/profile', { body: { locale: k } })
                  .then((r) => {
                    // cache ของ /me ต้องรู้ภาษาใหม่ด้วย — กันค่าเก่าทับตอน login ใหม่ในแท็บเดิม
                    if (r.data)
                      queryClient.setQueryData(['me'], (m: unknown) =>
                        m && typeof m === 'object' && 'user' in m && (m as { user: unknown }).user
                          ? {
                              ...(m as object),
                              user: { ...(m as { user: object }).user, locale: k },
                            }
                          : m,
                      );
                  })
                  .catch(() => undefined);
              }}
              style={{
                height: 28,
                minWidth: 42,
                padding: '0 10px',
                border: 0,
                borderRadius: 999,
                background: on ? '#FFFFFF' : 'transparent',
                color: on ? '#2257C4' : '#3B424C',
                fontWeight: on ? 600 : 500,
                boxShadow: on ? '0 1px 2px rgba(10,23,52,.10)' : 'none',
                cursor: 'pointer',
                fontSize: 13,
              }}
            >
              {l}
            </button>
          );
        })}
      </div>
      <Bell />
      <button
        type="button"
        className="tms-iconbtn tms-iconbtn--accent"
        title={t('shell.create')}
        aria-label={t('shell.create')}
      >
        <Icon n="plus" s={16} />
      </button>
    </header>
  );
}

/** หัวหน้า — h1 22/600 สี #13213F + คำอธิบาย + ปุ่มด้านขวา */
export function PageHeader({
  title,
  sub,
  actions,
}: {
  title: string;
  sub?: string;
  actions?: React.ReactNode;
}) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'flex-end',
        justifyContent: 'space-between',
        gap: 16,
        flexWrap: 'wrap',
      }}
    >
      <div>
        <h1
          style={{ margin: 0, fontSize: 22, fontWeight: 600, lineHeight: 1.35, color: '#13213F' }}
        >
          {title}
        </h1>
        {sub && <p style={{ margin: '2px 0 0', color: '#3B424C' }}>{sub}</p>}
      </div>
      {actions && <div style={{ display: 'flex', gap: 8 }}>{actions}</div>}
    </div>
  );
}
