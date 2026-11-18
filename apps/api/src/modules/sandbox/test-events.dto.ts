import { ApiProperty } from '@nestjs/swagger';
import { ACTIVE_EVENT_TYPES } from '@tms/domain';
import { IsIn, IsString } from 'class-validator';

/** ST7-T09 `POST /v1/test/events/trigger` — ยิง event จำลองใน sandbox */
export class TriggerTestEventDto {
  @ApiProperty({
    enum: ACTIVE_EVENT_TYPES,
    example: 'order.created',
    description:
      'event สาธารณะที่ยิงได้ในเฟสนี้ (`phase: active` ใน `GET /v1/webhooks/event-types`) — `data.object` = ตัวอย่างตาม schema ของ event (ข้อมูลสมมติ)',
  })
  @IsString()
  @IsIn(ACTIVE_EVENT_TYPES as unknown as string[])
  type!: string;
}

export class TriggerDeliveryDto {
  @ApiProperty({ example: 'whe_…' }) endpointId!: string;
  @ApiProperty({
    enum: ['delivered', 'failed', 'queued', 'skipped'],
    description:
      'delivered = ปลายทางตอบ 2xx · failed = ล้ม (retry ตามตาราง G1 ถ้าเป็นข้อผิดพลาดชั่วคราว) · queued = worker จะส่ง · skipped = endpoint ปิด/ไม่มีในแพ็กเกจ',
  })
  state!: 'delivered' | 'failed' | 'queued' | 'skipped';
  @ApiProperty({ nullable: true, type: String, example: 'whd_…' }) deliveryId!: string | null;
  @ApiProperty({ nullable: true, type: Number, description: 'HTTP status ที่ปลายทางตอบ' })
  status!: number | null;
}

export class TriggerTestEventResultDto {
  @ApiProperty({
    example: 'evt_…',
    description: 'id ของ event (= `id` ใน envelope / `X-TMS-Event-Id`)',
  })
  eventId!: string;
  @ApiProperty({ example: 'order.created' }) type!: string;
  @ApiProperty({ enum: ['test'] }) mode!: 'test';
  @ApiProperty({
    description:
      'จำนวน webhook endpoint ของ sandbox ที่เปิดอยู่และสมัคร event นี้ (คำสั่งส่งใน outbox) · 0 = ไม่มีผู้รับ',
  })
  queued!: number;
  @ApiProperty({ type: [TriggerDeliveryDto], description: 'ผลการส่งครั้งแรกต่อ endpoint' })
  deliveries!: TriggerDeliveryDto[];
  @ApiProperty({ type: 'object', additionalProperties: true, description: '`data.object` ที่ส่ง' })
  object!: Record<string, unknown>;
}
