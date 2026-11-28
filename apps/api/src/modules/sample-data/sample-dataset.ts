/**
 * ชุดข้อมูลตัวอย่างของ trial (P1-ST2-T09) — บริษัทขนส่งสมมติ ไม่เหมือนบริษัทจริง (คำเตือน design/README.md:
 * ห้ามใช้ข้อมูลที่ดูเหมือนบริษัทจริง เช่น "ศรีไทยขนส่ง") — ทุกชื่อมีคำว่า "ตัวอย่าง", ไม่มีเลขผู้เสียภาษี/บัญชีธนาคาร,
 * เบอร์โทร 0x-000-xxxx (ไม่ใช่เบอร์ที่ใช้งาน), ทะเบียนรถหมวด "ตย"
 * จังหวัด/พิกัดเป็นพื้นที่จริงเพื่อให้แผนที่และระยะทางดูสมเหตุผล แต่ไม่ชี้สถานประกอบการใด
 */

type Addr = {
  line1: string;
  subdistrict?: string;
  district?: string;
  province: string;
  postcode: string;
};

export const SAMPLE_CUSTOMERS: {
  key: string;
  name: string;
  contact: string;
  phone: string;
  address: Addr;
}[] = [
  {
    key: 'a',
    name: 'บริษัท ตัวอย่างค้าวัสดุ จำกัด',
    contact: 'คุณตัวอย่าง ฝ่ายจัดซื้อ',
    phone: '02-000-0001',
    address: {
      line1: '99/1 หมู่ 1 ถนนตัวอย่าง',
      subdistrict: 'บางนาเหนือ',
      district: 'บางนา',
      province: 'กรุงเทพมหานคร',
      postcode: '10260',
    },
  },
  {
    key: 'b',
    name: 'บริษัท ตัวอย่างอาหารแช่แข็ง จำกัด',
    contact: 'คุณทดลอง ฝ่ายคลังสินค้า',
    phone: '02-000-0002',
    address: {
      line1: '88/8 หมู่ 5 ซอยตัวอย่าง',
      subdistrict: 'บางพลีใหญ่',
      district: 'บางพลี',
      province: 'สมุทรปราการ',
      postcode: '10540',
    },
  },
  {
    key: 'c',
    name: 'ห้างหุ้นส่วนจำกัด ตัวอย่างเกษตรภัณฑ์',
    contact: 'คุณสมมติ เจ้าของกิจการ',
    phone: '034-000-003',
    address: {
      line1: '7 หมู่ 2 ถนนตัวอย่าง',
      subdistrict: 'พระปฐมเจดีย์',
      district: 'เมืองนครปฐม',
      province: 'นครปฐม',
      postcode: '73000',
    },
  },
];

export const SAMPLE_SITES: {
  key: string;
  customer: string | null;
  kind: 'PICKUP' | 'DROPOFF' | 'WAREHOUSE';
  name: string;
  address: Addr;
  lat: string;
  lng: string;
  openTime?: string;
  closeTime?: string;
}[] = [
  {
    key: 'a_pick',
    customer: 'a',
    kind: 'PICKUP',
    name: 'โรงงานตัวอย่างค้าวัสดุ (บางนา)',
    address: {
      line1: '99/1 หมู่ 1 ถนนตัวอย่าง',
      district: 'บางนา',
      province: 'กรุงเทพมหานคร',
      postcode: '10260',
    },
    lat: '13.668000',
    lng: '100.634000',
    openTime: '08:00',
    closeTime: '17:00',
  },
  {
    key: 'a_d1',
    customer: 'a',
    kind: 'DROPOFF',
    name: 'ร้านวัสดุตัวอย่าง สาขาชลบุรี',
    address: {
      line1: '12 ถนนตัวอย่าง',
      district: 'เมืองชลบุรี',
      province: 'ชลบุรี',
      postcode: '20000',
    },
    lat: '13.361000',
    lng: '100.984000',
    openTime: '08:00',
    closeTime: '18:00',
  },
  {
    key: 'a_d2',
    customer: 'a',
    kind: 'DROPOFF',
    name: 'ร้านวัสดุตัวอย่าง สาขาอยุธยา',
    address: {
      line1: '34 ถนนตัวอย่าง',
      district: 'พระนครศรีอยุธยา',
      province: 'พระนครศรีอยุธยา',
      postcode: '13000',
    },
    lat: '14.353000',
    lng: '100.568000',
  },
  {
    key: 'b_pick',
    customer: 'b',
    kind: 'WAREHOUSE',
    name: 'คลังห้องเย็นตัวอย่าง (บางพลี)',
    address: {
      line1: '88/8 หมู่ 5 ซอยตัวอย่าง',
      district: 'บางพลี',
      province: 'สมุทรปราการ',
      postcode: '10540',
    },
    lat: '13.607000',
    lng: '100.716000',
  },
  {
    key: 'b_d1',
    customer: 'b',
    kind: 'DROPOFF',
    name: 'ศูนย์กระจายสินค้าตัวอย่าง (ลำลูกกา)',
    address: {
      line1: '5 ถนนตัวอย่าง',
      district: 'ลำลูกกา',
      province: 'ปทุมธานี',
      postcode: '12150',
    },
    lat: '13.932000',
    lng: '100.746000',
    openTime: '06:00',
    closeTime: '14:00',
  },
  {
    key: 'c_pick',
    customer: 'c',
    kind: 'PICKUP',
    name: 'โกดังตัวอย่างเกษตรภัณฑ์ (นครปฐม)',
    address: {
      line1: '7 หมู่ 2 ถนนตัวอย่าง',
      district: 'เมืองนครปฐม',
      province: 'นครปฐม',
      postcode: '73000',
    },
    lat: '13.819000',
    lng: '100.062000',
  },
  {
    key: 'c_d1',
    customer: 'c',
    kind: 'DROPOFF',
    name: 'ร้านเกษตรตัวอย่าง สาขาราชบุรี',
    address: {
      line1: '21 ถนนตัวอย่าง',
      district: 'เมืองราชบุรี',
      province: 'ราชบุรี',
      postcode: '70000',
    },
    lat: '13.536000',
    lng: '99.817000',
  },
];

