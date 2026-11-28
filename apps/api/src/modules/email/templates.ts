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

/** ข้อความหลายบรรทัด → ย่อหน้าละบรรทัด (สรุปเตือนวันหมดอายุ ST2-T18) */
const paras = (body: string) => body.split('\n').filter((l) => l.trim() !== '');

/** P1-ST1-T03 ป้าย + คำอธิบายผลของแต่ละสถานะ (ป้ายไทยตรงกับ design/prototype/plans.js statuses) */
const STATUS_TH: Record<string, [string, string]> = {
  pending_verification: ['รอยืนยัน', 'ใช้งานแบบทดลองได้ระหว่างรอทีมงานตรวจข้อมูลบริษัท'],
  trialing: ['ทดลองใช้', 'ใช้งานได้ตามปกติจนถึงวันหมดทดลองใช้'],
  active: ['ใช้งาน', 'บัญชีกลับมาใช้งานได้ตามปกติแล้ว'],
  past_due: ['ค้างชำระ', 'กรุณาชำระค่าบริการเพื่อไม่ให้บัญชีเปลี่ยนเป็นอ่านอย่างเดียว'],
  read_only: [
    'อ่านอย่างเดียว',
    'สร้างงานใหม่หรือแก้ไขข้อมูลไม่ได้ ดูและส่งออกข้อมูลได้ตามปกติ ชำระค่าบริการเพื่อใช้งานต่อ',
  ],
  suspended: [
    'ระงับ',
    'ผู้ใช้ทุกคนเข้าระบบไม่ได้ชั่วคราว ข้อมูลยังอยู่ครบ ติดต่อทีมงาน TMS เพื่อใช้งานต่อ',
  ],
  cancelled: [
    'ยกเลิก',
    'บัญชีถูกยกเลิก ข้อมูลยังเก็บไว้ถึงวันที่กำหนดด้านล่าง ติดต่อทีมงาน TMS เพื่อขอข้อมูลคืนหรือกลับมาใช้งาน',
  ],
};
const STATUS_EN: Record<string, [string, string]> = {
  pending_verification: [
    'Pending verification',
    'You can use a limited trial while our team verifies your company.',
  ],
  trialing: ['Trial', 'You can use TMS as usual until your trial ends.'],
  active: ['Active', 'Your account is fully active again.'],
  past_due: [
    'Past due',
    'Please pay your subscription to keep your account from becoming read-only.',
  ],
  read_only: [
    'Read-only',
    'You cannot create or edit data. Viewing and exporting still work. Pay your subscription to continue.',
  ],
  suspended: [
    'Suspended',
    'Nobody in your company can sign in for now. Your data is kept. Contact the TMS team to continue.',
  ],
  cancelled: [
    'Cancelled',
    'Your account was cancelled. Your data is kept until the date below. Contact the TMS team to get your data back or to reactivate.',
  ],
};

