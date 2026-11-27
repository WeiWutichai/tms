import { Icon } from '@tms/ui';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { api, unwrap } from '../api';
import { adapterName } from '../features/settings/ConnectorSettings';
import { useI18n } from '../i18n';
import { canAny, isLocked, navFor, NAV, parentOf, type NavGroup } from '../nav';

/** Sidebar — markup/ค่าจาก <aside> ใน TMS v4 (กว้าง 272 / ย่อ 88, แผงลอยขาว radius 16) */
export function Sidebar({
  mini,
  onToggle,
  onSearch,
  tenantName,
  actor,
  role,
  scopes,
  features,
  locks,
  onLogout,
}: {
  mini: boolean;
  onToggle: () => void;
  /** เปิดค้นหา ⌘K (ST9-T09) */
  onSearch?: () => void;
  tenantName: string;
  actor: string;
  role?: string;
  /** scope ของผู้ใช้จาก /me — เมนูที่ไม่มีสิทธิ์ถูกซ่อน */
  scopes: readonly string[];
  /** ฟีเจอร์ที่เปิดอยู่ (ST1-T18) — ใช้ตัดสินส่วนที่ขึ้นกับฟีเจอร์ (เช่น แถบ ERP ท้ายเมนู) */
  features?: readonly string[];
  /** ฟีเจอร์ที่ไม่รวมในแพ็กเกจ (P1-ST1-T02 — `locks` ของ /me) → เมนูขึ้น 🔒 ไม่ซ่อน (PLT-076) */
  locks?: Readonly<Record<string, unknown>>;
  onLogout: () => void;
}) {
  const { t } = useI18n();
  const loc = useLocation();
  const nav = useNavigate();
  const here = loc.pathname + loc.search;
  const [open, setOpen] = useState<Record<string, boolean>>({ ops: true, acc: true });
  const isOn = (path: string) => (path.includes('?') ? here === path : loc.pathname === path);
  // อยู่หน้าลูกของกลุ่มไหน → กางกลุ่มนั้นให้เห็นเมนูที่ active (ต้นแบบ: ตั้งค่า ▾ › ตั้งค่าระบบ •)
  // หน้าย่อย (เช่น โปรไฟล์รถ /fleet/vehicles/:id) → กางกลุ่มของเมนูแม่ (review ST2-T07)
  useEffect(() => {
    const path = parentOf(loc.pathname);
    const g = NAV.find(
      (x) => x.key !== 'fav' && x.kids?.some((k) => k.path.split('?')[0] === path),
    );
    if (g) setOpen((o) => (o[g.key] ? o : { ...o, [g.key]: true }));
  }, [loc.pathname]);
  // ปุ่ม "ไม่ได้เชื่อมระบบบัญชี" พาไปตั้งค่าการเชื่อมต่อ — ต้องมีสิทธิ์ตั้งค่าองค์กร (master:read เข้าหน้าตั้งค่าได้แค่หัวข้อ "เหตุผล")
  const canSettings = canAny(scopes, ['settings:read', 'settings:write']);
  const erp = useErpFoot(canAny(scopes, ['settings:read']) && !!features?.includes('conn'));
  const badges = useNavBadges();
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
              aria-haspopup="dialog"
              aria-keyshortcuts="Meta+K Control+K"
              onClick={onSearch}
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
              aria-haspopup="dialog"
              aria-keyshortcuts="Meta+K Control+K"
              onClick={onSearch}
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
          {navFor(scopes)
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
                locks={locks}
                badges={badges}
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
                <span style={{ width: 8, height: 8, borderRadius: '50%', background: erp.dot }} />
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
                onClick={canSettings ? () => nav('/settings?sec=conn') : undefined}
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
                <span
                  style={{
                    width: 8,
                    height: 8,
                    borderRadius: '50%',
                    background: erp.dot,
                    flexShrink: 0,
                  }}
                />
                <span
                  title={erp.label ?? undefined}
                  style={{
                    flex: 1,
                    minWidth: 0,
                    textAlign: 'left',
                    whiteSpace: 'nowrap',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                  }}
                >
                  {erp.label ?? t('shell.erpOff')}
                </span>
                {erp.label
                  ? erp.sync && (
                      <span style={{ fontSize: 12, color: '#3B424C' }}>
                        {t('shell.erpSync', { t: erp.sync })}
                      </span>
                    )
                  : canSettings && (
                      <span style={{ color: '#2257C4', fontWeight: 600 }}>
                        {t('shell.erpSetup')}
                      </span>
                    )}
              </button>
              <div style={{ height: 1, background: '#E4E6E0', margin: '2px 4px' }} />
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '4px 6px' }}>
                {/* ชื่อผู้ใช้ → หน้าโปรไฟล์ (ST1-T09 — ต้นแบบไม่มีหน้า/ทางเข้า · PO 24 พ.ย. 2569 ประกอบจากโครงสร้างต้นแบบ) */}
                <button
                  type="button"
                  onClick={() => nav('/profile')}
                  title={t('profile.open')}
                  aria-label={t('profile.open')}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 10,
                    flex: 1,
                    minWidth: 0,
                    border: 0,
                    background: 'transparent',
                    padding: 0,
                    font: 'inherit',
                    textAlign: 'left',
                    cursor: 'pointer',
                  }}
                >
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
                </button>
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

