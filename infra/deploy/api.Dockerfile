# syntax=docker/dockerfile:1.7
# ST0-T03 — image ของ API + worker + งาน migrate (โค้ดชุดเดียวกัน — plan/02 T-01)
# build จากราก repo:  docker build -f infra/deploy/api.Dockerfile --target runtime -t tms/api:<tag> .
#                     docker build -f infra/deploy/api.Dockerfile --target migrate -t tms/migrate:<tag> .
# (ใช้ scripts/build-images.sh — ตั้ง tag = git sha ให้เอง)
#
# target:
#   runtime  — `node dist/main.js` (API) หรือ `node dist/worker.js` (worker) · มี Chromium headless สำหรับ PDF (playwright-core)
#   migrate  — `prisma migrate deploy && node dist/cli/bootstrap-tenants.js` (= db:migrate:prod) เท่านั้น
#              **ไม่มี** migrate dev / reset / seed ใน entrypoint (CLAUDE.md)
#
# P1-ST6-T07: Node 22 LTS ตาม .nvmrc และ GitHub CI — เปลี่ยนรุ่นต้องแก้พร้อมกันทั้ง .nvmrc / CI / ARG นี้ / web.Dockerfile
#   image ที่ build ถูกสแกน CVE (critical) ใน `pnpm ci:local` — scripts/scan-images.sh
ARG NODE_IMAGE=node:22-bookworm-slim

# ---------- build: ติดตั้ง dependency ทั้งชุด + compile ----------
FROM ${NODE_IMAGE} AS build
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=1 PRISMA_HIDE_UPDATE_MESSAGE=1
# openssl: Prisma เลือก query engine ตามรุ่น libssl (ไม่มี = ตกไปใช้ 1.1 แล้วโหลดไม่ขึ้น)
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/* \
 && corepack enable
WORKDIR /repo
# ชั้น dependency แยกจากซอร์ส (cache ได้เมื่อแก้แค่โค้ด)
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/
COPY packages/domain/package.json packages/domain/
COPY packages/contracts/package.json packages/contracts/
COPY packages/sdk/package.json packages/sdk/
COPY packages/api-docs/package.json packages/api-docs/
COPY packages/mock-krs/package.json packages/mock-krs/
COPY packages/mock-accountsystem/package.json packages/mock-accountsystem/
COPY apps/api/prisma/schema.prisma apps/api/prisma/
RUN --mount=type=cache,id=tms-pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --filter "@tms/api..."
COPY tsconfig.base.json ./
COPY packages/domain packages/domain
COPY packages/contracts packages/contracts
COPY apps/api apps/api
RUN pnpm --filter @tms/domain build \
 && pnpm --filter @tms/contracts build \
 && pnpm --filter @tms/api exec prisma generate \
 && pnpm --filter @tms/api build
# ชุด production: dependency เฉพาะ runtime (ไม่มี devDependencies) → /out
RUN --mount=type=cache,id=tms-pnpm,target=/pnpm/store \
    pnpm deploy --legacy --filter @tms/api --prod /out \
 && rm -rf /out/src /out/test /out/scripts /out/dist \
 && cp -r apps/api/dist /out/dist \
 && rm -rf /out/prisma && cp -r apps/api/prisma /out/prisma && rm -f /out/prisma/seed.ts && rm -rf /out/prisma/seed \
 && cd /out && node /repo/apps/api/node_modules/prisma/build/index.js generate --schema prisma/schema.prisma

# ---------- migrate: มี prisma CLI (devDependency) — ใช้รัน migration เท่านั้น ----------
FROM build AS migrate
# P1-ST6-T07 (สแกน CVE): ลบเครื่องมือ build ที่ migrate ไม่ใช้ — pnpm ที่ corepack เก็บไว้ (tar รุ่นมี CVE critical) และ esbuild
#   (Go stdlib รุ่นมี CVE critical; มาจาก vite/vitest ซึ่ง migrate ไม่เรียก) · [DECISION — lead 27 พ.ย. 2569, ย้อนได้] ตัดทิ้งแทนการปรับ
#   stage migrate ใหม่ทั้งหมด — ทางที่ถาวรกว่า: stage migrate แบบบางที่มีแค่ dependency production + prisma CLI (งานต่อ)
RUN rm -rf /root/.cache/node/corepack /repo/node_modules/.pnpm/esbuild@* /repo/node_modules/.pnpm/@esbuild+*
WORKDIR /repo/apps/api
ENV NODE_ENV=production
USER node
# DATABASE_URL = owner (เจ้าของตาราง) · PLATFORM_DATABASE_URL = role BYPASSRLS ฐานเดียวกัน (bootstrap-tenants ตรวจเอง)
CMD ["sh", "-c", "node node_modules/prisma/build/index.js migrate deploy && node dist/cli/bootstrap-tenants.js"]

# ---------- runtime: API / worker ----------
FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    FILES_ROOT=/data/files \
    API_PORT=4410
WORKDIR /app
# Chromium headless + font/lib ที่ต้องใช้ — render PDF (ST3-T20) · ติดตั้ง**ก่อน** COPY โค้ด → layer นี้ใช้ cache ได้เมื่อแก้แค่โค้ด
# (P1-ST6-T07 review S2) · รุ่นตรึงตาม playwright-core ใน pnpm-lock.yaml — scripts/deploy/build-images.sh / scan-images.sh ส่ง ARG ให้
# และขั้นหลัง COPY ตรวจซ้ำว่าตรงกับ /app/node_modules (lockfile เปลี่ยนแต่ ARG ไม่เปลี่ยน = build แดง)
ARG PLAYWRIGHT_CORE_VERSION=1.65.0
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates \
 && npx --yes "playwright-core@${PLAYWRIGHT_CORE_VERSION}" install --with-deps chromium-headless-shell \
 && rm -rf /var/lib/apt/lists/* /root/.npm \
 && mkdir -p /data/files /app/keys && chown -R node:node /data /app/keys
COPY --from=build /out /app
RUN v="$(node -p "require('/app/node_modules/playwright-core/package.json').version")" \
 && [ "$v" = "$PLAYWRIGHT_CORE_VERSION" ] \
 || { echo "playwright-core ใน lockfile = $v แต่ PLAYWRIGHT_CORE_VERSION = $PLAYWRIGHT_CORE_VERSION — แก้ ARG / ใช้ scripts/deploy/build-images.sh" >&2; exit 1; }
USER node
EXPOSE 4410
# liveness เท่านั้น (readyz ขึ้นกับ worker heartbeat — ไม่ใช้เป็น healthcheck ของ container)
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=4 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.API_PORT||4410)+'/v1/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/main.js"]
