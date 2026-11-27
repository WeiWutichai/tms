import { Icon } from '@tms/ui';
import { useQuery } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { api, ApiError, unwrap } from '../../api';
import { useI18n } from '../../i18n';
import { problemText } from '../master/problems';
import { useSaveTenantSettings, useTenantSettings } from './useSettings';

/** P1-ST6-T04 ชนิด/ขนาดโลโก้ (ตรงกับ API: kind LOGO = PNG/SVG ≤ 2 MB) */
export const LOGO_TYPES = ['image/png', 'image/svg+xml'] as const;
export const LOGO_MAX = 2 * 1024 * 1024;
/** SVG ≤ 512 KB (API ล้าง SVG ก่อนเก็บ — [DECISION — lead 27 พ.ย. 2569, ย้อนได้]) */
export const LOGO_SVG_MAX = 512 * 1024;
const KEY = 'org.logoDocumentId';

/** อัปโหลดไฟล์โลโก้ (POST /v1/documents kind LOGO → PUT เนื้อไฟล์ — SVG ถูกล้างที่ server) → id */
export async function uploadLogo(f: File): Promise<string> {
  const mime = LOGO_TYPES.find((m) => m === f.type);
  if (!mime || f.size === 0 || f.size > (mime === 'image/svg+xml' ? LOGO_SVG_MAX : LOGO_MAX))
    throw new Error('bad_file');
  const doc = await unwrap(
    api.POST('/v1/documents', {
      body: { kind: 'LOGO', mime, bytes: f.size, filename: f.name || 'logo' },
    }),
  );
  const u = new URL(doc.uploadUrl!, location.origin);
  const up = await fetch(u.pathname + u.search, { method: 'PUT', body: f });
  if (!up.ok) throw new ApiError((await up.json()) as never);
  return doc.id;
}

/**
 * ตั้งค่า → องค์กร: กล่องโลโก้ 64 px + "โลโก้ (ใช้บนเอกสารและหน้าติดตามของผู้รับ)" + ปุ่ม "เปลี่ยนโลโก้" (ต้นแบบ TMS v4 `st.is.org`)
 * - ยังไม่มีโลโก้ = กล่องกรมท่า + ไอคอนรถ ตามต้นแบบ · มีแล้ว = รูปโลโก้ในกล่องขนาดเดิม [DECISION spec/12 §3 — ต้นแบบไม่มีสถานะนี้]
 * - เลือกไฟล์ (PNG ≤ 2 MB / SVG ≤ 512 KB) → อัปโหลด → บันทึกค่าตั้ง `org.logoDocumentId` ทันที (ไม่รอปุ่ม "บันทึก" ลอย — ไฟล์อัปโหลดแล้ว)
 */
export function OrgLogo({ canWrite }: { canWrite: boolean }) {
  const { t } = useI18n();
  const settings = useTenantSettings();
  const save = useSaveTenantSettings();
  const file = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ text: string; err: boolean } | null>(null);
  const row = settings.data?.data.find((s) => s.key === KEY);
  const id = typeof row?.value === 'string' ? row.value : null;
  const url = useQuery({
    queryKey: ['documents', id, 'url'],
    enabled: !!id,
    staleTime: 60_000,
    retry: false,
    queryFn: async () => {
      const d = await unwrap(api.GET('/v1/documents/{id}', { params: { path: { id: id! } } }));
      if (!d.downloadUrl) return null;
      const u = new URL(d.downloadUrl, location.origin);
      return u.pathname + u.search;
    },
  });

  const pick = async (f: File | undefined) => {
    if (file.current) file.current.value = '';
    if (!f) return;
    setBusy(true);
    setMsg(null);
    try {
      const doc = await uploadLogo(f);
      await save.mutateAsync({ values: { [KEY]: doc }, versions: { [KEY]: row?.version ?? 0 } });
      setMsg({ text: t('org.logoSaved'), err: false });
    } catch (e) {
      setMsg({
        text:
          e instanceof Error && e.message === 'bad_file'
            ? t('org.logoBad')
            : (problemText(e, t) ?? t('org.logoError')),
        err: true,
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
      {url.data ? (
        <div
          data-testid="org-logo"
          style={{
            width: 64,
            height: 64,
            borderRadius: 12,
            background: '#FFFFFF',
            border: '1px solid #E4E6E0',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            overflow: 'hidden',
            flexShrink: 0,
          }}
        >
          <img
            src={url.data}
            alt={t('org.logo')}
            style={{ maxWidth: 56, maxHeight: 56, objectFit: 'contain' }}
          />
        </div>
      ) : (
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
            flexShrink: 0,
          }}
        >
          <Icon n="truck" s={28} />
        </div>
      )}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <span style={{ fontSize: 12.5, fontWeight: 500, color: '#3B424C' }}>{t('org.logo')}</span>
        <input
          ref={file}
          type="file"
          hidden
          accept={LOGO_TYPES.join(',')}
          data-testid="org-logo-input"
          onChange={(e) => void pick(e.target.files?.[0])}
        />
        <button
          type="button"
          className="set-btn2"
          disabled={!canWrite || busy}
          aria-busy={busy}
          title={t('org.logoHint')}
          onClick={() => file.current?.click()}
          style={{ alignSelf: 'flex-start' }}
        >
          <Icon n="upload" s={16} />
          {t('org.logoChange')}
        </button>
        {msg && (
          <span
            role={msg.err ? 'alert' : 'status'}
            style={{ fontSize: 12.5, color: msg.err ? '#B3322A' : '#17733F' }}
          >
            {msg.text}
          </span>
        )}
      </div>
    </div>
  );
}
