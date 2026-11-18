/**
 * แปลงบล็อก ```bash ของหน้า quickstart เป็นขั้นตอน HTTP — ใช้ใน test ที่รัน quickstart จริง (เกณฑ์ตรวจรับ ST7-T12)
 * รูปแบบที่รองรับ (ตามที่ guides/01-quickstart.md เขียน):
 *   [VAR=$(]curl -sS [-X METHOD] "URL" -H "K: V" … [-d '<json>'] [| jq -r .path)]
 *   VAR=value   (กำหนดตัวแปรธรรมดา) · VAR=$(… date …) = วันพรุ่งนี้ตามเวลาไทย (YYYY-MM-DD)
 * บรรทัด `set`/`export`/`echo` ข้าม (ตัวแปร TMS_BASE_URL / TMS_API_KEY ผู้เรียกใส่เอง)
 * jq: `jq -r PATH` / `jq -er PATH` (PATH อาจอยู่ใน '…' เช่น '.data[0].id')
 */
export interface QuickstartOptions {
  /** เวลาปัจจุบัน (ใช้คำนวณ `date` พรุ่งนี้) */
  now?: Date;
}

/** วันพรุ่งนี้ตามเวลาไทย (UTC+7 ไม่มี DST) */
export function bangkokTomorrow(now = new Date()): string {
  return new Date(now.getTime() + 31 * 3600_000).toISOString().slice(0, 10);
}
export interface CurlStep {
  method: string;
  url: string;
  headers: [string, string][];
  /** body หลังต่อสตริงแบบ shell ('…'"$VAR"'…' → …$VAR…) */
  body?: string;
  capture?: { variable: string; path: string };
}

/** แยก token แบบ shell อย่างง่าย: '…' ไม่แปลง, "…" คงตัวแปรไว้, ต่อกันได้ */
function shellWords(cmd: string): string[] {
  const out: string[] = [];
  let cur = '';
  let has = false;
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i]!;
    if (c === "'") {
      const j = cmd.indexOf("'", i + 1);
      cur += cmd.slice(i + 1, j);
      i = j;
      has = true;
    } else if (c === '"') {
      let j = i + 1;
      while (cmd[j] !== '"') j += cmd[j] === '\\' ? 2 : 1;
      cur += cmd
        .slice(i + 1, j)
        .replace(/\$([A-Z_][A-Z0-9_]*)/g, '${$1}')
        .replace(/\\(["\\$])/g, '$1');
      i = j;
      has = true;
    } else if (/\s/.test(c)) {
      if (has) out.push(cur);
      cur = '';
      has = false;
    } else {
      cur += c;
      has = true;
    }
  }
  if (has) out.push(cur);
  return out;
}

export function parseQuickstartCurl(md: string, opts: QuickstartOptions = {}): CurlStep[] {
  const steps: CurlStep[] = [];
  const blocks = [...md.matchAll(/```bash\n([\s\S]*?)```/g)].map((m) => m[1]!);
  const assigns: Record<string, string> = {};
  for (const block of blocks) {
    const joined = block.replace(/\\\n\s*/g, ' ');
    for (const rawLine of joined.split('\n')) {
      const line = rawLine.replace(/\s+#.*$/, '').trim();
      if (!line || /^(export|echo|set) /.test(line)) continue;
      const date = /^([A-Z_][A-Z0-9_]*)=\$\((TZ=\S+ )?date .*\)$/.exec(line);
      if (date) {
        assigns[date[1]!] = bangkokTomorrow(opts.now);
        continue;
      }
      const m = /^([A-Z_][A-Z0-9_]*)=\$\((curl .*)\|\s*jq -e?r '?(\.[\w.[\]]*)'?\)$/.exec(line);
      const plain = /^([A-Z_][A-Z0-9_]*)=(\S+)$/.exec(line);
      if (plain && !m) {
        assigns[plain[1]!] = plain[2]!;
        continue;
      }
      const cmd = m ? m[2]! : line;
      if (!cmd.startsWith('curl ')) throw new Error(`บรรทัดที่ไม่รองรับใน quickstart: ${line}`);
      const w = shellWords(cmd).slice(1);
      const st: CurlStep = { method: 'GET', url: '', headers: [] };
      for (let i = 0; i < w.length; i++) {
        const a = w[i]!;
        if (a === '-X') st.method = w[++i]!;
        else if (a === '-H') {
          const h = w[++i]!;
          const k = h.indexOf(':');
          st.headers.push([h.slice(0, k).trim(), h.slice(k + 1).trim()]);
        } else if (a === '-d' || a === '--data') {
          st.body = w[++i]!;
          if (st.method === 'GET') st.method = 'POST';
        } else if (a.startsWith('-')) continue;
        else st.url = a;
      }
      if (m) st.capture = { variable: m[1]!, path: m[3]! };
      // ตัวแปรธรรมดาที่กำหนดไว้ก่อนหน้า (เช่น PICKUP_DATE) แทนค่าเลย
      const subst = (s: string) =>
        s.replace(/\$\{?([A-Z_][A-Z0-9_]*)\}?/g, (all, n: string) => assigns[n] ?? all);
      st.url = subst(st.url);
      if (st.body !== undefined) st.body = subst(st.body);
      st.headers = st.headers.map(([k, v]) => [k, subst(v)]);
      steps.push(st);
    }
  }
  return steps;
}