export const SAMPLE_CARRIERS: {
  key: string;
  name: string;
  entityType: 'INDIVIDUAL' | 'JURISTIC';
  phone: string;
}[] = [
  {
    key: 'x',
    name: 'ห้างหุ้นส่วนจำกัด ตัวอย่างรถร่วมขนส่ง',
    entityType: 'JURISTIC',
    phone: '080-000-0001',
  },
  { key: 'y', name: 'นายตัวอย่าง รถร่วม', entityType: 'INDIVIDUAL', phone: '080-000-0002' },
];

/** ทะเบียนหมวด "ตย" (ตัวอย่าง) จังหวัดกรุงเทพมหานคร (TH-10) */
export const SAMPLE_VEHICLES: {
  plate: string;
  province: string;
  type: '6W' | '10W';
  carrier: string | null;
  brand: string;
}[] = [
  { plate: 'ตย-9001', province: 'TH-10', type: '6W', carrier: null, brand: 'ISUZU' },
  { plate: 'ตย-9002', province: 'TH-10', type: '6W', carrier: null, brand: 'HINO' },
  { plate: 'ตย-9003', province: 'TH-10', type: '10W', carrier: null, brand: 'HINO' },
  { plate: 'ตย-9004', province: 'TH-10', type: '6W', carrier: 'x', brand: 'ISUZU' },
  { plate: 'ตย-9005', province: 'TH-10', type: '6W', carrier: 'y', brand: 'FUSO' },
];

/** ใบสั่งขนส่งตัวอย่าง + ราคาขาย (rate card ขาย) และราคาจ้างรถร่วม (rate card ซื้อ) ของเส้นทางนั้น — บาท ก่อน VAT ต่อเที่ยว */
export const SAMPLE_ORDERS: {
  ref: string;
  customer: string;
  from: string;
  to: string;
  type: '6W' | '10W';
  sell: string;
  buy?: { carrier: string; price: string };
  lines: { description: string; qty: string; unit: string; weightKg: string }[];
}[] = [
  {
    ref: 'PO-ตัวอย่าง-001',
    customer: 'a',
    from: 'a_pick',
    to: 'a_d1',
    type: '6W',
    sell: '4500.00',
    buy: { carrier: 'x', price: '3600.00' },
    lines: [
      { description: 'ปูนซีเมนต์ถุง 50 กก. (ตัวอย่าง)', qty: '120', unit: 'ถุง', weightKg: '6000' },
    ],
  },
  {
    ref: 'PO-ตัวอย่าง-002',
    customer: 'a',
    from: 'a_pick',
    to: 'a_d2',
    type: '6W',
    sell: '5200.00',
    lines: [{ description: 'เหล็กเส้น (ตัวอย่าง)', qty: '80', unit: 'มัด', weightKg: '5500' }],
  },
  {
    ref: 'PO-ตัวอย่าง-003',
    customer: 'b',
    from: 'b_pick',
    to: 'b_d1',
    type: '6W',
    sell: '3800.00',
    buy: { carrier: 'y', price: '3000.00' },
    lines: [
      { description: 'อาหารแช่แข็ง (ตัวอย่าง)', qty: '150', unit: 'กล่อง', weightKg: '1800' },
    ],
  },
  {
    ref: 'PO-ตัวอย่าง-004',
    customer: 'c',
    from: 'c_pick',
    to: 'c_d1',
    type: '10W',
    sell: '6800.00',
    lines: [
      { description: 'ปุ๋ยอินทรีย์ (ตัวอย่าง)', qty: '300', unit: 'กระสอบ', weightKg: '15000' },
    ],
  },
];
