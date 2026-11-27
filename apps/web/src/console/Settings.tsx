import type { components } from '@tms/contracts';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { queryClient } from '../api';
import { useI18n, type Lang } from '../i18n';
import { th, type MessageKey } from '../i18n/th';
import { can, consoleApi, cunwrap, useStaff } from './session';
import { ActionDialog, type Field } from './Tenants';

type Setting = components['schemas']['PlatformSettingDto'];
type Group = Setting['group'];
const GROUPS: Group[] = ['trial', 'dunning', 'retention', 'usage', 'billing', 'ops'];

/** ข้อความจาก key ที่อาจไม่มีใน th (ค่าใหม่ใน registry ก่อนแปล) → แสดง key ตรง ๆ */
function useLabel() {
  const { t } = useI18n();
  return (k: string, fallback = k) => (k in th ? t(k as MessageKey) : fallback);
}

function fmtDate(iso: string, lang: Lang): string {
  const loc = lang === 'th' ? 'th-TH-u-ca-buddhist' : lang === 'zh' ? 'zh-CN' : 'en-GB';
  return new Intl.DateTimeFormat(loc, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Asia/Bangkok',
  }).format(new Date(iso));
}

/** ค่าสำหรับแสดง (ใช้ทั้งค่าปัจจุบันและค่าเริ่มต้น) */
function useFormat() {
  const { t } = useI18n();
  const label = useLabel();
  const opt = (v: string) => label(`con.set.opt.${v}`, v);
  return (s: Setting, v: unknown): string => {
    if (s.type === 'bool') return v ? t('con.set.on') : t('con.set.off');
    if (s.type === 'enum') return opt(String(v));
    if (s.type === 'set') return (v as string[]).map(opt).join(' · ');
    if (s.type === 'dayLists')
      return (s.keys ?? [])
        .map((k) => `${opt(k)} ${((v as Record<string, number[]>)[k] ?? []).join(', ')}`)
        .join(' · ');
    return String(v);
  };
}

/**
 * หน้า "ตั้งค่าแพลตฟอร์ม" (P1-ST1-T04; spec/01 §9 PLT-099) — ต้นแบบ Platform Console ไม่มีหน้านี้:
 * ประกอบจากโครงหน้า "ลูกค้า"/"แพ็กเกจ" ของต้นแบบ (หัวเรื่อง + แท็บ + ตาราง + dialog การกระทำพร้อมเหตุผล) ตาม D-83
 * [DECISION — lead 27 พ.ย. 2569, ย้อนได้] spec/12 §3 · แก้ได้เฉพาะ owner (SUPER_ADMIN) — บทบาทอื่นดูอย่างเดียว
 */
export function SettingsPage() {
  const { t, lang } = useI18n();
  const label = useLabel();
  const fmt = useFormat();
  const staff = useStaff();
  const owner = can.settings(staff.data?.role);
  const list = useQuery({
    queryKey: ['console', 'settings'],
    queryFn: () => cunwrap(consoleApi.GET('/v1/platform/settings')),
  });
  const [tab, setTab] = useState<'all' | Group>('all');
  const [edit, setEdit] = useState<Setting | null>(null);
  const [toast, setToast] = useState('');
  useEffect(() => {
    if (!toast) return;
    const h = setTimeout(() => setToast(''), 3400);
    return () => clearTimeout(h);
  }, [toast]);

  const rows = list.data ?? [];
  const shown = rows.filter((r) => tab === 'all' || r.group === tab);
  const tabs: ['all' | Group, string, number][] = [
    ['all', t('con.set.all'), rows.length],
    ...GROUPS.map(
      (g) =>
        [g, t(`con.set.g.${g}` as MessageKey), rows.filter((r) => r.group === g).length] as [
          Group,
          string,
          number,
        ],
    ),
  ];

  return (
    <>
      <div className="con-title">
        <div style={{ flex: 1, minWidth: 260 }}>
          <h1>{t('con.set.title')}</h1>
          <p>{t('con.set.sub')}</p>
        </div>
      </div>
      <div className="con-tabs" role="tablist">
        {tabs.map(([k, l, n]) => (
          <button
            key={k}
            type="button"
            role="tab"
            className="con-tab"
            aria-selected={tab === k}
            onClick={() => setTab(k)}
          >
            {l}
            {n ? <span className="con-tab__n">{n}</span> : null}
          </button>
        ))}
      </div>
      <section className="con-card">
        <table className="con-tbl">
          <thead>
            <tr>
              <th>{t('con.set.col.name')}</th>
              <th>{t('con.set.col.value')}</th>
              <th>{t('con.set.col.default')}</th>
              <th>{t('con.set.col.updated')}</th>
            </tr>
          </thead>
          <tbody>
            {list.isLoading
              ? Array.from({ length: 6 }, (_, i) => (
                  <tr key={i} aria-hidden="true">
                    {[200, 120, 120, 140].map((w, j) => (
                      <td key={j}>
                        <span className="con-skel" style={{ width: w }} />
                      </td>
                    ))}
                  </tr>
                ))
              : shown.map((r) => (
                  <tr
                    key={r.key}
                    aria-selected={edit?.key === r.key}
                    style={owner ? undefined : { cursor: 'default' }}
                    title={owner ? t('con.set.edit') : t('con.set.ownerOnly')}
                    onClick={() => (owner ? setEdit(r) : setToast(t('con.set.ownerOnly')))}
                  >
                    <td>
                      <div className="con-cell">
                        <span style={{ fontWeight: 500 }}>{label(`con.set.k.${r.key}`)}</span>
                        <span className="con-cell__sub">{r.key}</span>
                      </div>
                    </td>
                    <td>
                      <div className="con-cell">
                        <span style={{ fontWeight: r.isDefault ? 400 : 600 }}>
                          {fmt(r, r.value)}
                        </span>
                        {r.isDefault && (
                          <span className="con-cell__sub">{t('con.set.isDefault')}</span>
                        )}
                      </div>
                    </td>
                    <td>
                      <div className="con-cell">
                        <span style={{ color: '#3B424C' }}>{fmt(r, r.default)}</span>
                        <span className="con-cell__sub">{r.source}</span>
                      </div>
                    </td>
                    <td style={{ color: '#3B424C', whiteSpace: 'nowrap' }}>
                      {r.updatedAt
                        ? t('con.set.by', { d: fmtDate(r.updatedAt, lang), n: r.updatedBy ?? '—' })
                        : '—'}
                    </td>
                  </tr>
                ))}
          </tbody>
        </table>
        {list.isError && <div className="con-empty">{t('con.loadFailed')}</div>}
      </section>
      {edit && (
        <SettingDialog
          s={edit}
          onClose={() => setEdit(null)}
          onDone={() => {
            setToast(t('con.toast.setting', { n: label(`con.set.k.${edit.key}`) }));
            setEdit(null);
            void queryClient.invalidateQueries({ queryKey: ['console', 'settings'] });
          }}
        />
      )}
      {toast && (
        <div className="con-toast" role="status">
          {toast}
        </div>
      )}
    </>
  );
}

