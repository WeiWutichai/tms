import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { en } from './en';
import { th, type MessageKey } from './th';
import { zh } from './zh';

export type Lang = 'th' | 'en' | 'zh';
const CATALOG: Record<Lang, Partial<Record<MessageKey, string>>> = { th, en, zh };
const STORAGE_KEY = 'tms.lang';

function initialLang(): Lang {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (v === 'th' || v === 'en' || v === 'zh') return v;
  } catch {
    /* private mode */
  }
  return 'th';
}

export type T = (key: MessageKey, params?: Record<string, string | number>) => string;

const Ctx = createContext<{ lang: Lang; setLang: (l: Lang) => void; t: T } | null>(null);

/** i18n (ST0-T15): ทุกข้อความผ่าน key; ภาษาที่ไม่มีคำแปล → ไทย (D-11) */
export function I18nProvider({ children, lang: forced }: { children: ReactNode; lang?: Lang }) {
  const [lang, setLangState] = useState<Lang>(forced ?? initialLang);
  const setLang = useCallback((l: Lang) => {
    setLangState(l);
    try {
      localStorage.setItem(STORAGE_KEY, l);
    } catch {
      /* ignore */
    }
    document.documentElement.lang = l === 'zh' ? 'zh-CN' : l;
  }, []);
  const t = useCallback<T>(
    (key, params) => {
      let s = CATALOG[lang][key] ?? th[key] ?? key;
      if (params)
        for (const [k, v] of Object.entries(params)) s = s.replaceAll(`{${k}}`, String(v));
      return s;
    },
    [lang],
  );
  const value = useMemo(() => ({ lang, setLang, t }), [lang, setLang, t]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useI18n() {
  const v = useContext(Ctx);
  if (!v) throw new Error('useI18n outside I18nProvider');
  return v;
}

const TH_DAYS = ['อาทิตย์', 'จันทร์', 'อังคาร', 'พุธ', 'พฤหัสบดี', 'ศุกร์', 'เสาร์'];
const TH_MONTHS = [
  'ม.ค.',
  'ก.พ.',
  'มี.ค.',
  'เม.ย.',
  'พ.ค.',
  'มิ.ย.',
  'ก.ค.',
  'ส.ค.',
  'ก.ย.',
  'ต.ค.',
  'พ.ย.',
  'ธ.ค.',
];

/** วันที่ตามต้นแบบ: "อังคารที่ 3 พ.ย. 2569" (ไทย) — ปี พ.ศ./ค.ศ. ตาม tenant (D-30) */
export function formatLongDate(d: Date, lang: Lang, yearStyle: 'BE' | 'CE' = 'BE'): string {
  const y = d.getFullYear() + (yearStyle === 'BE' ? 543 : 0);
  if (lang === 'th')
    return `${TH_DAYS[d.getDay()]}ที่ ${d.getDate()} ${TH_MONTHS[d.getMonth()]} ${y}`;
  const loc = lang === 'zh' ? 'zh-CN' : 'en-GB';
  return new Intl.DateTimeFormat(loc, {
    weekday: 'long',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  }).format(d);
}

/** วันที่สั้น: "3 พ.ย. 2569" */
export function formatDate(d: Date, lang: Lang, yearStyle: 'BE' | 'CE' = 'BE'): string {
  if (lang === 'th')
    return `${d.getDate()} ${TH_MONTHS[d.getMonth()]} ${d.getFullYear() + (yearStyle === 'BE' ? 543 : 0)}`;
  return new Intl.DateTimeFormat(lang === 'zh' ? 'zh-CN' : 'en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  }).format(d);
}

/** วันเวลาแบบ caption: "3 พ.ย. 2569 09:42" */
export function formatDateTime(iso: string, lang: Lang, yearStyle: 'BE' | 'CE' = 'BE'): string {
  const d = new Date(iso);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  if (lang === 'th')
    return `${d.getDate()} ${TH_MONTHS[d.getMonth()]} ${d.getFullYear() + (yearStyle === 'BE' ? 543 : 0)} ${hh}:${mm}`;
  return `${new Intl.DateTimeFormat(lang === 'zh' ? 'zh-CN' : 'en-GB', { day: 'numeric', month: 'short', year: 'numeric' }).format(d)} ${hh}:${mm}`;
}

/** ตัวเลขเงิน "1,234.50" — รับ string ทศนิยมจาก API (ไม่แปลงเป็น float) */
export function formatMoney(amount: string): string {
  const [w, f = '00'] = amount.replace('-', '').split('.');
  const grouped = (w ?? '0').replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${amount.startsWith('-') ? '-' : ''}${grouped}.${f.padEnd(2, '0').slice(0, 2)}`;
}
