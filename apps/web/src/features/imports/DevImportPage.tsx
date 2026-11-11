import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api, unwrap } from '../../api';
import { useI18n } from '../../i18n';
import { ImportWizard } from './ImportWizard';

/**
 * หน้าทดสอบ wizard นำเข้า (ST1-T19) — เปิดเฉพาะ dev (import.meta.env.DEV) ใช้ทำ E2E/ภาพเทียบ
 * จนกว่าหน้ารายการข้อมูลหลักจริงจะมีปุ่ม "นำเข้า Excel" ใน ST2-T23
 */
export function DevImportPage() {
  const { t } = useI18n();
  const kinds = useQuery({
    queryKey: ['import-kinds'],
    queryFn: () => unwrap(api.GET('/v1/imports/kinds')),
  });
  const [open, setOpen] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const kind = kinds.data?.find((k) => k.kind === 'sample');
  return (
    <div style={{ padding: 24 }}>
      <button
        type="button"
        disabled={!kind}
        onClick={() => setOpen(true)}
        className="tms-btn"
        style={{
          height: 36,
          padding: '0 14px',
          border: '1px solid #9DB6E3',
          borderRadius: 999,
          background: '#FFFFFF',
          color: '#2257C4',
          fontWeight: 500,
        }}
      >
        {t('imp.title', { kind: kind?.label ?? '' })}
      </button>
      {msg && <p role="status">{msg}</p>}
      {open && kind && (
        <ImportWizard
          kind={kind}
          onClose={(n) => {
            setOpen(false);
            if (n !== null) setMsg(t('imp.done', { kind: kind.label, n }));
          }}
        />
      )}
    </div>
  );
}
