/**
 * template อีเมล transactional (ST1-T03) — ไทย/อังกฤษ (D-11: จีนไม่บังคับ → ใช้อังกฤษ)
 * ทุกค่าที่แทนลงใน HTML ผ่าน escape เสมอ · ข้อความยึด design/prototype/TMS Signup (au.forgot)
 */
export type EmailLocale = 'th' | 'en';
export interface RenderedEmail {
  subject: string;
  text: string;
  html: string;
}

const esc = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );

/** โครง HTML เรียบ ๆ ที่ client อีเมลส่วนใหญ่แสดงได้ (inline style, ไม่มีรูป/สคริปต์) */
function layout(
  lang: EmailLocale,
  title: string,
  paras: string[],
  cta?: { href: string; label: string },
) {
  const body = paras.map((p) => `<p style="margin:0 0 12px">${esc(p)}</p>`).join('');
  const button = cta
    ? `<p style="margin:20px 0"><a href="${esc(cta.href)}" style="display:inline-block;padding:12px 22px;border-radius:999px;background:#2257C4;color:#FFFFFF;font-weight:600;text-decoration:none">${esc(cta.label)}</a></p><p style="margin:0 0 12px;font-size:12.5px;color:#59606B;word-break:break-all">${esc(cta.href)}</p>`
    : '';
  return `<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><title>${esc(title)}</title></head><body style="margin:0;padding:24px;background:#F4F5F2;font-family:Sarabun,'Noto Sans Thai',Arial,sans-serif;color:#101418;font-size:15px;line-height:1.6"><div style="max-width:520px;margin:0 auto;background:#FFFFFF;border:1px solid #CDD1C8;border-radius:16px;padding:28px"><h1 style="margin:0 0 12px;font-size:20px;font-weight:600;color:#13213F">${esc(title)}</h1>${body}${button}</div></body></html>`;
}

export interface TemplateVars {
  /** ST1-T24 แจ้ง owner ทุกครั้งที่ทีม Innovera เข้าใช้งานแทน (docs/04 A6) */
  impersonation_started: {
    tenantName: string;
    staffName: string;
    asUserName: string;
    reason: string;
    minutes: number;
    at: string;
  };
  /** ST1-T23 ช่องอีเมลของแจ้งเตือน — title/body render ตามภาษาผู้รับแล้ว; link = URL เต็มของเว็บ */
  notification: { title: string; body: string; link?: string };
  password_reset: { link: string; minutes: number };
  user_invitation: {
    link: string;
    days: number;
    tenantName: string;
    inviterName: string;
    roles: string;
  };
}
export type TemplateName = keyof TemplateVars;

type Renderer<K extends TemplateName> = (v: TemplateVars[K]) => RenderedEmail;

