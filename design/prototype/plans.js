/* TMS — single source of plan data (sample prices/quotas, not final). Used by TMS v4, TMS Signup, TMS Platform Console. */
(function () {
  if (window.TMSPLANS) return;
  const U = -1; // unlimited
  const plans = [
    { k: 'start', name: 'เริ่มต้น', en: 'Starter', zh: '入门版', price: 390, veh: 20, users: U, conn: 0, connL: 'export ไฟล์', api: 0, webhook: 0, cf: 5, ai: 200, pod: 20, trial: '30 วัน ไม่ใช้บัตร', version: 'v3 · 1 ต.ค. 2569', web: true,
      blurb: 'สำหรับบริษัทขนส่งที่เริ่มเปลี่ยนจาก Excel', mods: 'SO/DO, วางแผน, แอปคนขับ + POD, วางบิล/ใบแจ้งหนี้/รับชำระ' },
    { k: 'std', name: 'มาตรฐาน', en: 'Standard', zh: '标准版', price: 690, veh: 80, users: U, conn: 1, connL: '1 ตัว', api: 300, webhook: 3, cf: 20, ai: 1000, pod: 100, trial: '30 วัน ไม่ใช้บัตร', popular: true, version: 'v3 · 1 ต.ค. 2569', web: true,
      blurb: 'มีรถร่วม ติดตามรถ และเชื่อมโปรแกรมบัญชี', mods: '+ รถร่วม + Settlement, ติดตามรถ, รายงาน, fleet พื้นฐาน' },
    { k: 'ent', name: 'องค์กร', en: 'Enterprise', zh: '企业版', price: null, veh: U, users: U, conn: U, connL: 'ไม่จำกัด', api: 1000, webhook: U, cf: U, ai: null, pod: null, trial: 'demo', version: 'v2 · 1 ก.ค. 2569', web: true,
      blurb: 'หลายนิติบุคคล fleet เต็ม และ customer portal', mods: '+ fleet เต็ม (ยาง อะไหล่ ถังน้ำมัน), หลายนิติบุคคล, customer portal' }
  ];
  // feature matrix: [category, label, key, start, std, ent]; value: true | false | 'add' | number | string
  const features = [
    ['ปฏิบัติการ', 'ใบสั่งขนส่ง (SO) / ใบส่งของ (DO)', 'so', true, true, true],
    ['ปฏิบัติการ', 'กระดานวางแผน', 'plan', true, true, true],
    ['ปฏิบัติการ', 'แอปคนขับ + POD', 'driver', true, true, true],
    ['ปฏิบัติการ', 'เที่ยวรถ / ใบคุมรถ', 'trips', true, true, true],
    ['ปฏิบัติการ', 'จ่ายงานรถร่วม', 'sub', false, true, true],
    ['ปฏิบัติการ', 'ติดตามรถ (GPS)', 'track', false, true, true],
    ['ปฏิบัติการ', 'ศูนย์ข้อยกเว้น', 'exc', false, true, true],
    ['บัญชี', 'วางบิล / ใบแจ้งหนี้ / รับชำระ', 'bill', true, true, true],
    ['บัญชี', 'Settlement รถร่วม', 'settle', false, true, true],
    ['บัญชี', 'เงินเบิกคนขับ', 'adv', true, true, true],
    ['บัญชี', 'เชื่อมโปรแกรมบัญชี (connector)', 'conn', 'export ไฟล์', 1, 'ไม่จำกัด'],
    ['บัญชี', 'หลายนิติบุคคล', 'multi', false, false, true],
    ['Fleet', 'ทะเบียนรถ เอกสารรถ ใบสั่งซ่อม', 'fleet', false, true, true],
    ['Fleet', 'ยาง อะไหล่ ถังน้ำมัน', 'fleetx', false, 'add', true],
    ['รายงานและลูกค้า', 'รายงาน', 'report', false, true, true],
    ['รายงานและลูกค้า', 'Customer portal', 'portal', false, 'add', true],
    ['รายงานและลูกค้า', 'แจ้งลูกค้าปลายทาง SMS / LINE (ข้อความ/เดือน)', 'sms', 200, 1000, 'ตกลง'],
    ['เชื่อมต่อ', 'Open API + MCP (req/นาที)', 'api', false, 300, 1000],
    ['เชื่อมต่อ', 'Webhook (endpoint)', 'webhook', false, 3, 'ไม่จำกัด'],
    ['เชื่อมต่อ', 'ฟิลด์เพิ่มเติม (ต่อ entity)', 'cf', 5, 20, 'ไม่จำกัด'],
    ['โควตา', 'รถ active / เดือน', 'veh', 20, 80, 'ไม่จำกัด'],
    ['โควตา', 'ผู้ใช้', 'users', 'ไม่จำกัด', 'ไม่จำกัด', 'ไม่จำกัด'],
    ['โควตา', 'AI credit / เดือน', 'ai', 200, 1000, 'ตกลง'],
    ['โควตา', 'พื้นที่รูป POD', 'podgb', '20 GB', '100 GB', 'ตกลง']
  ];
  const addons = [
    { k: 'veh', name: 'รถเกินโควตา', unit: 'ต่อคัน / เดือน', price: 450, used: 6 },
    { k: 'conn', name: 'Connector บัญชีเพิ่ม', unit: 'ต่อตัว / เดือน', price: 990, used: 4 },
    { k: 'sms', name: 'SMS / LINE แจ้งลูกค้าเกินโควตา', unit: 'ต่อ 1,000 ข้อความ', price: 350, used: 11 },
    { k: 'ai', name: 'AI credit เพิ่ม', unit: 'ต่อ 1,000 credit', price: 500, used: 7 },
    { k: 'onb', name: 'Onboarding มีคนช่วย', unit: 'ครั้งเดียว', price: 15000, used: 9 },
    { k: 'fleetx', name: 'Fleet เต็ม (ยาง อะไหล่ ถังน้ำมัน)', unit: 'ต่อรถ / เดือน', price: 120, used: 3 }
  ];
  const rules = ['ไม่ผูกสัญญายาว ไม่มีค่าปรับ', 'ไม่ล็อก POD และวางบิลไว้ที่แพ็กเกจสูง', 'คิดเงินตามรถ active ที่วิ่งจริงในเดือน (รถบริษัท + รถร่วม)', 'รายปีลด 2 เดือน (จ่าย 10 เดือน ใช้ 12 เดือน)'];
  const statuses = { 'รอยืนยัน': ['off', 'hourglass'], 'ทดลองใช้': ['info', 'flask-conical'], 'ใช้งาน': ['ok', 'circle-check'], 'ค้างชำระ': ['warn', 'circle-alert'], 'อ่านอย่างเดียว': ['warn', 'eye'], 'ระงับ': ['err', 'ban'], 'ยกเลิก': ['off', 'circle-x'] };
  const tone = { ok: ['#17733F', '#E7F3EC'], info: ['#2257C4', '#E9F0FA'], warn: ['#8F5500', '#FCF0DC'], err: ['#B3322A', '#FBE9E7'], off: ['#59606B', '#EEF0EC'] };
  const fmt = n => Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const num = n => Number(n).toLocaleString('en-US');
  const lim = v => v === U ? 'ไม่จำกัด' : v == null ? 'ตกลง' : num(v);
  const KEY = 'tms.plans.v1', base = plans.map(x => ({ k: x.k, price: x.price, version: x.version })), feat0 = features.map(f => f.slice());
  let ov = null; try { ov = JSON.parse(localStorage.getItem(KEY) || 'null'); } catch (e) {}
  const applyOv = o => { plans.forEach((x, i) => { const b = base[i], q = o && o.plans && o.plans.find(y => y.k === x.k); x.price = q ? q.price : b.price; x.version = q ? q.version : b.version; x.prev = q && q.prevPrice !== undefined ? { price: q.prevPrice, version: q.prevVersion } : null; }); features.forEach((f, i) => { const g = o && o.feats && o.feats[i]; for (let j = 3; j < 6; j++) f[j] = g ? g[j] : feat0[i][j]; }); };
  applyOv(ov);
  window.addEventListener('storage', e => { if (e.key === KEY) { try { ov = JSON.parse(e.newValue || 'null'); } catch (x) { ov = null; } applyOv(ov); window.dispatchEvent(new Event('tmsplans')); } });
  window.TMSPLANS = {
    plans, features, addons, rules, statuses, U, fmt, num, lim, yearlyMonths: 10, retainDays: 90,
    get: k => plans.find(p => p.k === k),
    override: () => ov,
    keepOld: () => !!(ov && ov.mv === 'keep'),
    // price a tenant actually pays: existing tenants keep their old version when the owner chose "keep"
    priceFor: (k, existing) => { const x = plans.find(p => p.k === k); if (!x) return null; return existing && ov && ov.mv === 'keep' && x.prev ? { price: x.prev.price, version: x.prev.version, kept: true, newPrice: x.price, newVersion: x.version } : { price: x.price, version: x.version, kept: false }; },
    publish: (draftPlans, draftFeats, mv, verL) => { const o = { at: Date.now(), mv, ver: verL, plans: plans.map((x, i) => { const d = draftPlans[i] || {}; const fch = !!draftFeats && features.some((f, fi) => String(f[3 + i]) !== String(draftFeats[fi][3 + i])), changed = d.price !== x.price; return { k: x.k, price: d.price, version: changed || fch ? verL : x.version, prevPrice: changed ? x.price : (x.prev ? x.prev.price : undefined), prevVersion: changed ? x.version : (x.prev ? x.prev.version : undefined) }; }), feats: draftFeats || null }; ov = o; try { localStorage.setItem(KEY, JSON.stringify(o)); } catch (e) {} applyOv(o); window.dispatchEvent(new Event('tmsplans')); return o; },
    resetDemo: () => { ov = null; try { localStorage.removeItem(KEY); } catch (e) {} applyOv(null); window.dispatchEvent(new Event('tmsplans')); },
    has: (planK, feat) => { const i = plans.findIndex(p => p.k === planK), f = features.find(x => x[2] === feat); if (!f || i < 0) return true; const v = f[3 + i]; return v === true || typeof v === 'number' || (typeof v === 'string' && v !== 'export ไฟล์' && v !== 'add'); },
    cell: (planK, feat) => { const i = plans.findIndex(p => p.k === planK), f = features.find(x => x[2] === feat); return f ? f[3 + i] : null; },
    priceL: (p, yearly) => p.price == null ? 'ติดต่อฝ่ายขาย' : '฿' + num(yearly ? Math.round(p.price * 10 / 12) : p.price),
    calc: (p, n, yearly) => { if (p.price == null) return null; const over = p.veh === U ? 0 : Math.max(0, n - p.veh), base = Math.min(n, p.veh === U ? n : p.veh) * p.price, ex = over * addons[0].price, m = base + ex; return { base, over, ex, month: yearly ? m * 10 / 12 : m, year: yearly ? m * 10 : m * 12 }; },
    badge: l => { const t = tone[(statuses[l] || ['off'])[0]]; return { l, c: t[0], bg: t[1], i: (statuses[l] || ['', 'circle'])[1] }; }
  };
})();
