import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { checkSite, REQUIRED_FLOWS } from './check';
import { connectorEntries, problemCodes } from './errors';
import { loadInputs, parseArticle, parseProblemMessages, TH_I18N_PATH } from './inputs';
import { buildSite, GROUPS, plainText, SEARCH_FILE } from './site';

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
