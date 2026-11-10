import { Icon } from '@tms/ui';
import { useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useI18n } from '../i18n';
import { canAny, navFor, NAV, type NavGroup } from '../nav';

/** Sidebar — markup/ค่าจาก <aside> ใน TMS v4 (กว้าง 272 / ย่อ 88, แผงลอยขาว radius 16) */
export function Sidebar({
  mini,
  onToggle,
  tenantName,
  actor,
  role,
  scopes,
  features,
  onLogout,
}: {
  mini: boolean;
  onToggle: () => void;
  tenantName: string;
  actor: string;
  role?: string;
  /** scope ของผู้ใช้จาก /me — เมนูที่ไม่มีสิทธิ์ถูกซ่อน */
  scopes: readonly string[];
  /** ฟีเจอร์ของแพ็กเกจ (ST1-T18) — เมนูของฟีเจอร์ที่ปิดถูกซ่อน */
  features?: readonly string[];
  onLogout: () => void;
}) {
  const { t } = useI18n();
  const loc = useLocation();
  const nav = useNavigate();
  const here = loc.pathname + loc.search;
  const [open, setOpen] = useState<Record<string, boolean>>({ ops: true, acc: true });
  const isOn = (path: string) => (path.includes('?') ? here === path : loc.pathname === path);
  // อยู่หน้าลูกของกลุ่มไหน → กางกลุ่มนั้นให้เห็นเมนูที่ active (ต้นแบบ: ตั้งค่า ▾ › ตั้งค่าระบบ •)
  useEffect(() => {
    const g = NAV.find(
      (x) => x.key !== 'fav' && x.kids?.some((k) => k.path.split('?')[0] === loc.pathname),
    );
    if (g) setOpen((o) => (o[g.key] ? o : { ...o, [g.key]: true }));
  }, [loc.pathname]);
  const settingsPerm = NAV.find((g) => g.key === 'setg')?.kids?.[0]?.perm;
  const canSettings = canAny(scopes, settingsPerm);
  // ตัวย่อ = พยัญชนะ/ตัวอักษรแรกของชื่อ + ของนามสกุล (ต้นแบบ: พรทิพย์ ศรีวงศ์ → พศ; ข้ามสระนำ เ แ โ ใ ไ)
  const first = (w: string) => [...w].find((ch) => /[\u0E01-\u0E2EA-Za-z0-9]/.test(ch)) ?? '';
  const words = actor.trim().split(/\s+/);
  const initials = (
    words.length > 1 ? first(words[0]!) + first(words[words.length - 1]!) : actor.slice(0, 2)
  ).toUpperCase();

  return (
    <aside
      style={{
        width: mini ? 88 : 272,
        flexShrink: 0,
        position: 'sticky',
        top: 0,
        height: '100vh',
        padding: 8,
        boxSizing: 'border-box',
        transition: 'width 160ms',
        zIndex: 20,
      }}
    >
      <div
        style={{
          height: '100%',
          background: '#FFFFFF',
          borderRadius: 16,
          boxShadow: '0 1px 2px rgba(16,20,24,.06),0 8px 24px rgba(16,20,24,.06)',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            margin: '10px 10px 8px',
            padding: 8,
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            background: '#F4F5F2',
            border: '1px solid #D9DCD4',
            borderRadius: 12,
            boxShadow: '0 1px 2px rgba(16,20,24,.06)',
            flexShrink: 0,
          }}
        >
          <button
            type="button"
            onClick={onToggle}
            title={t('shell.toggle')}
            aria-label={t('shell.toggle')}
            style={{
              width: 32,
              height: 32,
              border: 0,
              borderRadius: 8,
              background: '#13213F',
              color: '#FFFFFF',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              cursor: 'pointer',
              flexShrink: 0,
              padding: 0,
            }}
          >
            <Icon n="truck" s={18} />
          </button>
          {!mini && (
            <>
              <div style={{ position: 'relative', minWidth: 0, flex: 1 }}>
                <button
                  type="button"
                  title={t('shell.switchCompany')}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 4,
                    width: '100%',
                    border: 0,
                    background: 'transparent',
                    padding: 0,
                    cursor: 'pointer',
                    textAlign: 'left',
                    minWidth: 0,
                  }}
                >
                  <div
                    style={{
                      display: 'flex',
                      flexDirection: 'column',
                      lineHeight: 1.3,
                      minWidth: 0,
                      flex: 1,
                    }}
                  >
                    <span
                      style={{
                        fontWeight: 600,
                        color: '#13213F',
                        fontSize: 15,
                        whiteSpace: 'nowrap',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                      }}
                    >
                      {tenantName}
                    </span>
                    <span style={{ fontSize: 12, color: '#3B424C', whiteSpace: 'nowrap' }}>
                      {t('shell.hq')}
                    </span>
                  </div>
                  <Icon n="chevrons-up-down" s={14} style={{ color: '#59606B', flexShrink: 0 }} />
                </button>
              </div>
              <button
                type="button"
                onClick={onToggle}
                title={t('shell.collapse')}
                aria-label={t('shell.collapse')}
                className="tms-sb-plain"
                style={{
                  width: 28,
                  height: 28,
                  border: 0,
                  borderRadius: 8,
                  background: 'transparent',
                  color: '#59606B',
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  padding: 0,
                }}
              >
                <Icon n="panel-left-close" s={16} />
              </button>
            </>
          )}
        </div>
        <div style={{ padding: '0 10px 10px', flexShrink: 0 }}>
          {mini ? (
            <button
              type="button"
              title={t('shell.searchTitle')}
              aria-label={t('shell.search')}
              className="tms-sb-search"
              style={{
                width: 44,
                height: 36,
                margin: '0 auto',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                border: '1px solid #D9DCD4',
                borderRadius: 10,
                background: '#F4F5F2',
                boxShadow: 'inset 0 1px 2px rgba(16,20,24,.08)',
                color: '#3B424C',
                cursor: 'pointer',
                padding: 0,
              }}
            >
              <Icon n="search" s={16} />
            </button>
          ) : (
            <button
              type="button"
              className="tms-sb-search"
              style={{
                width: '100%',
                height: 36,
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                padding: '0 10px',
                border: '1px solid #D9DCD4',
                borderRadius: 10,
                background: '#F4F5F2',
                boxShadow: 'inset 0 1px 2px rgba(16,20,24,.08)',
                color: '#3B424C',
                cursor: 'pointer',
                fontWeight: 500,
              }}
            >
              <Icon n="search" s={16} />
              <span style={{ flex: 1, textAlign: 'left' }}>{t('shell.search')}</span>
              <span
                style={{
                  fontVariantNumeric: 'tabular-nums',
                  fontSize: 12,
                  border: '1px solid #D9DCD4',
                  borderRadius: 4,
                  padding: '0 5px',
                  background: '#FFFFFF',
                  color: '#3B424C',
                }}
              >
                ⌘K
              </span>
            </button>
          )}
        </div>
        <nav
          style={{
            flex: 1,
            overflowY: 'auto',
            padding: '0 10px 10px',
            display: 'flex',
            flexDirection: 'column',
            gap: 2,
          }}
        >
          {navFor(scopes, features)
            .filter((g) => !g.devOnly || import.meta.env.DEV)
            .map((g) => (
              <Group
                key={g.key}
                g={g}
                mini={mini}
                open={!!open[g.key] && !mini}
                isOn={isOn}
                onToggle={() =>
                  mini
                    ? (onToggle(), setOpen((o) => ({ ...o, [g.key]: true })))
                    : setOpen((o) => ({ ...o, [g.key]: !o[g.key] }))
                }
                go={(p) => nav(p)}
              />
            ))}
        </nav>
        <div
          style={{
            margin: 8,
            padding: 8,
            background: '#F4F5F2',
            border: '1px solid #E4E6E0',
            borderRadius: 12,
            boxShadow: '0 1px 2px rgba(16,20,24,.06)',
            display: 'flex',
            flexDirection: 'column',
            gap: 4,
            flexShrink: 0,
          }}
        >
          {mini ? (
            <>
              <button
                type="button"
                title={t('shell.erpStatus')}
                aria-label={t('shell.erpStatus')}
                style={{
                  width: 44,
                  height: 28,
                  margin: '0 auto',
                  border: 0,
                  background: 'transparent',
                  borderRadius: 8,
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                <span style={{ width: 8, height: 8, borderRadius: '50%', background: '#59606B' }} />
              </button>
              <div
                title={actor}
                style={{
                  width: 32,
                  height: 32,
                  margin: '0 auto',
                  borderRadius: '50%',
                  background: '#2257C4',
                  color: '#FFFFFF',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontWeight: 600,
                  fontSize: 13,
                }}
              >
                {initials}
              </div>
            </>
          ) : (
            <>
              <button
                type="button"
                onClick={canSettings ? () => nav('/settings') : undefined}
                disabled={!canSettings}
                className="tms-sb-foot"
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  height: 32,
                  padding: '0 8px',
                  border: 0,
                  background: 'transparent',
                  borderRadius: 8,
                  cursor: canSettings ? 'pointer' : 'default',
                  color: '#3B424C',
                  fontWeight: 500,
                }}
              >
                <span style={{ width: 8, height: 8, borderRadius: '50%', background: '#59606B' }} />
                <span style={{ flex: 1, textAlign: 'left', whiteSpace: 'nowrap' }}>
                  {t('shell.erpOff')}
                </span>
                {canSettings && (
                  <span style={{ color: '#2257C4', fontWeight: 600 }}>{t('shell.erpSetup')}</span>
                )}
              </button>
              <div style={{ height: 1, background: '#E4E6E0', margin: '2px 4px' }} />
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '4px 6px' }}>
                <div
                  style={{
                    width: 32,
                    height: 32,
                    borderRadius: '50%',
                    background: '#2257C4',
                    color: '#FFFFFF',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    fontWeight: 600,
                    fontSize: 13,
                    flexShrink: 0,
                  }}
                >
                  {initials}
                </div>
                <div
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    lineHeight: 1.35,
                    minWidth: 0,
                    flex: 1,
                  }}
                >
                  <span
                    style={{
                      fontWeight: 600,
                      color: '#101418',
                      whiteSpace: 'nowrap',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                    }}
                  >
                    {actor}
                  </span>
                  {role && <span style={{ fontSize: 13, color: '#3B424C' }}>{role}</span>}
                </div>
                <button
                  type="button"
                  onClick={onLogout}
                  title={t('shell.logout')}
                  aria-label={t('shell.logout')}
                  style={{
                    border: 0,
                    background: 'transparent',
                    padding: 0,
                    cursor: 'pointer',
                    display: 'inline-flex',
                  }}
                >
                  <Icon n="log-out" s={16} style={{ color: '#59606B' }} />
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </aside>
  );
}

