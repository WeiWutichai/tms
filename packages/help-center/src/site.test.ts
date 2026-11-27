import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { checkSite, REQUIRED_FLOWS } from './check';
import { connectorEntries, problemCodes } from './errors';
import { loadInputs, parseArticle, parseProblemMessages, TH_I18N_PATH } from './inputs';
import { buildSite, CONTACT_SLUG, GROUPS, plainText, SEARCH_FILE, SEARCH_JS_FILE } from './site';

const { articles, doc, problemMessages } = loadInputs();
const files = buildSite(articles, doc, problemMessages);
const problems = problemCodes(doc, problemMessages);
const connectors = connectorEntries();

describe('help center (P1-ST6-T01)', () => {
  it('ทุก flow ในแถว backlog มีบทความ และทุกบทความอยู่ในหมวดที่รู้จัก', () => {
    for (const slug of Object.values(REQUIRED_FLOWS)) expect(files.has(`${slug}.html`)).toBe(true);
    for (const a of articles) expect(GROUPS as readonly string[]).toContain(a.group);
  });

  it('flow ที่ยังไม่มีในระบบเป็นบทความ "เร็ว ๆ นี้" ไม่ใช่ขั้นตอนใช้งาน', () => {
    const soon = articles.filter((a) => a.status === 'soon').map((a) => a.slug);
    expect(soon.sort()).toEqual(['connect-flowaccount-peak', 'plans-billing', 'signup-trial']);
    expect(files.get('signup-trial.html')).toContain('เร็ว ๆ นี้');
    // ไม่มีขั้นตอนใช้งาน (รายการลำดับเลข) สำหรับ UI ที่ยังไม่มี
    for (const a of articles.filter((x) => x.status === 'soon')) {
      expect(a.md, a.slug).not.toMatch(/^\s*\d+\.\s/m);
      expect(files.get(`${a.slug}.html`), a.slug).not.toContain('<ol>');
    }
  });

  it('ทุก code ใน x-problem-codes และในตัวอย่าง problem+json มีหัวข้อใน catalog', () => {
    const all = new Set(Object.keys(doc['x-problem-codes']));
    expect(all.size).toBeGreaterThan(100);
    const html = files.get('errors.html')!;
    for (const c of all) expect(html).toContain(`id="${c}"`);
    expect(problems.length).toBeGreaterThanOrEqual(all.size);
  });

  it('ข้อความใน catalog = ข้อความบนหน้าจอ (th.ts problem.<code>) ถ้ามี ไม่งั้น title ของ API', () => {
    const msgs = parseProblemMessages(readFileSync(TH_I18N_PATH, 'utf8'));
    expect(msgs.bank_change_requires_user).toMatch(/^แก้หรือดูบัญชีธนาคาร/); // ข้อความ 2 บรรทัดใน th.ts
    const e = problems.find((p) => p.code === 'import_expired');
    if (e && msgs.import_expired) expect(e.message).toBe(msgs.import_expired);
    const nf = problems.find((p) => p.code === 'not_found')!;
    expect(nf.message).toBe(msgs.not_found ?? doc['x-problem-codes'].not_found.title);
  });

  it('error ของ connector มาจากคู่มือชุดเดียวกับคิวการส่งเอกสาร', () => {
    const html = files.get('connector-errors.html')!;
    for (const c of connectors) expect(html).toContain(`id="${c.key}"`);
    expect(connectors.map((c) => c.key)).toContain('PERIOD_CLOSED');
  });

  it('ลิงก์/anchor ภายในไม่ขาด (ไม่นับภาพ)', () => {
    const all = checkSite(files, new Set(), problems, connectors);
    expect(all.filter((p) => !p.includes('ไม่มีภาพ'))).toEqual([]);
  });

  it('ตรวจจับลิงก์เสีย ภาพที่ขาด และภาพที่ไม่มีใครใช้', () => {
    const f = new Map(files);
    f.set(
      'x.html',
      '<a href="nope.html">a</a><a href="errors.html#no_such">b</a><img src="images/a.png">',
    );
    const out = checkSite(f, new Set(['orphan.png']), problems, connectors);
    expect(out).toContain('x.html: ลิงก์เสีย → nope.html');
    expect(out).toContain('x.html: ไม่มีหัวข้อ #no_such ใน errors.html');
    expect(out.some((p) => p.startsWith('x.html: ไม่มีภาพ images/a.png'))).toBe(true);
    expect(out.some((p) => p.includes('orphan.png'))).toBe(true);
  });

  it('ดัชนีค้นหามีทุกบทความและทุกรหัส error', () => {
    const js = files.get(SEARCH_FILE)!;
    const idx = JSON.parse(js.replace(/^window\.HELP_INDEX=/, '').replace(/;\n$/, '')) as {
      u: string;
    }[];
    for (const a of articles) expect(idx.some((d) => d.u === `${a.slug}.html`)).toBe(true);
    for (const p of problems) expect(idx.some((d) => d.u === `errors.html#${p.code}`)).toBe(true);
    expect(files.get('index.html')).toContain(`<script src="${SEARCH_FILE}"></script>`);
  });

  it('P1-ST6-T02: ไม่มี inline script (เสิร์ฟใต้ /help/ ของเว็บที่ CSP script-src self) · ทุกหน้ามีลิงก์ติดต่อทีมงาน (P1-ST6-T03)', () => {
    expect(files.has(SEARCH_JS_FILE)).toBe(true);
    expect(files.has(`${CONTACT_SLUG}.html`)).toBe(true);
    for (const [name, body] of files)
      if (name.endsWith('.html')) {
        expect(body, name).not.toMatch(/<script>/);
        expect(body, name).toContain(`<script src="${SEARCH_JS_FILE}"></script>`);
        expect(body, name).toContain(`href="${CONTACT_SLUG}.html">ติดต่อทีมงาน</a>`);
      }
  });

  it('P1-ST6-T02: `type` ของ problem+json ทุกตัวใน openapi.json = https://docs.tms.example/problems/<code> ของตัวเอง และ code นั้นมีหัวข้อใน catalog', () => {
    const anchors = new Set(problems.map((p) => p.code));
    const bad: string[] = [];
    let n = 0;
    const walk = (o: unknown): void => {
      if (Array.isArray(o)) return o.forEach(walk);
      if (!o || typeof o !== 'object') return;
      const v = o as Record<string, unknown>;
      if (typeof v.code === 'string' && typeof v.type === 'string' && /^https?:/.test(v.type)) {
        n++;
        if (v.type !== `https://docs.tms.example/problems/${v.code}`)
          bad.push(`${v.code} → ${v.type}`);
        if (!anchors.has(v.code)) bad.push(`${v.code} ไม่มีหัวข้อใน errors.html`);
      }
      Object.values(v).forEach(walk);
    };
    walk(doc);
    expect(n).toBeGreaterThan(100);
    expect(bad).toEqual([]);
  });

  it('front matter ผิด = error ชัด · plainText ตัด markdown', () => {
    expect(() => parseArticle('01-x.md', '# no meta')).toThrow(/front matter/);
    expect(() => parseArticle('01-x.md', '---\ntitle: a\ngroup: b\n---\n')).toThrow(/summary/);
    expect(plainText('## หัว {#h}\n![ภาพ](images/a.png) [ลิงก์](a.md) `code`')).toBe(
      'หัว ลิงก์ code',
    );
  });

  it('deterministic — สร้างซ้ำได้ผลเดิม', () => {
    const again = buildSite(articles, doc, problemMessages);
    expect([...again.entries()]).toEqual([...files.entries()]);
  });
});
