import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule, type OpenAPIObject } from '@nestjs/swagger';
import cookieParser from 'cookie-parser';
import { isSignedUploadRequest } from './modules/documents/signed-url';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { Public } from './common/decorators';
import { describeExternalIdParams } from './common/external-id';
import { describeRateLimits } from './http/rate-limit/openapi';
import { describeProblemCatalog, describeProblemDefaults } from './http/problem-openapi';
import { describeApiVersioning } from './http/api-version/openapi';
import { describeWebhookEvents } from './modules/webhooks/event-openapi';
import { createValidationPipe } from './common/validation';
import { Logger } from '@nestjs/common';
import { isLocalEnv } from './auth/tokens';
import { assertSigningKeys } from './auth/signing-keys';
import { assertApiKeyPepper } from './modules/api-keys/key-material';
import { assertNoDevKeys } from './common/crypto';
import { isInboundWebhookRequest } from './modules/erp/inbound-webhook.controller';
import { INBOUND_MAX_BYTES } from './modules/erp/inbound-webhook.service';

export function buildOpenApi(app: NestExpressApplication): OpenAPIObject {
  const config = new DocumentBuilder()
    .setTitle('TMS API')
    .setDescription(
      'Open API ชุดเดียวกับที่ UI ใช้ (docs/01 §5) — error เป็น application/problem+json',
    )
    .setVersion('v1')
    .addBearerAuth()
    .build();
  return describeProblemCatalog(
    describeWebhookEvents(
      describeApiVersioning(
        describeRateLimits(
          describeProblemDefaults(
            describeExternalIdParams(
              SwaggerModule.createDocument(app, config, {
                operationIdFactory: (controllerKey, methodKey) =>
                  `${controllerKey.replace(/Controller$/, '')}_${methodKey}`,
              }),
            ),
          ),
        ),
      ),
    ),
  );
}

/**
 * ค่า `trust proxy` ของ Express จาก env (ST7-T01 QA M) — ไม่ตั้ง: production/staging = 0 (ไม่เชื่อ X-Forwarded-For เลย —
 * ปลอดภัยกว่า: ผู้เรียกปลอม XFF ผ่าน IP allowlist/rate limit ไม่ได้) · dev/test = 1 (vite proxy / Playwright 1 ชั้น)
 * deploy หลัง load balancer ต้องตั้ง TRUST_PROXY เอง (จำนวนชั้น หรือ IP/CIDR ของ proxy)
 */
export function trustProxy(v: string | undefined, local = isLocalEnv()): number | string[] {
  if (!v?.trim()) return local ? 1 : 0;
  if (/^\d+$/.test(v.trim())) return Number(v.trim());
  return v
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);
}

/** สร้างแอป (ใช้ร่วมกันระหว่าง main.ts และ test) */
/** @param module สำหรับ test ที่ต้องเพิ่ม controller ชั่วคราว (ค่าเริ่ม = AppModule) */
export async function createApp(module: unknown = AppModule): Promise<NestExpressApplication> {
  const app = await NestFactory.create<NestExpressApplication>(module as typeof AppModule, {
    logger: process.env.NODE_ENV === 'test' ? ['error', 'warn'] : undefined,
  });
  app.disable('x-powered-by');
  // IP ผู้เรียก (audit, rate limit, IP allowlist ของ API key — ST7-T01) มาจาก X-Forwarded-For ตามจำนวน proxy ที่ไว้ใจ
  // ค่าเริ่ม 1 ชั้น (load balancer ตัวเดียว) · ตั้ง TRUST_PROXY ได้: จำนวนชั้น (`2`) หรือรายการ IP/CIDR ของ proxy
  // (`10.0.0.0/8,loopback`) — ตั้งผิด = ผู้เรียกปลอม X-Forwarded-For เพื่อผ่าน allowlist ได้
  app.set('trust proxy', trustProxy(process.env.TRUST_PROXY));
  if (!isLocalEnv()) {
    if (!process.env.TRUST_PROXY?.trim())
      new Logger('Bootstrap').warn(
        'TRUST_PROXY ไม่ได้ตั้ง → ไม่เชื่อ X-Forwarded-For (IP ผู้เรียก = IP ของ proxy) — หลัง load balancer ให้ตั้ง TRUST_PROXY',
      );
    // ไม่มี pepper / กุญแจเซ็น token = ไม่ยอมเริ่ม (fail closed ตั้งแต่บูต ไม่ใช่ตอนมีคนเรียก — review M2)
    assertApiKeyPepper();
    assertSigningKeys();
    assertNoDevKeys(); // R2-M01 กุญแจเข้ารหัส/blind index ตัวอย่างของ repo
  }
  // Security baseline (ST0-T12): HSTS, CSP (API คืน JSON ล้วน → default-src 'none'), frame deny, referrer
  app.use(
    helmet({
      contentSecurityPolicy: { directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } },
      hsts: { maxAge: 31_536_000, includeSubDomains: true, preload: true },
      frameguard: { action: 'deny' },
      referrerPolicy: { policy: 'no-referrer' },
      crossOriginResourcePolicy: { policy: 'same-site' },
    }),
  );
  app.use(cookieParser());
  // ST1-T08: เนื้อไฟล์อัปโหลดเป็น raw body (สูงสุด 10 MB + เผื่อเล็กน้อย — ตรวจละเอียดใน controller)
  app.useBodyParser('raw', {
    limit: '10mb',
    // อ่าน body เฉพาะเมื่อ URL มีลายเซ็นถูกต้อง — ลายเซ็นผิดไม่ต้องรับไฟล์ 10 MB ไว้ในหน่วยความจำ (review T08 S1)
    type: (req: { url?: string; method?: string }) => isSignedUploadRequest(req),
  });
  // ST7-T22 webhook ขาเข้า: body ดิบ (ตรวจลายเซ็นกับ byte เดิม) ทุก content-type · เกิน 256 KB → 413 ก่อนถึง handler
  app.useBodyParser('raw', {
    limit: INBOUND_MAX_BYTES,
    type: (req: { url?: string; method?: string }) => isInboundWebhookRequest(req),
  });
  app.useBodyParser('json', { limit: '1mb' });
  app.setGlobalPrefix('v1');
  app.useGlobalPipes(createValidationPipe());

  const doc = buildOpenApi(app);
  const http = app.getHttpAdapter();
  http.get('/v1/openapi.json', (_req: any, res: any) => res.json(doc));
  void Public; // openapi.json ลงทะเบียนตรงกับ express จึงไม่ผ่าน guard (เป็น public ตาม docs/01 §5.1)
  await app.init();
  return app;
}