function Group({
  g,
  mini,
  open,
  isOn,
  onToggle,
  go,
}: {
  g: NavGroup;
  mini: boolean;
  open: boolean;
  isOn: (p: string) => boolean;
  onToggle: () => void;
  go: (p: string) => void;
}) {
  const { t } = useI18n();
  const hasKids = !!g.kids?.length;
  const childOn = hasKids && g.kids!.some((k) => isOn(k.path));
  const on = (!hasKids && !!g.path && isOn(g.path)) || (hasKids && !open && childOn);
  const label = t(g.label);
  return (
    <>
      {g.sepBefore && (
        <div style={{ height: 1, background: '#E4E6E0', margin: '6px 4px', flexShrink: 0 }} />
      )}
      <button
        type="button"
        title={label}
        aria-current={on ? 'page' : undefined}
        aria-expanded={hasKids ? open : undefined}
        onClick={hasKids ? onToggle : () => go(g.path!)}
        className={on ? undefined : 'tms-sb-item'}
        style={{
          position: 'relative',
          height: 36,
          flexShrink: 0,
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          padding: '0 8px',
          border: 0,
          borderRadius: 10,
          background: on ? '#E9F0FA' : 'transparent',
          boxShadow: on ? '0 1px 2px rgba(34,87,196,.12),0 2px 8px rgba(34,87,196,.10)' : 'none',
          color: on ? '#2257C4' : childOn && open ? '#2257C4' : '#101418',
          fontSize: 14,
          fontWeight: 600,
          cursor: 'pointer',
          textAlign: 'left',
          width: '100%',
          transition: 'background 120ms',
        }}
      >
        {on && (
          <span
            style={{
              position: 'absolute',
              left: 0,
              top: 7,
              bottom: 7,
              width: 3,
              borderRadius: '0 3px 3px 0',
              background: '#2257C4',
            }}
          />
        )}
        <span
          style={{
            width: 28,
            height: 28,
            borderRadius: 8,
            background: on ? '#2257C4' : '#EEF0EC',
            color: on ? '#FFFFFF' : '#3B424C',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            flexShrink: 0,
            position: 'relative',
          }}
        >
          <Icon n={g.icon} s={16} />
        </span>
        {!mini && (
          <>
            <span
              style={{
                flex: 1,
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
              }}
            >
              {label}
            </span>
            {hasKids && (
              <Icon
                n={open ? 'chevron-down' : 'chevron-right'}
                s={16}
                style={{ color: '#59606B' }}
              />
            )}
          </>
        )}
      </button>
      {open && hasKids && (
        <div
          style={{
            position: 'relative',
            display: 'flex',
            flexDirection: 'column',
            gap: 2,
            padding: '2px 0 4px',
          }}
        >
          <span
            style={{
              position: 'absolute',
              left: 22,
              top: 0,
              bottom: 6,
              width: 1,
              background: '#D9DCD4',
            }}
          />
          {g.kids!.map((k) => {
            const kOn = isOn(k.path);
            return (
              <button
                key={k.key}
                type="button"
                title={t(k.label)}
                aria-current={kOn ? 'page' : undefined}
                onClick={() => go(k.path)}
                className={kOn ? undefined : 'tms-sb-item'}
                style={{
                  position: 'relative',
                  height: 32,
                  flexShrink: 0,
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  marginLeft: 32,
                  padding: '0 8px 0 10px',
                  border: 0,
                  borderRadius: 8,
                  background: kOn ? '#E9F0FA' : 'transparent',
                  color: kOn ? '#2257C4' : '#3B424C',
                  fontSize: 13.5,
                  fontWeight: kOn ? 600 : 500,
                  cursor: 'pointer',
                  textAlign: 'left',
                  width: 'calc(100% - 32px)',
                  transition: 'background 120ms',
                }}
              >
                {kOn && (
                  <span
                    style={{
                      position: 'absolute',
                      left: -13.5,
                      top: 12.5,
                      width: 7,
                      height: 7,
                      borderRadius: '50%',
                      background: '#2257C4',
                      boxShadow: '0 0 0 2px #FFFFFF',
                    }}
                  />
                )}
                <span
                  style={{
                    flex: 1,
                    whiteSpace: 'nowrap',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                  }}
                >
                  {t(k.label)}
                </span>
              </button>
            );
          })}
        </div>
      )}
    </>
  );
}
