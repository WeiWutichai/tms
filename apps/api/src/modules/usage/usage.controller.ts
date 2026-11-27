import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Clock } from '../../common/clock';
import { RequireScope } from '../../common/decorators';
import { requestContext } from '../../common/request-context';
import { DbService } from '../../db/db.service';
import { VehiclesService } from '../vehicles/vehicles.service';
import { bangkokPeriod, readActiveVehicles } from './active-vehicles';
import { ActiveVehicleQuery, ActiveVehicleUsageDto } from './usage.dto';

/**
 * การใช้งานของบริษัท (P1-ST1-T06; spec/01 §7) — ลูกค้าดูรายการรถที่ถูกนับเป็นรถ active ของเดือน
 * สิทธิ์ `master:read` [DECISION — lead 28 พ.ย. 2569, ย้อนได้]: spec/01 §7 ระบุ `billing.view` ซึ่งยังไม่มีในชุดสิทธิ์
 * — ใช้สิทธิ์เดียวกับทะเบียนรถ (แถบรถ active อยู่บนหน้าทะเบียนรถ) จนกว่าหน้าแพ็กเกจ P1-ST3-T03 จะกำหนดสิทธิ์ของตัวเอง
 */
@ApiTags('usage')
@ApiBearerAuth()
@Controller('usage')
export class UsageController {
  constructor(
    private readonly db: DbService,
    private readonly vehicles: VehiclesService,
    private readonly clock: Clock,
  ) {}

  @Get('active-vehicles')
  @RequireScope('master:read')
  @ApiOperation({
    summary: 'รถ active ของเดือน + ทะเบียนที่ถูกนับ',
    description:
      'รถ active = ทะเบียน (normalize: ตัดช่องว่าง/ขีด/จุด, เลขไทย → อารบิก — "กข-1234" = "กข1234") ที่มีเที่ยวเข้าเงื่อนไข ≥ 1 เที่ยว' +
      'ในเดือนปฏิทินเวลาไทย (docs/02 §2 · spec/01 PLT-070–075) · นับทันทีเมื่อเที่ยวแรกของทะเบียนเข้าเงื่อนไข และนำออกเมื่อเที่ยวย้อนสถานะ ' +
      '(เช่น ยกเลิกหลังปล่อยรถ) ก่อนปิดยอด · ปิดยอดวันที่ 1 เวลา 02:00 น. ไทยของเดือนถัดไป · sandbox ไม่นับ',
  })
  @ApiOkResponse({ type: ActiveVehicleUsageDto })
  async activeVehicles(@Query() q: ActiveVehicleQuery): Promise<ActiveVehicleUsageDto> {
    const tenantId = requestContext.require().tenantId!;
    const period = q.period ?? bangkokPeriod(this.clock.now());
    const u = await readActiveVehicles(this.db.tx, tenantId, period);
    return {
      period: u.period,
      status: u.status,
      finalizedAt: u.finalizedAt,
      activeVehicles: u.count,
      own: u.own,
      subcontract: u.subcontract,
      limit: await this.vehicles.quotaLimit(),
      data: u.items.map((i) => ({
        plate: i.plate,
        plateMissing: i.plateMissing,
        subcontract: i.subcontract,
        vehicleType: i.vehicleType,
        carrierName: i.carrierName,
        trips: i.trips,
        firstTripId: i.firstTripId,
        firstTripNo: i.firstTripNo,
        firstCountedAt: i.firstCountedAt,
        adjusted: i.adjusted,
      })),
    };
  }
}