export interface TemplateVars {
  /**
   * P1-ST1-T03 แจ้งเจ้าของบริษัทเมื่อสถานะบัญชีเปลี่ยน (spec/01 §1 ข้อ 6 "อีเมล", PLT-103) — `to` = รหัสสถานะ (lowercase)
   * reason ผ่าน safeName แล้ว · ไม่มียอดเงินในข้อความ
   */
  tenant_status_changed: {
    tenantName: string;
    to: string;
    reason: string;
    at: string;
    /** วันที่ลบข้อมูลตามกำหนด (cancelled) — วันที่จัดรูปแบบแล้ว */
    purgeDate?: string;
  };
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
  /** ST9-T19 alert ถึงทีม Innovera (เปิด/ปิด) — ค่าเป็นตัวเลข/รหัส sink/connector เท่านั้น ไม่มีข้อมูลลูกค้า */
  monitor_alert: {
    resolved: boolean;
    severity: 'critical' | 'warning';
    rule: string;
    label: string;
    subject: string | null;
    value: string;
    threshold: string;
    openedAt: string;
    resolvedAt?: string;
  };
  password_reset: { link: string; minutes: number };
  /**
   * คำถามค้าง #81 (PO 24 พ.ย. 2569) แจ้งเจ้าของบัญชีเมื่อถูกรีเซ็ต 2FA — โดยผู้ดูแลของบริษัท (`byStaff` false)
   * หรือทีม Innovera ผ่าน Console (`byStaff` true) · actorName ผ่าน safeName แล้ว
   */
  two_factor_reset: {
    tenantName: string;
    actorName: string;
    byStaff: boolean;
    reason: string;
    at: string;
    /** role/องค์กรบังคับ 2FA (D-78 / ST1-T17) → login ครั้งถัดไปต้องตั้งใหม่ · false = 2FA ปิดอยู่ เข้าด้วยรหัสผ่านได้ */
    mustEnroll: boolean;
  };
  /**
   * ST5-T21 เอกสารถึงลูกค้า (แนบ PDF) — ไม่ใส่ยอดเงินในเนื้ออีเมล (ยอดอยู่ใน PDF) · วันที่จัดรูปแบบตามที่ tenant ตั้งแล้ว
   * BILLING_NOTE = ไฟล์รวม "ใบวางบิล + ใบแจ้งหนี้" · INVOICE = ใบแจ้งหนี้ · PAYMENT_REMINDER = ใบแจ้งเตือนชำระ (แนบใบแจ้งหนี้)
   */
  customer_document: {
    kind: 'BILLING_NOTE' | 'INVOICE' | 'PAYMENT_REMINDER';
    issuerName: string;
    customerName: string;
    documentNo: string;
    invoiceNos: string[];
    dueDate: string | null;
    collectionDate: string | null;
    filename: string;
  };
  /** P1-ST4-T06 เชิญทีมงาน Innovera เข้า Platform Console (ตั้งรหัสผ่าน + 2FA ในหน้ารับคำเชิญ) · ชื่อผ่าน safeName แล้ว */
  platform_staff_invitation: { link: string; days: number; inviterName: string; role: string };
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
  tenant_status_changed: {
    th: (v) => {
      const [label, note] = STATUS_TH[v.to] ?? [v.to, ''];
      const title = `สถานะบัญชี ${v.tenantName}: ${label}`;
      const paras = [
        `สถานะบัญชีของ ${v.tenantName} เปลี่ยนเป็น "${label}" เมื่อ ${v.at}`,
        note,
        `เหตุผล: ${v.reason}`,
        ...(v.purgeDate ? [`ข้อมูลเก็บไว้ถึง ${v.purgeDate}`] : []),
      ].filter(Boolean);
      return {
        subject: `${title} — TMS`,
        text: `${title}\n\n${paras.join('\n\n')}\n`,
        html: layout('th', title, paras),
      };
    },
    en: (v) => {
      const [label, note] = STATUS_EN[v.to] ?? [v.to, ''];
      const title = `${v.tenantName} account status: ${label}`;
      const paras = [
        `The account status of ${v.tenantName} changed to "${label}" at ${v.at}.`,
        note,
        `Reason: ${v.reason}`,
        ...(v.purgeDate ? [`Your data is kept until ${v.purgeDate}.`] : []),
      ].filter(Boolean);
      return {
        subject: `${title} — TMS`,
        text: `${title}\n\n${paras.join('\n\n')}\n`,
        html: layout('en', title, paras),
      };
    },
  },
  customer_document: {
    th: (v) => {
      const title =
        v.kind === 'BILLING_NOTE'
          ? `ใบวางบิล ${v.documentNo}`
          : v.kind === 'INVOICE'
            ? `ใบแจ้งหนี้ ${v.documentNo}`
            : `แจ้งเตือนชำระ ใบแจ้งหนี้ ${v.documentNo}`;
      const paras = [
        `เรียน ${v.customerName}`,
        v.kind === 'BILLING_NOTE'
          ? `${v.issuerName} ขอส่งใบวางบิลเลขที่ ${v.documentNo} พร้อมใบแจ้งหนี้ ${v.invoiceNos.length} ฉบับ (${v.invoiceNos.join(', ')}) ตามไฟล์แนบ`
          : v.kind === 'INVOICE'
            ? `${v.issuerName} ขอส่งใบแจ้งหนี้เลขที่ ${v.documentNo} ตามไฟล์แนบ`
            : `${v.issuerName} ขอแจ้งเตือนการชำระเงินตามใบแจ้งหนี้เลขที่ ${v.documentNo} (แนบใบแจ้งหนี้)`,
        ...(v.collectionDate ? [`นัดรับเช็ค / โอนเงิน ภายในวันที่ ${v.collectionDate}`] : []),
        ...(v.dueDate ? [`ครบกำหนดชำระวันที่ ${v.dueDate}`] : []),
        v.kind === 'BILLING_NOTE'
          ? `ไฟล์แนบ ${v.filename} — หน้าแรกเป็นใบวางบิล ตามด้วยใบแจ้งหนี้ตามลำดับในใบวางบิล`
          : `ไฟล์แนบ ${v.filename}`,
        ...(v.kind === 'PAYMENT_REMINDER'
          ? ['หากท่านชำระเงินแล้ว ขออภัยและขอบคุณมา ณ ที่นี้']
          : []),
        `อีเมลนี้ส่งจากระบบอัตโนมัติ หากมีข้อสงสัยกรุณาติดต่อ ${v.issuerName}`,
      ];
      return {
        subject: `${title} — ${v.issuerName}`,
        text: `${title}\n\n${paras.join('\n\n')}\n`,
        html: layout('th', title, paras),
      };
    },
    en: (v) => {
      const title =
        v.kind === 'BILLING_NOTE'
          ? `Billing note ${v.documentNo}`
          : v.kind === 'INVOICE'
            ? `Invoice ${v.documentNo}`
            : `Payment reminder: invoice ${v.documentNo}`;
      const paras = [
        `Dear ${v.customerName}`,
        v.kind === 'BILLING_NOTE'
          ? `${v.issuerName} sends billing note ${v.documentNo} with ${v.invoiceNos.length} invoice(s) (${v.invoiceNos.join(', ')}) attached.`
          : v.kind === 'INVOICE'
            ? `${v.issuerName} sends invoice ${v.documentNo} attached.`
            : `${v.issuerName} reminds you of the payment for invoice ${v.documentNo} (attached).`,
        ...(v.collectionDate ? [`Cheque collection / transfer by ${v.collectionDate}`] : []),
        ...(v.dueDate ? [`Due date ${v.dueDate}`] : []),
        `Attachment: ${v.filename}`,
        ...(v.kind === 'PAYMENT_REMINDER'
          ? ['If you have already paid, thank you and please ignore this email.']
          : []),
        `This email was sent automatically. Please contact ${v.issuerName} with any questions.`,
      ];
      return {
        subject: `${title} — ${v.issuerName}`,
        text: `${title}\n\n${paras.join('\n\n')}\n`,
        html: layout('en', title, paras),
      };
    },
  },
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
      html: layout(
        'th',
        title,
        paras(body),
        link ? { href: link, label: 'เปิดในระบบ' } : undefined,
      ),
    }),
    en: ({ title, body, link }) => ({
      subject: `${title} — TMS`,
      text: `${title}\n\n${body}\n${link ? `\n${link}\n` : ''}`,
      html: layout(
        'en',
        title,
        paras(body),
        link ? { href: link, label: 'Open in TMS' } : undefined,
      ),
    }),
  },
  monitor_alert: {
    th: (v) => {
      const sev = v.severity === 'critical' ? 'วิกฤต' : 'เตือน';
      const title = v.resolved
        ? `[ปิดแล้ว] ${v.label}${v.subject ? ` (${v.subject})` : ''}`
        : `[${sev}] ${v.label}${v.subject ? ` (${v.subject})` : ''}`;
      const paras = [
        `กฎ: ${v.rule}${v.subject ? ` · ${v.subject}` : ''}`,
        v.resolved
          ? `กลับเป็นปกติเมื่อ ${v.resolvedAt ?? '-'} (ค่าล่าสุด ${v.value} · เกณฑ์ ${v.threshold})`
          : `ค่าปัจจุบัน ${v.value} เกินเกณฑ์ ${v.threshold}`,
        `เริ่มเมื่อ ${v.openedAt}`,
        'ดูรายละเอียดได้ที่ GET /v1/platform/monitoring/alerts และ /v1/metrics',
      ];
      return {
        subject: `${title} — TMS monitoring`,
        text: `${title}\n\n${paras.join('\n\n')}\n`,
        html: layout('th', title, paras),
      };
    },
    en: (v) => {
      const title = `${v.resolved ? '[RESOLVED]' : `[${v.severity.toUpperCase()}]`} ${v.rule}${v.subject ? ` (${v.subject})` : ''}`;
      const paras = [
        v.resolved
          ? `Recovered at ${v.resolvedAt ?? '-'} (last value ${v.value} · threshold ${v.threshold})`
          : `Current value ${v.value} is above the threshold ${v.threshold}`,
        `Started at ${v.openedAt}`,
        'Details: GET /v1/platform/monitoring/alerts and /v1/metrics',
      ];
      return {
        subject: `${title} — TMS monitoring`,
        text: `${title}\n\n${paras.join('\n\n')}\n`,
        html: layout('en', title, paras),
      };
    },
  },
  platform_staff_invitation: {
    th: ({ link, days, inviterName, role }) => {
      const title = 'คำเชิญเข้าร่วมทีมงาน TMS Platform Console';
      const paras = [
        `${inviterName} เชิญคุณเข้าร่วมทีมงาน TMS Platform Console ในบทบาท ${role}`,
        `เปิดลิงก์ด้านล่างเพื่อตั้งรหัสผ่านและยืนยันตัวตน 2 ชั้น (2FA) ลิงก์ใช้ได้ ${days} วันและใช้ได้ครั้งเดียว`,
        'ถ้าคุณไม่รู้จักผู้เชิญ ไม่ต้องทำอะไร',
      ];
      return {
        subject: `${title} — TMS`,
        text: `${title}\n\n${paras.join('\n\n')}\n\n${link}\n`,
        html: layout('th', title, paras, { href: link, label: 'รับคำเชิญ' }),
      };
    },
    en: ({ link, days, inviterName, role }) => {
      const title = 'Invitation to the TMS Platform Console team';
      const paras = [
        `${inviterName} invited you to the TMS Platform Console team as ${role}.`,
        `Open the link below to set your password and two-factor authentication. The link works once and expires in ${days} days.`,
        'If you do not know the sender, ignore this email.',
      ];
      return {
        subject: `${title} — TMS`,
        text: `${title}\n\n${paras.join('\n\n')}\n\n${link}\n`,
        html: layout('en', title, paras, { href: link, label: 'Accept invitation' }),
      };
    },
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
  two_factor_reset: {
    th: (v) => {
      const title = 'ยืนยันตัวตน 2 ชั้น (2FA) ของคุณถูกรีเซ็ต';
      const who = v.byStaff ? `${v.actorName} จากทีมงาน TMS` : v.actorName;
      const paras = [
        `${who} รีเซ็ตการยืนยันตัวตน 2 ชั้น (2FA) ของบัญชีคุณใน ${v.tenantName} เมื่อ ${v.at}`,
        `เหตุผล: ${v.reason}`,
        'แอปยืนยันตัวตนและรหัสสำรองเดิมใช้ไม่ได้แล้ว และทุกอุปกรณ์ถูกออกจากระบบ',
        v.mustEnroll
          ? 'เข้าสู่ระบบครั้งถัดไป ระบบจะให้ตั้ง 2FA ใหม่ก่อนใช้งาน'
          : 'ตอนนี้บัญชีของคุณไม่มี 2FA เข้าสู่ระบบด้วยรหัสผ่านได้ตามปกติ',
        'ถ้าคุณไม่ได้ขอ กรุณาแจ้งผู้ดูแลระบบของบริษัททันที',
      ];
      return {
        subject: `${title} — TMS`,
        text: `${title}\n\n${paras.join('\n\n')}\n`,
        html: layout('th', title, paras),
      };
    },
    en: (v) => {
      const title = 'Your two-factor authentication (2FA) was reset';
      const who = v.byStaff ? `${v.actorName} from the TMS team` : v.actorName;
      const paras = [
        `${who} reset two-factor authentication (2FA) for your account in ${v.tenantName} at ${v.at}.`,
        `Reason: ${v.reason}`,
        'Your old authenticator app and backup codes no longer work, and every device has been signed out.',
        v.mustEnroll
          ? 'The next time you sign in, you will be asked to set up 2FA again before continuing.'
          : 'Your account no longer has 2FA. You can sign in with your password as usual.',
        'If you did not ask for this, contact your company administrator immediately.',
      ];
      return {
        subject: `${title} — TMS`,
        text: `${title}\n\n${paras.join('\n\n')}\n`,
        html: layout('en', title, paras),
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
