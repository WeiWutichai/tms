# syntax=docker/dockerfile:1.7
# ST0-T03 — เว็บ (SPA ไฟล์ static จาก vite build) เสิร์ฟด้วย Caddy · /v1 ไม่ผ่าน image นี้ (reverse proxy ส่งไป API เอง)
# build จากราก repo:  docker build -f infra/deploy/web.Dockerfile -t tms/web:<tag> .
# [DECISION — lead 25 พ.ย. 2569, ย้อนได้] Caddy แทน nginx: image เดียวกับ reverse proxy (TLS อัตโนมัติ) — ลดของที่ต้องดูแล
ARG NODE_IMAGE=node:22-bookworm-slim
ARG CADDY_IMAGE=caddy:2.11-alpine

FROM ${NODE_IMAGE} AS build
# P1-ST6-T02/T03 ค่าที่ vite อ่านตอน build (ว่าง = ค่าเริ่ม: help center ที่ /help/, ปุ่มติดต่อทีมงานปิดจนกว่าจะได้ช่องทาง X-04)
ARG VITE_HELP_CENTER_URL=
ARG VITE_SUPPORT_EMAIL=
ARG VITE_SUPPORT_LINE_OA=
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=1
RUN corepack enable
WORKDIR /repo
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/web/package.json apps/web/
COPY packages/domain/package.json packages/domain/
COPY packages/contracts/package.json packages/contracts/
COPY packages/ui/package.json packages/ui/
RUN --mount=type=cache,id=tms-pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --filter "@tms/web..."
COPY tsconfig.base.json ./
COPY packages/domain packages/domain
COPY packages/contracts packages/contracts
COPY packages/ui packages/ui
COPY apps/web apps/web
RUN pnpm --filter @tms/domain build \
 && pnpm --filter @tms/contracts build \
 && pnpm --filter @tms/web build

FROM ${CADDY_IMAGE} AS runtime
COPY infra/deploy/caddy/Caddyfile.web /etc/caddy/Caddyfile
COPY --from=build /repo/apps/web/dist /srv
# P1-ST6-T02 help center (ไฟล์ static ที่ commit ไว้ — สร้างด้วย `pnpm --filter @tms/help-center docs:build`) เสิร์ฟที่ /help/
COPY packages/help-center/site /srv/help
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=3s --retries=4 CMD wget -q -O /dev/null http://127.0.0.1:8080/healthz || exit 1
