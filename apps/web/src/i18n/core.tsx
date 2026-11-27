import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import type { MessageKey } from './th';

/**
 * แกนของ i18n (context + provider + hook) ที่ไม่ import ชุดข้อความ — ผู้ใช้ส่ง `catalogs` เอง
 * แอปใช้ `I18nProvider` ใน ./index (ชุดข้อความเต็ม) · landing (P1-ST2-T01) ใช้ชุดย่อย ./landing.gen
 * เพื่อไม่ต้องโหลดข้อความทั้งแอปในหน้าแรก (Lighthouse มือถือ ≥ 80)
 */
export type Lang = 'th' | 'en' | 'zh';
export type Catalogs = Record<Lang, Partial<Record<MessageKey, string>>>;
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
export function I18nCoreProvider({
  children,
  lang: forced,
  catalogs,
}: {
  children: ReactNode;
  lang?: Lang;
  catalogs: Catalogs;
}) {
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
  // ภาษาที่จำไว้ → `<html lang>` ตั้งแต่โหลดหน้าแรก (ไม่ใช่เฉพาะตอนกดสลับ)
  useEffect(() => {
    document.documentElement.lang = lang === 'zh' ? 'zh-CN' : lang;
  }, [lang]);
  const t = useCallback<T>(
    (key, params) => {
      let s = catalogs[lang][key] ?? catalogs.th[key] ?? key;
      if (params)
        for (const [k, v] of Object.entries(params)) s = s.replaceAll(`{${k}}`, String(v));
      return s;
    },
    [lang, catalogs],
  );
  const value = useMemo(() => ({ lang, setLang, t }), [lang, setLang, t]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useI18n() {
  const v = useContext(Ctx);
  if (!v) throw new Error('useI18n outside I18nProvider');
  return v;
}