const DEC_RE = /^\d{1,3}(\.\d{1,2})?$/;
const listOf = (s: string) =>
  s
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);

type SettingValue = components['schemas']['UpdatePlatformSettingDto']['value'];

/** แปลงค่าจากช่องกรอก → ค่าตาม type (null = รูปแบบผิด — server ตรวจช่วง/ตัวเลือกซ้ำอีกชั้น) */
function parse(s: Setting, v: Record<string, string>): SettingValue | null {
  const x = (v.value ?? '').trim();
  switch (s.type) {
    case 'int':
      return /^\d+$/.test(x) ? Number(x) : null;
    case 'decimal':
      return DEC_RE.test(x) ? x : null;
    case 'bool':
      return x === 'true';
    case 'enum':
      return x;
    case 'set':
      return listOf(x).length ? listOf(x) : null;
    case 'dayLists': {
      const out: Record<string, number[]> = {};
      for (const k of s.keys ?? []) {
        const parts = listOf(v[k] ?? '');
        if (!parts.every((p) => /^\d+$/.test(p))) return null;
        out[k] = parts.map(Number);
      }
      return out;
    }
    default:
      return null;
  }
}

function SettingDialog({
  s,
  onClose,
  onDone,
}: {
  s: Setting;
  onClose: () => void;
  onDone: () => void;
}) {
  const { t } = useI18n();
  const label = useLabel();
  const opt = (v: string) => label(`con.set.opt.${v}`, v);
  const range =
    s.min !== undefined ? t('con.set.f.range', { min: String(s.min), max: String(s.max) }) : '';
  let fields: Field[];
  let init: Record<string, string>;
  if (s.type === 'dayLists') {
    fields = (s.keys ?? []).map((k) => ({
      k,
      l: 'con.set.f.value',
      label: opt(k),
      type: 'in',
      hint: `${t('con.set.f.days')} · ${range}`,
    }));
    init = Object.fromEntries(
      (s.keys ?? []).map((k) => [k, ((s.value as Record<string, number[]>)[k] ?? []).join(', ')]),
    );
  } else if (s.type === 'bool' || s.type === 'enum') {
    const opts =
      s.type === 'bool'
        ? [
            { v: 'true', l: t('con.set.on') },
            { v: 'false', l: t('con.set.off') },
          ]
        : (s.options ?? []).map((o) => ({ v: o, l: opt(o) }));
    fields = [{ k: 'value', l: 'con.set.f.value', type: 'sel', opts }];
    init = { value: String(s.value) };
  } else if (s.type === 'set') {
    fields = [
      {
        k: 'value',
        l: 'con.set.f.value',
        type: 'in',
        hint: t('con.set.f.set', {
          opts: (s.options ?? []).map((o) => `${o} = ${opt(o)}`).join(', '),
        }),
      },
    ];
    init = { value: (s.value as unknown as string[]).join(', ') };
  } else {
    fields = [{ k: 'value', l: 'con.set.f.value', type: 'in', im: 'numeric', hint: range }];
    init = { value: String(s.value) };
  }
  return (
    <ActionDialog
      title={t('con.set.dlgT', { n: label(`con.set.k.${s.key}`) })}
      desc={`${s.description} · ${t('con.set.dlgD')}`}
      fields={fields}
      init={init}
      okL={t('con.set.save')}
      check={(v) => (parse(s, v) === null ? t('con.set.bad') : '')}
      onClose={onClose}
      onOk={async (v, reason) => {
        await cunwrap(
          consoleApi.PUT('/v1/platform/settings/{key}', {
            // docs/01 §5.1: If-Match = version ที่เห็น → มีคนแก้ก่อน = 412 "ข้อมูลถูกแก้ไขโดยผู้อื่นแล้ว"
            params: { path: { key: s.key }, header: { 'If-Match': `"${s.version}"` } as never },
            body: { value: parse(s, v)!, reason },
          }),
        );
        onDone();
      }}
    />
  );
}
