import type { NestExpressApplication } from '@nestjs/platform-express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { api, bootApp } from './helpers';

describe('OpenAPI (ST0-T09)', () => {
  let app: NestExpressApplication;
  beforeAll(async () => {
    app = await bootApp();
  });
  afterAll(() => app.close());

  it('GET /v1/openapi.json เปิดได้โดยไม่ต้อง login และมี endpoint ตัวอย่าง', async () => {
    const res = await api(app).get('/v1/openapi.json');
    expect(res.status).toBe(200);
    expect(res.body.openapi).toMatch(/^3\./);
    expect(Object.keys(res.body.paths)).toEqual(
      expect.arrayContaining([
        '/v1/companies',
        '/v1/companies/{id}',
        '/v1/jobs/{id}',
        '/v1/health',
        '/v1/me',
      ]),
    );
    expect(res.body.components.schemas.CompanyDto.properties).toHaveProperty('legalName');
  });
});
