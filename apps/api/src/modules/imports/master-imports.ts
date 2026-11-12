import { Injectable, OnModuleInit } from '@nestjs/common';
import { carrierImportSpec } from '../carriers/carrier.import';
import { CarriersService } from '../carriers/carriers.service';
import { customerImportSpec } from '../customers/customer.import';
import { CustomersService } from '../customers/customers.service';
import { driverImportSpec } from '../drivers/driver.import';
import { DriversService } from '../drivers/drivers.service';
import { productImportSpec } from '../products/product.import';
import { ProductsService } from '../products/products.service';
import { rateCardImportSpec } from '../rate-cards/rate-card.import';
import { RateCardsService } from '../rate-cards/rate-cards.service';
import { routeImportSpec } from '../routes/route.import';
import { RoutesService } from '../routes/routes.service';
import { serviceItemImportSpec } from '../service-items/service-item.import';
import { ServiceItemsService } from '../service-items/service-items.service';
import { siteImportSpec } from '../sites/site.import';
import { SitesService } from '../sites/sites.service';
import { vehicleImportSpec } from '../vehicles/vehicle.import';
import { VehiclesService } from '../vehicles/vehicles.service';
import { ImportRegistry } from './import-spec';

/**
 * ลงทะเบียน spec นำเข้าของข้อมูลหลักทุกตัว (ST2-T23) — แต่ละ spec อยู่ข้าง service ของตัวเอง (`*.import.ts`)
 * และเรียก service เดียวกับ API (กฎเดียวกัน — MD-281) · ลำดับ = ลำดับที่ควรนำเข้า (ข้อมูลที่ถูกอ้างก่อน)
 */
@Injectable()
export class MasterImports implements OnModuleInit {
  constructor(
    private readonly registry: ImportRegistry,
    private readonly customers: CustomersService,
    private readonly sites: SitesService,
    private readonly carriers: CarriersService,
    private readonly vehicles: VehiclesService,
    private readonly drivers: DriversService,
    private readonly routes: RoutesService,
    private readonly products: ProductsService,
    private readonly serviceItems: ServiceItemsService,
    private readonly rateCards: RateCardsService,
  ) {}

  onModuleInit() {
    const specs = [
      customerImportSpec(this.customers),
      siteImportSpec(this.sites),
      carrierImportSpec(this.carriers),
      vehicleImportSpec(this.vehicles),
      driverImportSpec(this.drivers),
      routeImportSpec(this.routes),
      productImportSpec(this.products),
      serviceItemImportSpec(this.serviceItems),
      rateCardImportSpec(this.rateCards, 'SELL'),
      rateCardImportSpec(this.rateCards, 'BUY'),
    ];
    for (const s of specs) if (!this.registry.get(s.kind)) this.registry.register(s);
  }
}
