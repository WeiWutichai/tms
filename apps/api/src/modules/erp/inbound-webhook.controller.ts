import { Controller, HttpCode, Param, Post, Req, Res } from '@nestjs/common';
import {
  ApiBody,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiPayloadTooLargeResponse,
  ApiTags,
  ApiTooManyRequestsResponse,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { Public } from '../../common/decorators';
import { requestContext } from '../../common/request-context';
import { InboundReceiptDto } from './connector.dto';
import { INBOUND_MAX_BYTES, InboundWebhookService } from './inbound-webhook.service';

/** path ของ webhook ขาเข้า — body parser อ่านเป็น raw (ไม่แปลง JSON) เพื่อให้ตรวจลายเซ็นกับ byte เดิมได้ */
// ไม่แยกตัวพิมพ์ (router ของ Express ไม่แยก — `/V1/Inbound/…` ต้องได้ raw + เพดาน 256 KB เหมือนกัน)
export const INBOUND_PATH_RE = /^\/v1\/inbound\/[^/?#]+\/[^/?#]+\/?(?:[?#].*)?$/i;

/** ใช้กับ body parser แบบ raw ใน bootstrap */
export function isInboundWebhookRequest(req: { url?: string; method?: string }): boolean {
  return req.method === 'POST' && INBOUND_PATH_RE.test(req.url ?? '');
}

function headersOf(req: Request): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (v === undefined) continue;
    out[k.toLowerCase()] = Array.isArray(v) ? v.join(', ') : String(v);
  }
  return out;
}

/**
 * Webhook ขาเข้าจากระบบบัญชี/ERP (ST7-T22; docs/04 G3 "Inbound webhook ledger" I10)
 * ไม่ login — URL มี token ต่อ connector (ออก/หมุนที่ `POST /connectors/{id}/inbound-token/rotate`) + ลายเซ็นของผู้ให้บริการ
 */
@ApiTags('inbound')
@Controller('inbound')
export class InboundWebhookController {
  constructor(private readonly inbound: InboundWebhookService) {}

  @Post(':provider/:token')
  @Public()
  @HttpCode(200)
  @ApiParam({
    name: 'provider',
    type: String,
    description: '`adapterKey` ของ connector เช่น `demo`',
  })
  @ApiParam({ name: 'token', type: String, description: 'token ของ connector (`whin_…`)' })
  @ApiOperation({
    summary: 'รับ webhook ขาเข้าจากระบบบัญชี/ERP ที่เชื่อมไว้',
    description:
      'ตรวจ token ใน URL + ลายเซ็นของผู้ให้บริการ (ตามรูปแบบของ adapter) **ก่อน** บันทึก · event เดิม (provider + รหัส event) ' +
      'ส่งซ้ำ/พร้อมกันได้ — บันทึกและประมวลผลครั้งเดียว (`duplicate: true`) · ประมวลผลแบบ async ใน worker · ' +
      `body ≤ ${INBOUND_MAX_BYTES / 1024} KB · token ผิด/หมุนแล้ว/ลายเซ็นผิด = 401 รูปเดียวกัน · ` +
      'rate limit ต่อ IP และต่อ token (หน้าต่าง 1 นาที)',
  })
  @ApiBody({
    required: true,
    description: 'body ตามรูปแบบของผู้ให้บริการ (อ่านเป็น byte ดิบ)',
    schema: { type: 'object', additionalProperties: true },
  })
  @ApiOkResponse({ type: InboundReceiptDto })
  @ApiUnauthorizedResponse({ description: 'token หรือลายเซ็นไม่ถูกต้อง' })
  @ApiPayloadTooLargeResponse({ description: `body เกิน ${INBOUND_MAX_BYTES / 1024} KB` })
  @ApiTooManyRequestsResponse({ description: 'เรียกถี่เกินไป (ต่อ IP / ต่อ token)' })
  async receive(
    @Param('provider') provider: string,
    @Param('token') token: string,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<InboundReceiptDto> {
    res.setHeader('Cache-Control', 'no-store');
    const ctx = requestContext.get();
    return this.inbound.receive({
      provider,
      token,
      rawBody: Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0),
      headers: headersOf(req),
      ip: ctx?.ip ?? req.ip,
      requestId: ctx?.requestId,
    });
  }
}
