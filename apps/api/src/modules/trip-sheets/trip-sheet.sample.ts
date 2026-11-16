import type { TripSheetDoc } from './trip-sheet.template';

/**
 * ใบคุมรถตัวอย่าง (ข้อมูลเดียวกับต้นแบบ TMS Print#trip + เวลานัด/ที่อยู่/ผู้ติดต่อ/สินค้า) — golden test (ST3-T20)
 * และภาพเทียบ "ต้นแบบ | ของจริง" · ข้อความมีสระบน/ล่าง + วรรณยุกต์ (ปั้น ผู้ ที่ ซีเมนต์ ฯลฯ)
 */
export function sampleTripSheet(): TripSheetDoc {
  return {
    companyName: 'บริษัท ศรีไทยขนส่ง จำกัด',
    yearStyle: 'BE',
    pages: [
      {
        tripNo: 'TRP-2611-0041',
        tripDate: '2026-11-03',
        plate: '70-1234 กทม.',
        vehicleType: '6 ล้อ',
        trailerPlate: null,
        driverName: 'สมชาย ใจดี',
        carrierName: null,
        stops: [
          {
            sequence: 1,
            type: 'PICKUP',
            siteName: 'กรุงเทพ คลังต้นทาง',
            address: '88 ถ.บางนา-ตราด บางนา กรุงเทพฯ 10260',
            appointment: '07:00',
            contactName: 'คุณวิภา',
            contactPhone: '02-118-4400',
            dos: [
              { doNo: 'DO-2611-00060', goods: ['เม็ดพลาสติก HDPE 2.5 ตัน'] },
              { doNo: 'DO-2611-00080', goods: ['ปูนซีเมนต์ถุง 120 ถุง'] },
            ],
          },
          {
            sequence: 2,
            type: 'DELIVERY',
            siteName: 'ชลบุรี บจก. สยามพลาสติก',
            address: '12/3 ม.5 ต.บ้านสวน เมือง ชลบุรี 20000',
            appointment: '09:00–11:00',
            contactName: 'คุณสมศักดิ์ ปั้นทอง',
            contactPhone: '081-234-5678',
            dos: [{ doNo: 'DO-2611-00060', goods: ['เม็ดพลาสติก HDPE 2.5 ตัน'] }],
          },
          {
            sequence: 3,
            type: 'DELIVERY',
            siteName: 'ชลบุรี ศูนย์กระจายสินค้า',
            address: '199 ถ.สุขุมวิท ห้วยกะปิ ชลบุรี 20000',
            appointment: '13:00–15:00',
            contactName: 'คุณฐิติพร',
            contactPhone: '038-111-222',
            dos: [{ doNo: 'DO-2611-00080', goods: ['ปูนซีเมนต์ถุง 120 ถุง'] }],
          },
        ],
      },
    ],
  };
}
