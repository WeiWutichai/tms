// ST0 เท่านั้น: สร้าง token ของ tenant เดโม A ลง apps/web/.env.local (ไม่ commit) — ST1 แทนด้วย login จริง
import { execSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
const api = new URL('../../api', import.meta.url).pathname;
const tok = execSync(
  `set -a && . ../../.env && set +a && SWC_NODE_PROJECT=tsconfig.json node -r @swc-node/register -e "require('./src/auth/auth.guard').signDevToken({sub:'demo-admin',tid:'00000000-0000-4000-8000-00000000000a'},'12h').then(t=>console.log(t))"`,
  { cwd: api, shell: '/bin/bash', encoding: 'utf8' },
).trim();
writeFileSync(new URL('../.env.local', import.meta.url), `VITE_DEV_TOKEN=${tok}\n`);
console.log('wrote apps/web/.env.local (token 12h, tenant DEMO_A)');
