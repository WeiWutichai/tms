import { Injectable, OnModuleInit } from '@nestjs/common';
import { carriersExportSpec } from '../carriers/carriers.controller';
import { CarriersService } from '../carriers/carriers.service';
import { customersExportSpec } from '../customers/customers.controller';
import { CustomersService } from '../customers/customers.service';
import { driversExportSpec } from '../drivers/drivers.controller';
import { DriversService } from '../drivers/drivers.service';
import { ordersExportSpec } from '../orders/order.export';
import { OrdersService } from '../orders/orders.service';
import { productsExportSpec } from '../products/products.controller';
import { ProductsService } from '../products/products.service';
import { rateCardsExportSpec } from '../rate-cards/rate-cards.controller';
import { RateCardsService } from '../rate-cards/rate-cards.service';
import { reasonCodesExportSpec } from '../reason-codes/reason-codes.controller';
import { ReasonCodesService } from '../reason-codes/reason-codes.service';
import { routesExportSpec } from '../routes/routes.controller';
import { RoutesService } from '../routes/routes.service';
import { serviceItemsExportSpec } from '../service-items/service-items.controller';
import { ServiceItemsService } from '../service-items/service-items.service';
import { customerSitesExportSpec } from '../sites/sites.controller';
import { SitesService } from '../sites/sites.service';
import { vehicleDocumentsExportSpec } from '../vehicle-documents/vehicle-documents.controller';
import { VehicleDocumentsService } from '../vehicle-documents/vehicle-documents.service';
import { vehicleTypesExportSpec } from '../vehicle-types/vehicle-types.controller';
import { VehicleTypesService } from '../vehicle-types/vehicle-types.service';
import { vehiclesExportSpec } from '../vehicles/vehicles.controller';
import { VehiclesService } from '../vehicles/vehicles.service';
import { AgingService } from '../payments/aging.service';
import {
  agingExportSpec,
  revenueExportSpec,
  unbilledExportSpec,
} from '../reports/reports.controller';
import { RevenueReportService } from '../reports/revenue-report.service';
import { UnbilledReportService } from '../reports/unbilled-report.service';
import { EXPORT_RESOURCES } from './exports.controller';
import { ExportRegistry } from './export-spec';

/**
 * ลงทะเบียนหน้ารายการที่ส่งออกตามตัวกรองได้ (ST9-T10) — spec อยู่ข้าง controller/service ของรายการนั้น
 * (ตัวกรอง + การอ่าน + คอลัมน์ชุดเดียวกับรายการ/ส่งออกทันที) · รายการใน EXPORT_RESOURCES ต้องมี spec ครบ
 */
@Injectable()
export class ListExports implements OnModuleInit {
  constructor(
    private readonly registry: ExportRegistry,
    private readonly orders: OrdersService,
    private readonly customers: CustomersService,
    private readonly sites: SitesService,
    private readonly carriers: CarriersService,
    private readonly vehicles: VehiclesService,
    private readonly vehicleDocs: VehicleDocumentsService,
    private readonly drivers: DriversService,
    private readonly vehicleTypes: VehicleTypesService,
    private readonly routes: RoutesService,
    private readonly products: ProductsService,
    private readonly serviceItems: ServiceItemsService,
    private readonly rateCards: RateCardsService,
    private readonly reasonCodes: ReasonCodesService,
    private readonly unbilled: UnbilledReportService,
    private readonly aging: AgingService,
    private readonly revenue: RevenueReportService,
  ) {}

  onModuleInit() {
    const specs = [
      ordersExportSpec(this.orders),
      customersExportSpec(this.customers),
      customerSitesExportSpec(this.sites),
      carriersExportSpec(this.carriers),
      vehiclesExportSpec(this.vehicles),
      vehicleDocumentsExportSpec(this.vehicleDocs),
      driversExportSpec(this.drivers),
      vehicleTypesExportSpec(this.vehicleTypes),
      routesExportSpec(this.routes),
      productsExportSpec(this.products),
      serviceItemsExportSpec(this.serviceItems),
      rateCardsExportSpec(this.rateCards),
      reasonCodesExportSpec(this.reasonCodes),
      unbilledExportSpec(this.unbilled),
      agingExportSpec(this.aging),
      revenueExportSpec(this.revenue),
    ];
    for (const s of specs) if (!this.registry.get(s.resource)) this.registry.register(s);
    const missing = EXPORT_RESOURCES.filter((r) => !this.registry.get(r));
    if (missing.length) throw new Error(`export specs missing: ${missing.join(', ')}`);
  }
}
