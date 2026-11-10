import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule, type OpenAPIObject } from '@nestjs/swagger';
import cookieParser from 'cookie-parser';
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
export async function createApp(): Promise<NestExpressApplication> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
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
