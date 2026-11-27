import { ApiError } from '../api';
import { problemText } from '../features/master/problems';
import { useI18n } from '../i18n';
import { problemHelpUrl } from './routes';

/**
 * แถบ error บนสุดของ drawer/ฟอร์ม (`tms-alert`) + ลิงก์ "ดูวิธีแก้" ไปหัวข้อของรหัสนั้นใน catalog ของ help center (P1-ST6-T02)
 * โครงเดียวกับแถบ "ข้อมูลเปลี่ยนแล้ว" ของต้นแบบ (ข้อความซ้าย + `tms-textlink` ขวา) — ไม่มีลิงก์เมื่อไม่ใช่ problem+json (เช่น เครือข่ายล่ม)
 * `text` ว่าง (เช่น 422 ที่ error ลงช่องกรอกแล้ว) = ใช้ข้อความของ problem (`problem.<code>`) — แถบสรุปบนสุด + error ใต้ช่องเหมือนแถบ
 * "กรอกข้อมูลให้ครบ n ช่อง" ของต้นแบบ จึงมีลิงก์วิธีแก้ทุกครั้งที่ API ตอบ error · ยกเลิก 2FA (ไม่ใช่ error) = ไม่แสดง
 */
export function ProblemAlert({ err, text }: { err: unknown; text?: string | null }) {
  const { t } = useI18n();
  if (!err) return null;
  const msg = text ?? problemText(err, t);
  if (!msg) return null;
  const code = err instanceof ApiError ? err.problem.code : undefined;
  if (!code) return <div className="tms-alert">{msg}</div>;
  return (
    <div className="tms-alert" style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
      <span style={{ flex: 1 }}>{msg}</span>
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
