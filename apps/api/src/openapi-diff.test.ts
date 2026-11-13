import { describe, expect, it } from 'vitest';
import { bareObjects, diffOpenApi } from './openapi-diff';

const base = {
  paths: {
    '/v1/companies': {
      post: {
        requestBody: {
          content: { 'application/json': { schema: { $ref: '#/components/schemas/Create' } } },
        },
      },
      get: { parameters: [{ in: 'query', name: 'limit', required: false }] },
    },
  },
  components: {
    schemas: {
      Create: {
        type: 'object',
        properties: { legalName: { type: 'string' } },
        required: ['legalName'],
      },
      Company: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          status: { type: 'string', enum: ['active', 'inactive'] },
        },
      },
    },
  },
};
const clone = () => JSON.parse(JSON.stringify(base));

describe('diffOpenApi', () => {
  it('ฉบับเดิม → ไม่มี breaking', () => expect(diffOpenApi(base, clone())).toEqual([]));

  it('ลบ field จาก response → breaking', () => {
    const h = clone();
    delete h.components.schemas.Company.properties.status;
    expect(diffOpenApi(base, h)).toEqual([
      { where: 'schema Company.status', change: 'property removed' },
    ]);
  });

  it('ลบ endpoint, ลบค่า enum, เพิ่ม required ใน request, parameter กลายเป็นบังคับ → breaking', () => {
    const h = clone();
    delete h.paths['/v1/companies'].get.parameters;
    h.paths['/v1/companies'].get.parameters = [{ in: 'query', name: 'limit', required: true }];
    h.components.schemas.Company.properties.status.enum = ['active'];
    h.components.schemas.Create.properties.taxId = { type: 'string' };
    h.components.schemas.Create.required = ['legalName', 'taxId'];
    const changes = diffOpenApi(base, h).map((c) => c.change);
    expect(changes).toEqual(
      expect.arrayContaining([
        'parameter limit became required',
        'enum values removed: inactive',
        'request fields became required: taxId',
      ]),
    );
    const h2 = clone();
    delete h2.paths['/v1/companies'].post;
    expect(diffOpenApi(base, h2)[0]!.change).toBe('operation removed');
  });

  it('เพิ่ม field/endpoint/ค่า enum → ไม่ breaking', () => {
    const h = clone();
    h.components.schemas.Company.properties.taxId = { type: 'string' };
    h.components.schemas.Company.properties.status.enum.push('archived');
    h.paths['/v1/jobs/{id}'] = { get: {} };
    expect(diffOpenApi(base, h)).toEqual([]);
  });

  it('แก้ชนิด object → string ยอมเฉพาะที่อยู่ในรายการ corrections (ADR T-22) — อย่างอื่นยังเป็น breaking', () => {
    const b = clone();
    b.components.schemas.Create.properties.ref = { type: 'object', nullable: true };
    b.components.schemas.Create.properties.other = { type: 'object', nullable: true };
    b.components.schemas.Create.properties.n = { type: 'number' };
    const h = JSON.parse(JSON.stringify(b));
    h.components.schemas.Create.properties.ref = { type: 'string', nullable: true };
    h.components.schemas.Create.properties.other = { type: 'string', nullable: true };
    h.components.schemas.Create.properties.n = { type: 'string' };
    const corr = [
      { schema: 'Create.ref', from: 'object', to: 'string', adr: 'T-22' },
      // ชนิดอื่นไม่ยอม แม้อยู่ในรายการ
      { schema: 'Create.n', from: 'number', to: 'string', adr: 'T-22' },
    ];
    expect(diffOpenApi(b, h, corr).map((x) => x.where)).toEqual([
      'schema Create.other',
      'schema Create.n',
    ]);
    expect(diffOpenApi(b, h).length).toBe(3);
  });
});

describe('OpenAPI ที่ export (packages/contracts/openapi.json)', () => {
  it('ไม่มี type: object ที่ไม่มี properties/$ref/additionalProperties', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const spec = JSON.parse(
      readFileSync(resolve(__dirname, '../../../packages/contracts/openapi.json'), 'utf8'),
    );
    expect(bareObjects({ components: { schemas: { X: { type: 'object' } } } })).toEqual(['X']);
    expect(bareObjects(spec)).toEqual([]);
  });
});