/** เมนูที่ badge เป็นงานเร่ง (ต้นแบบ vNav `URG` — ติดตามรถยังไม่มีในเฟส 0) → pill แดง / จุดแดงตอนย่อ */
const URGENT = new Set(['pay', 'track', 'fdoc', 'exc']);

/** pill ตัวนับงานค้าง — ค่าจาก `it.badge` / `g.badge` ของต้นแบบ TMS v4 (เร่ง = พื้น #FBE9E7 ตัวแดง) */
function Badge({ n, urgent }: { n: number; urgent: boolean }) {
  return (
    <span
      data-testid="nav-badge"
      style={{
        minWidth: 22,
        height: 20,
        padding: '0 7px',
        borderRadius: 999,
        background: urgent ? '#FBE9E7' : '#FFFFFF',
        border: `1px solid ${urgent ? '#FBE9E7' : '#D9DCD4'}`,
        color: urgent ? '#B3322A' : '#3B424C',
        fontSize: 12,
        fontWeight: 600,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontVariantNumeric: 'tabular-nums',
        boxSizing: 'border-box',
      }}
    >
      {n}
    </span>
  );
}

function Group({
  g,
  mini,
  open,
  isOn,
  onToggle,
  go,
  locks,
  badges = {},
}: {
  /** ตัวนับงานค้างต่อ key ของเมนู (D68-89 — `GET /v1/me/badges`) */
  badges?: Readonly<Record<string, number>>;
  locks?: Readonly<Record<string, unknown>>;
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
  // ต้นแบบ vNav: กลุ่มที่ปิดอยู่ (หรือแถบย่อ) แสดงผลรวมของเมนูลูก · เร่งถ้ามีเมนูลูกที่เร่ง
  const kidN = (k: { key: string }) => (g.key === 'fav' ? 0 : (badges[k.key] ?? 0));
  const sum = hasKids && !open ? g.kids!.reduce((a, k) => a + kidN(k), 0) : 0;
  const urgS = hasKids && !open && g.kids!.some((k) => URGENT.has(k.key) && kidN(k) > 0);
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
          {mini && sum > 0 && (
            <span
              data-testid="nav-dot"
              style={{
                position: 'absolute',
                top: -3,
                right: -3,
                width: 9,
                height: 9,
                borderRadius: '50%',
                background: urgS ? '#B3322A' : '#2257C4',
                border: '2px solid #FFFFFF',
              }}
            />
          )}
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
            {isLocked(g.feature, locks) && (
              <Icon
                n="lock"
                s={12}
                style={{ color: '#59606B', flexShrink: 0 }}
                aria-label={t('nav.locked')}
              />
            )}
            {sum > 0 && <Badge n={sum} urgent={urgS} />}
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
                {isLocked(k.feature, locks) && (
                  <Icon
                    n="lock"
                    s={12}
                    style={{ color: '#59606B', flexShrink: 0 }}
                    aria-label={t('nav.locked')}
                  />
                )}
                {kidN(k) > 0 && <Badge n={kidN(k)} urgent={URGENT.has(k.key)} />}
              </button>
            );
          })}
        </div>
      )}
    </>
  );
}

