import { ApiError } from '../api';
import { useI18n } from '../i18n';
import { problemHelpUrl } from './routes';

/**
 * แถบ error บนสุดของ drawer/ฟอร์ม (`tms-alert`) + ลิงก์ "ดูวิธีแก้" ไปหัวข้อของรหัสนั้นใน catalog ของ help center (P1-ST6-T02)
 * โครงเดียวกับแถบ "ข้อมูลเปลี่ยนแล้ว" ของต้นแบบ (ข้อความซ้าย + `tms-textlink` ขวา) — ไม่มีลิงก์เมื่อไม่ใช่ problem+json (เช่น เครือข่ายล่ม)
 */
export function ProblemAlert({ err, text }: { err: unknown; text: string }) {
  const { t } = useI18n();
  const code = err instanceof ApiError ? err.problem.code : undefined;
  if (!code) return <div className="tms-alert">{text}</div>;
  return (
    <div className="tms-alert" style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
      <span style={{ flex: 1 }}>{text}</span>
      <a
        className="tms-textlink"
        href={problemHelpUrl(code)}
        target="_blank"
        rel="noopener noreferrer"
        style={{ textDecoration: 'none' }}
        data-testid="problem-help"
      >
        {t('help.problem')}
      </a>
    </div>
  );
}