const TEMPLATES: { [K in TemplateName]: Record<EmailLocale, Renderer<K>> } = {
  impersonation_started: {
    th: (v) => {
      const title = `ทีมงาน TMS เข้าใช้งานบัญชี ${v.tenantName}`;
      const paras = [
        `${v.staffName} จากทีมงาน TMS เริ่มเข้าใช้งานแทนในนาม ${v.asUserName} เมื่อ ${v.at} (อ่านอย่างเดียว ไม่เกิน ${v.minutes} นาที)`,
        `เหตุผล: ${v.reason}`,
        'ทุกการกระทำถูกบันทึกในประวัติการใช้งาน ถ้าคุณไม่ได้ติดต่อทีมงาน กรุณาแจ้งกลับทันที',
      ];
      return {
        subject: `${title} — TMS`,
        text: `${title}\n\n${paras.join('\n\n')}\n`,
        html: layout('th', title, paras),
      };
    },
    en: (v) => {
      const title = `TMS staff accessed ${v.tenantName}`;
      const paras = [
        `${v.staffName} from the TMS team started a read-only session as ${v.asUserName} at ${v.at} (up to ${v.minutes} minutes).`,
        `Reason: ${v.reason}`,
        'Every action is recorded in the audit log. If you did not contact our team, reply immediately.',
      ];
      return {
        subject: `${title} — TMS`,
        text: `${title}\n\n${paras.join('\n\n')}\n`,
        html: layout('en', title, paras),
      };
    },
  },
  notification: {
    th: ({ title, body, link }) => ({
      subject: `${title} — TMS`,
      text: `${title}\n\n${body}\n${link ? `\n${link}\n` : ''}`,
      html: layout('th', title, [body], link ? { href: link, label: 'เปิดในระบบ' } : undefined),
    }),
    en: ({ title, body, link }) => ({
      subject: `${title} — TMS`,
      text: `${title}\n\n${body}\n${link ? `\n${link}\n` : ''}`,
      html: layout('en', title, [body], link ? { href: link, label: 'Open in TMS' } : undefined),
    }),
  },
  user_invitation: {
    th: ({ link, days, tenantName, inviterName, roles }) => {
      const title = `คำเชิญเข้าร่วม ${tenantName}`;
      const paras = [
        `${inviterName} เชิญคุณเข้าใช้งานระบบบริหารงานขนส่งของ ${tenantName} ในบทบาท ${roles}`,
        `เปิดลิงก์ด้านล่างเพื่อรับคำเชิญ ลิงก์ใช้ได้ ${days} วันและใช้ได้ครั้งเดียว`,
        'ถ้าคุณไม่รู้จักผู้เชิญ ไม่ต้องทำอะไร',
      ];
      return {
        subject: `คำเชิญเข้าร่วม ${tenantName} — TMS`,
        text: `${title}\n\n${paras.join('\n\n')}\n\n${link}\n`,
        html: layout('th', title, paras, { href: link, label: 'รับคำเชิญ' }),
      };
    },
    en: ({ link, days, tenantName, inviterName, roles }) => {
      const title = `Invitation to join ${tenantName}`;
      const paras = [
        `${inviterName} invited you to the transport management system of ${tenantName} as ${roles}.`,
        `Open the link below to accept. The link works once and expires in ${days} days.`,
        'If you do not know the sender, ignore this email.',
      ];
      return {
        subject: `Invitation to join ${tenantName} — TMS`,
        text: `${title}\n\n${paras.join('\n\n')}\n\n${link}\n`,
        html: layout('en', title, paras, { href: link, label: 'Accept invitation' }),
      };
    },
  },
  password_reset: {
    th: ({ link, minutes }) => {
      const title = 'ตั้งรหัสผ่านใหม่';
      const paras = [
        'มีคำขอตั้งรหัสผ่านใหม่สำหรับบัญชีที่ใช้อีเมลนี้',
        `เปิดลิงก์ด้านล่างเพื่อตั้งรหัสผ่านใหม่ ลิงก์ใช้ได้ ${minutes} นาทีและใช้ได้ครั้งเดียว`,
        'ถ้าคุณไม่ได้ขอ ไม่ต้องทำอะไร รหัสผ่านเดิมยังใช้ได้ตามปกติ',
      ];
      return {
        subject: 'ตั้งรหัสผ่านใหม่ — TMS',
        text: `${title}\n\n${paras.join('\n\n')}\n\n${link}\n`,
        html: layout('th', title, paras, { href: link, label: title }),
      };
    },
    en: ({ link, minutes }) => {
      const title = 'Reset your password';
      const paras = [
        'We received a request to reset the password for the account using this email.',
        `Open the link below to set a new password. The link works once and expires in ${minutes} minutes.`,
        'If you did not ask for this, ignore this email — your current password still works.',
      ];
      return {
        subject: 'Reset your password — TMS',
        text: `${title}\n\n${paras.join('\n\n')}\n\n${link}\n`,
        html: layout('en', title, paras, { href: link, label: title }),
      };
    },
  },
};

export function renderEmail<K extends TemplateName>(
  template: K,
  locale: string,
  vars: TemplateVars[K],
): RenderedEmail {
  const lang: EmailLocale = locale === 'th' ? 'th' : 'en';
  return (TEMPLATES[template][lang] as Renderer<K>)(vars);
}