/**
 * D-81 · D68-89 badge งานค้างบนเมนู (docs/03 §1/§4, ต้นแบบ TMS v4 `counts()`) — `GET /v1/me/badges` คืนเฉพาะเมนูที่ผู้ใช้มีสิทธิ์
 * ดึงทุก 60 วินาที + เมื่อกลับมาที่หน้าต่าง + หลังการเปลี่ยนข้อมูลสำเร็จทุกครั้ง (MutationCache ใน api.ts) · ผิดพลาด = ไม่แสดง badge (ไม่บล็อกเมนู)
 */
function useNavBadges(): Record<string, number> {
  const q = useQuery({
    queryKey: ['nav-badges'],
    queryFn: () => unwrap(api.GET('/v1/me/badges')),
    retry: false,
    staleTime: 30_000,
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
  });
  return Object.fromEntries((q.data?.data ?? []).map((b) => [b.key, b.count]));
}

/**
 * ท้าย sidebar: สถานะระบบบัญชี (ต้นแบบ foot.on "{ระบบ} เชื่อมต่อ · ซิงก์ HH:MM" / foot.off "ไม่ได้เชื่อมระบบบัญชี · ตั้งค่า")
 * ST7-T20 — เดิมแสดง "ไม่ได้เชื่อม" เสมอแม้มี connector · สถานะ หยุดชั่วคราว/ผิดพลาด ต้นแบบไม่มี [DECISION spec/12 §3]
 * ผู้ไม่มีสิทธิ์ดูการตั้งค่า / แพ็กเกจไม่มี connector = แสดงแบบไม่เชื่อม (ไม่เรียก API)
 */
function useErpFoot(enabled: boolean): { dot: string; label: string | null; sync: string | null } {
  const { t } = useI18n();
  const list = useQuery({
    queryKey: ['connectors'],
    queryFn: () => unwrap(api.GET('/v1/connectors')),
    enabled,
    retry: false,
    staleTime: 60_000,
  });
  const cs = enabled ? (list.data?.data ?? []) : [];
  const c = cs.find((x) => x.status === 'ACTIVE') ?? cs.find((x) => x.status === 'ERROR') ?? cs[0];
  const last = useQuery({
    queryKey: ['connector-commands', c?.id, 'DONE1'],
    queryFn: () =>
      unwrap(
        api.GET('/v1/connectors/{id}/commands', {
          params: { path: { id: c!.id }, query: { status: 'DONE', limit: 1 } },
        }),
      ),
    enabled: c?.status === 'ACTIVE',
    retry: false,
    staleTime: 60_000,
  });
  if (!c) return { dot: '#59606B', label: null, sync: null };
  const n = adapterName(t, c.adapterKey, c.displayName);
  const at = last.data?.data[0]?.doneAt;
  const hhmm = at
    ? new Intl.DateTimeFormat('en-GB', {
        hour: '2-digit',
        minute: '2-digit',
        timeZone: 'Asia/Bangkok',
      }).format(new Date(at))
    : null;
  // ST9-T04 (review L5): สถานะเดียวกับการ์ดการเชื่อมต่อ — ACTIVE แต่ healthCheck ล่าสุดล้ม (DEGRADED) = แดง
  if (c.status === 'ACTIVE' && c.lastHealthOk === false)
    return { dot: '#B3322A', label: t('shell.erpErr', { n }), sync: null };
  if (c.status === 'ACTIVE') return { dot: '#17733F', label: t('shell.erpOn', { n }), sync: hhmm };
  if (c.status === 'ERROR') return { dot: '#B3322A', label: t('shell.erpErr', { n }), sync: null };
  return { dot: '#59606B', label: t('shell.erpPaused', { n }), sync: null };
}
