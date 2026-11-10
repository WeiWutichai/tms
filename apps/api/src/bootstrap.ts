import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule, type OpenAPIObject } from '@nestjs/swagger';
import cookieParser from 'cookie-parser';
import { isSignedUploadRequest } from './modules/documents/signed-url';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { Public } from './common/decorators';
import { createValidationPipe } from './common/validation';

export function buildOpenApi(app: NestExpressApplication): OpenAPIObject {
  const config = new DocumentBuilder()
    .setTitle('TMS API')
    .setDescription(
      'Open API ชุดเดียวกับที่ UI ใช้ (docs/01 §5) — error เป็น application/problem+json',
    )
    .setVersion('v1')
    .addBearerAuth()
    .build();
  return SwaggerModule.createDocument(app, config, {
    operationIdFactory: (controllerKey, methodKey) =>
      `${controllerKey.replace(/Controller$/, '')}_${methodKey}`,
  });
}

/** สร้างแอป (ใช้ร่วมกันระหว่าง main.ts และ test) */
/** @param module สำหรับ test ที่ต้องเพิ่ม controller ชั่วคราว (ค่าเริ่ม = AppModule) */
export async function createApp(module: unknown = AppModule): Promise<NestExpressApplication> {
  const app = await NestFactory.create<NestExpressApplication>(module as typeof AppModule, {
    logger: process.env.NODE_ENV === 'test' ? ['error', 'warn'] : undefined,
  });
  app.disable('x-powered-by');
  app.set('trust proxy', 1);
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
