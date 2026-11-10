/* TMS i18n — dictionary-driven runtime translation (TH default · EN · 中文). Data (names, addresses, products) stays Thai. */
(function () {
  if (window.TMSI18N) return;
  const CS = document.currentScript, FLOAT = CS && CS.dataset ? CS.dataset.float : null;
  const RAW = `
ภาพรวม|Overview|总览
หลัก|Main|主要
ปฏิบัติการ|Operations|运营
บัญชี|Accounting|财务
ข้อมูลหลัก|Master data|主数据
ตั้งค่า|Settings|设置
ระบบ|System|系统
อ้างอิง|Reference|参考
วิเคราะห์|Analytics|分析
รายการโปรด|Favorites|收藏
ระบบดีไซน์|Design system|设计系统
กระดานวางแผน|Planning board|调度看板
ติดตามรถ|Live tracking|车辆追踪
ใบสั่งขนส่ง (SO)|Shipment orders (SO)|运输订单 (SO)
ใบสั่งขนส่ง|Shipment order|运输订单
ใบส่งของ (DO)|Delivery orders (DO)|送货单 (DO)
ใบส่งของ|Delivery order|送货单
เที่ยวรถ / ใบคุมรถ|Trips / Trip sheets|车次 / 派车单
เที่ยวรถ|Trips|车次
ใบคุมรถ|Trip sheet|派车单
จ่ายงานรถร่วม|Subcontract dispatch|外包派单
วางบิลและใบแจ้งหนี้|Billing & invoices|开票与账单
รับชำระ|Receipts|收款
Settlement รถร่วม|Subcontractor settlement|外包结算
เงินเบิกล่วงหน้าคนขับ|Driver advances|司机预支款
เงินเบิกคนขับ|Driver advances|司机预支款
คิวเชื่อมระบบบัญชี|Accounting sync queue|财务同步队列
รายงาน|Reports|报表
ลูกค้า|Customers|客户
รถและคนขับ|Vehicles & drivers|车辆与司机
งาน|Jobs|任务
แจ้งปัญหา|Report issue|报告问题
เบิกเงิน|Advances|预支
ของฉัน|Me|我的
รายละเอียดงาน|Job details|任务详情
ส่งของ|Deliver|送货
สรุปการส่ง|Delivery summary|送货汇总
ตรวจรถก่อนออก|Pre-trip check|出车检查
เบิกเงิน / น้ำมัน|Advances / fuel|预支 / 燃油
บันทึกค่าใช้จ่าย|Log expense|记录费用
เปลี่ยนรถ|Change vehicle|更换车辆
ยังไม่ได้ตรวจรถวันนี้|Vehicle not checked today|今日未检查车辆
ต้องตรวจก่อนเริ่มงานแรก ใช้เวลาประมาณ 3 นาที|Required before the first job · about 3 min|首个任务前必须检查 · 约 3 分钟
งานวันนี้|Today's jobs|今日任务
เวลานัด|Appointment|预约时间
เริ่มงาน|Start job|开始任务
ทำงานต่อ|Continue|继续
รอเริ่ม|Not started|未开始
กำลังไป|En route|前往中
ถึงแล้ว|Arrived|已到达
ส่งไม่สำเร็จ|Failed|送货失败
เลือกรถวันนี้|Choose today's vehicle|选择今日车辆
รถที่ฝ่ายจัดรถมอบหมายให้คุณ|Vehicles assigned by dispatch|调度分配给您的车辆
อยู่ในพื้นที่จุดหมาย|Inside destination area|在目的地范围内
ห่างจุดหมาย 2.3 กม.|2.3 km from destination|距目的地 2.3 公里
แตะเพื่อจำลอง|Tap to simulate|点击模拟
ต้นทาง|Origin|起点
ปลายทาง 1|Drop 1|终点 1
ปลายทาง 2|Drop 2|终点 2
นำทาง|Navigate|导航
โทร|Call|呼叫
ออกเดินทาง|Depart|出发
ถึงจุดแล้ว|I've arrived|已到达
ขึ้นของเสร็จ|Loading done|装货完成
ขึ้นของแล้ว|Loaded|已装货
จบงาน|Finish job|结束任务
ตรวจรถก่อนเริ่มงาน|Check vehicle first|先检查车辆
คุณอยู่ห่างจุด 2.3 กม. ยืนยันหรือไม่|You are 2.3 km away. Confirm?|您距离 2.3 公里，确认吗？
ระบบจะบันทึกพิกัดจริงพร้อมเหตุผลให้ฝ่ายจัดรถเห็น|Your location and reason will be shared with dispatch|系统将记录实际位置和原因
GPS คลาดเคลื่อน|GPS inaccurate|GPS 偏差
ลูกค้าให้รอนอกพื้นที่|Customer asked to wait outside|客户要求在外等候
ทางเข้าปิดชั่วคราว|Entrance temporarily closed|入口暂时关闭
หรือพิมพ์เหตุผล|Or type a reason|或输入原因
ยืนยันถึงจุด|Confirm arrival|确认到达
ถ่ายรูปสินค้า|Photos of goods|货物照片
ถ่ายรูป|Take photo|拍照
ลายเซ็นผู้รับ|Recipient signature|收货人签名
เซ็นชื่อในกรอบนี้|Sign inside this box|请在框内签名
ชื่อผู้รับ|Recipient name|收货人姓名
ชื่อ-นามสกุล|Full name|姓名
จำนวนที่ส่งจริง|Delivered quantity|实际送货数量
ส่งน้อยกว่าแผน · เลือกเหตุผล|Short delivery · choose a reason|少于计划 · 选择原因
น้ำหนักชั่ง (กก.)|Weighed (kg)|称重 (公斤)
ไม่บังคับ|Optional|可选
บาร์โค้ด|Barcode|条码
สแกน|Scan|扫描
ยืนยันส่งแล้ว|Confirm delivered|确认已送达
ลูกค้าปิดทำการ|Customer closed|客户已关门
ลูกค้าไม่รับของ|Customer refused|客户拒收
ที่อยู่ผิด|Wrong address|地址错误
ถ่ายรูปหน้างาน (บังคับ)|Photo on site (required)|现场照片 (必填)
ของยังอยู่บนรถ ส่งใหม่พรุ่งนี้|Goods still on truck · redeliver tomorrow|货物仍在车上 · 明天重送
บันทึกส่งไม่สำเร็จ|Record failed delivery|记录送货失败
ส่งของสำเร็จ|Delivered|送货成功
บันทึกแล้ว จะส่งเมื่อมีสัญญาณ|Saved · will sync when online|已保存 · 有信号时上传
จุดถัดไป|Next stop|下一站
ครบทุกจุดของงานนี้แล้ว|All stops completed|所有站点已完成
ไปจุดถัดไป|Go to next stop|前往下一站
เกิดอะไรขึ้น|What happened?|发生了什么？
รถเสีย|Breakdown|车辆故障
อุบัติเหตุ|Accident|事故
ล่าช้า|Delay|延误
รูปประกอบ|Photos|照片
ข้อความสั้น|Short message|简短说明
ส่งแจ้งปัญหา|Send report|提交报告
โทรหาฝ่ายจัดรถ|Call dispatch|致电调度
ส่งแจ้งปัญหาแล้ว|Report sent|报告已提交
แจ้งเรื่องใหม่|New report|新报告
ต้องตรวจรถก่อนเริ่มงานแรกของวัน|Check the vehicle before today's first job|今日首个任务前须检查车辆
ยางและแรงดันลม|Tyres and pressure|轮胎和气压
ไฟหน้า ไฟเลี้ยว ไฟเบรก|Head, turn and brake lights|大灯、转向灯、刹车灯
เบรกและเบรกมือ|Brakes and handbrake|刹车和手刹
ระดับน้ำมันเครื่อง|Engine oil level|机油液位
น้ำหล่อเย็นและของเหลวอื่น|Coolant and other fluids|冷却液及其他液体
กระจกและที่ปัดน้ำฝน|Windscreen and wipers|挡风玻璃和雨刷
กระจกมองข้าง|Side mirrors|后视镜
แตรและเข็มขัดนิรภัย|Horn and seat belts|喇叭和安全带
ถังดับเพลิงและป้ายสามเหลี่ยม|Extinguisher and warning triangle|灭火器和三角警示牌
เอกสารรถ ทะเบียน พ.ร.บ. ใบขับขี่|Registration, insurance, licence|行驶证、保险、驾照
ปกติ|OK|正常
เลขไมล์เริ่มต้น (กม.)|Start odometer (km)|起始里程 (公里)
อ่านหน้าปัด|Read dashboard|读取仪表
ถ่ายหน้าปัดหรือพิมพ์|Photo or type|拍照或输入
พร้อมออกรถ|Ready to go|准备出车
ถ่ายรูปจุดที่ผิดปกติ (บังคับ)|Photo of defect (required)|异常处照片 (必填)
แนบรูปแล้ว|Photo attached|已附照片
คงเหลือ|Balance|余额
ได้รับ|Received|已收到
ใช้ไป|Used|已用
ค่าใช้จ่ายที่บันทึก|Logged expenses|已记录费用
ประเภท|Type|类型
จำนวนเงิน (บาท)|Amount (THB)|金额 (泰铢)
ลิตร|Litres|升
ใบเสร็จ|Receipt|收据
ถ่ายใบเสร็จ|Photograph receipt|拍收据
ถ่ายใหม่|Retake|重拍
ยกเลิก|Cancel|取消
บันทึก|Save|保存
ค่าจอด|Parking|停车费
อนุมัติ|Approved|已批准
ปฏิเสธ|Rejected|已拒绝
สรุปเดือนนี้|This month|本月汇总
เที่ยว|Trips|车次
ค่าเที่ยว (บาท) โดยประมาณ|Est. trip pay (THB)|预计车次费 (泰铢)
ใบจ่ายค่าเที่ยว|Pay slips|工资单
จ่ายแล้ว|Paid|已支付
ใบขับขี่ ท.2|Driving licence Class 2|二类驾照
หมดใน 25 วัน|Expires in 25 days|25 天后到期
ภาษา|Language|语言
ออกจากระบบ|Log out|退出登录
เข้าสู่ระบบด้วยเบอร์โทร|Sign in with your phone|用手机号登录
ระบบจะส่งรหัส 6 หลักทาง SMS ไม่ต้องใช้รหัสผ่าน|We'll text a 6-digit code · no password|系统将发送 6 位短信验证码 · 无需密码
เบอร์โทรศัพท์มือถือ|Mobile number|手机号码
ขอรหัส OTP|Get OTP|获取验证码
เบอร์ต้องลงทะเบียนกับบริษัทขนส่งไว้แล้ว|Number must be registered with your carrier|号码须已在运输公司登记
กรอกรหัส OTP|Enter OTP|输入验证码
เปลี่ยนเบอร์|Change number|更换号码
ส่งรหัสอีกครั้ง|Resend code|重新发送
เลือกบริษัท|Choose company|选择公司
เบอร์นี้ผูกกับ 2 บริษัทขนส่ง|This number is linked to 2 carriers|此号码关联 2 家运输公司
จำเครื่องนี้ 30 วัน ไม่ต้องขอ OTP ใหม่|Remember this device for 30 days|记住此设备 30 天
เข้าสู่ระบบ|Sign in|登录
ออนไลน์|Online|在线
รอส่ง|Pending|待上传
ข้อมูลงาน|Job details|作业信息
จุดรับ–ส่ง|Pickup & delivery|取送点
รถ / คนขับ|Vehicle / driver|车辆 / 司机
ราคา|Pricing|价格
หมายเหตุ|Notes|备注
จากลูกค้า|From customer|客户
ภายใน|Internal|内部
สินค้า|Items|货物
เอกสารแนบ|Attachments|附件
กิจกรรม|Activity|活动
เปลี่ยนเรท|Change rate|更改费率
กำหนดราคาเอง|Set price manually|手动定价
รวมก่อน VAT|Subtotal|税前合计
รวมทั้งสิ้น|Total|总计
ยังไม่จัดรถ|Not assigned|未派车
ส่งต่อรถร่วม|Send to subcontractor|转外包
จัดรถ|Assign|派车
คัดลอกเป็นใบใหม่|Duplicate|复制为新单
ยกเลิกเอกสาร|Cancel document|取消单据
ต้องย้ายรถ|Must reassign|需换车
ย้ายไปรถอื่น|Move to another vehicle|移到其他车
ยังไม่กำหนดคนขับ|No driver|未指定司机
กำหนด|Assign|指定
รถติดกฎห้ามจ่ายงาน|Blocked from dispatch|禁止派车
อนุมัติยกเว้นแล้ว|Exception approved|已批准例外
ขออนุมัติจากผู้จัดการ|Request manager approval|申请经理批准
แจ้งอุบัติเหตุ|Report accident|报告事故
ยื่นเคลม|File claim|提交理赔
เคลมประกัน|Insurance claims|保险理赔
บันทึกเคส|Save case|保存案件
บันทึกและยื่นเคลม|Save & file claim|保存并理赔
สรุปผล / ปิดเคส|Summary / close case|总结 / 结案
เพิ่มคู่กรณี|Add other party|添加对方
ใช้ GPS ของรถ|Use vehicle GPS|使用车辆GPS
ถ่าย / แนบรูป|Take / attach photo|拍照 / 附件
แนบไฟล์|Attach file|附件
ที่มา|Source|来源
แอปคนขับ|Driver app|司机 App
สร้างเอง|Manual|手动
ใบสั่งซ่อม|Work order|维修单
สัญญาณเหตุ รอยืนยัน|Incident signal · pending|事故信号 · 待确认
เพิ่มยาง|Add tyre|添加轮胎
บันทึกใบสั่ง|Record ticket|登记罚单
นำเข้าไฟล์|Import file|导入文件
บันทึกผลตรวจแทนคนขับ|Record inspection for driver|代司机登记检查
เพิ่มอะไหล่|Add part|添加配件
รับเข้า|Receive|入库
เบิกออก|Issue|出库
รับน้ำมันเข้าถัง|Receive fuel|油罐进油
จ่ายน้ำมัน|Dispense fuel|加油
บันทึกวัดยอด|Record dip|记录液位
เพิ่มหาง|Add trailer|添加挂车
พ่วง / ปลด|Attach / detach|挂接 / 解挂
เพิ่มผู้ขาย|Add vendor|添加供应商
แก้เลขไมล์|Edit odometer|修改里程
บันทึกเลขไมล์|Save odometer|保存里程
คลิกเพื่อกรองตาราง|Click to filter table|点击筛选表格
คลิกอีกครั้งเพื่อล้างตัวกรอง|Click again to clear filter|再次点击清除筛选
เปิดหน้าคะแนนการขับขี่|Open driving scores|打开驾驶评分
ยังไม่มีคะแนน|No score yet|暂无评分
คะแนนการขับขี่|Driving score|驾驶评分
อะไหล่และสต็อก|Parts & stock|配件与库存
ถังน้ำมันบริษัท|Company fuel tank|公司油罐
หางพ่วง / หางลาก|Trailers|挂车
แจ้งเตือนเอกสารรถ|Document alerts|证件提醒
วงเงินอนุมัติซ่อม|Repair approval limits|维修审批额度
ดีมาก|Excellent|优秀
ต้องปรับปรุง|Needs improvement|需改进
ใกล้หมด|Low stock|库存不足
ส่วนต่างผิดปกติ|Abnormal variance|差异异常
เช่าซื้อ|Leasing|租赁
ยกเว้นและบันทึก log|Override and log|豁免并记录日志
รับเข้า|Receive|入库
เบิกเข้าใบสั่งซ่อม|Issue to work order|领用至维修单
พ่วงกับหัวลาก|Attach to tractor|挂接牵引车
ปลดหาง|Detach trailer|解挂
ศรีไทย TMS · คนขับ|Srithai TMS · Driver|诗泰 TMS · 司机
กรอกเบอร์โทรที่ลงทะเบียนกับบริษัท ระบบจะส่งรหัส 6 หลักทาง SMS|Enter the phone number registered with your company. We will text you a 6-digit code.|输入在公司登记的手机号码，系统将通过短信发送 6 位验证码
ไม่ต้องใส่ 0 นำหน้า|Do not include the leading 0|无需输入开头的 0
ส่งรหัสไปที่|Code sent to|验证码已发送至
ใส่ตัวเลขใดก็ได้ 6 หลัก|Any 6 digits will work|任意 6 位数字均可
เบอร์นี้ผูกกับ 2 บริษัท เลือกบริษัทที่จะทำงานวันนี้|This number is linked to 2 companies. Choose the one you work for today.|此号码绑定 2 家公司，请选择今天工作的公司
จำเครื่องนี้ 30 วัน|Remember this device for 30 days|记住此设备 30 天
ยืนยันรหัส|Verify code|验证
คนขับประจำ|Company driver|公司司机
รถร่วม · สังกัดผู้รับเหมา|Subcontractor · contractor fleet|外包车 · 承包商车队
ตั้งค่าก่อนเริ่มงาน|Set up before you start|开始前设置
สิทธิ์ของแอป|App permissions|应用权限
ตั้งค่าครั้งเดียวต่อเครื่อง เพื่อบันทึกเวลาถึงจุด ถ่ายรูปหลักฐาน และรับงานใหม่|One-time setup per device to record arrivals, take proof photos and receive new jobs.|每台设备只需设置一次，用于记录到达时间、拍摄凭证照片和接收新任务
ตำแหน่ง · จำเป็น|Location · required|位置 · 必需
กล้อง · จำเป็น|Camera · required|相机 · 必需
บันทึกเวลาถึงจุดและเส้นทางระหว่างปฏิบัติงาน|Records arrival times and route while working|记录到达时间和工作路线
ถ่ายรูปสินค้า ใบส่งของ และใบเสร็จ|Photos of goods, delivery notes and receipts|拍摄货物、送货单和收据
รับงานใหม่และข้อความจากฝ่ายจัดรถ|New jobs and messages from dispatch|新任务和调度消息
อนุญาต|Allow|允许
อนุญาตแล้ว|Allowed|已允许
เปิดในการตั้งค่า|Open in Settings|在设置中开启
ความเป็นส่วนตัว (PDPA)|Privacy (PDPA)|隐私 (PDPA)
ยินยอมให้บริษัทเก็บตำแหน่งระหว่างปฏิบัติงาน และรูปถ่ายหลักฐานการส่ง ตาม พ.ร.บ. คุ้มครองข้อมูลส่วนบุคคล|I consent to the company collecting my location during work and proof-of-delivery photos under the Personal Data Protection Act.|本人同意公司根据《个人数据保护法》在工作期间收集位置及送货凭证照片
อ่านนโยบายความเป็นส่วนตัว|Read privacy policy|阅读隐私政策
เริ่มใช้งาน|Get started|开始使用
ขณะใช้แอป|While using the app|使用应用时
ครั้งนี้เท่านั้น|Only this time|仅此一次
ไม่อนุญาต|Don't allow|不允许
เปลี่ยน|Change|更换
ตรวจรถแล้ว|Inspected|已检查
งานใหม่รอตอบรับ|New job awaiting response|待接受的新任务
งานใหม่|New job|新任务
ไม่มีงานวันนี้|No jobs today|今天没有任务
ฝ่ายจัดรถจะแจ้งเตือนเมื่อมีงานใหม่เข้า|Dispatch will notify you when a new job comes in|有新任务时调度会通知您
ตรวจรถ|Inspect|检查车辆
GPS ปิดอยู่|GPS is off|GPS 已关闭
ต้องเปิดตำแหน่งเพื่อเริ่มงานและบันทึกเวลาถึงจุด|Turn on location to start jobs and record arrivals|需开启定位才能开始任务并记录到达
เปิด GPS|Turn on GPS|开启 GPS
เปิด GPS เพื่อเริ่มงาน|Turn on GPS to start|开启 GPS 以开始
นัด|Due|预约
จุดส่ง|drops|个送货点
ตอบภายใน|Respond within|请在此时间内回复
จุดรับ|Pickup point|取货点
ค่าเที่ยว|Trip fee|运费
ผู้สั่งงาน|Dispatcher|调度员
ปกติทั้งหมด|All OK|全部正常
รายการตรวจ 10 ข้อ|10-point checklist|10 项检查
ข้อวิกฤต|Critical item|关键项
หมายเหตุ (บังคับ)|Note (required)|备注（必填）
เลขไมล์เริ่มต้น|Starting odometer|起始里程
ครั้งก่อน|Last reading|上次读数
ห้ามออกรถ|Do not depart|禁止出车
ผิดปกติ ต้องให้ฝ่ายจัดรถตรวจก่อน|faulty — dispatch must check first|异常，需调度先检查
โทรฝ่ายจัดรถ|Call dispatch|致电调度
แจ้งฝ่ายจัดรถ|Report to dispatch|报告调度
แจ้งฝ่ายจัดรถแล้ว|Dispatch notified|已通知调度
รอฝ่ายจัดรถตรวจรถ|Waiting for dispatch check|等待调度检查
เอกสารรถ ทะเบียน พ.ร.บ.|Vehicle papers, registration, CMI|车辆证件、登记、强制险
จำลองตำแหน่ง: อยู่ในพื้นที่จุดหมาย|Simulate: inside destination area|模拟：在目的地范围内
จำลองตำแหน่ง: ห่างจุดหมาย 2.3 กม.|Simulate: 2.3 km from destination|模拟：距目的地 2.3 公里
เก็บเงินปลายทาง|Cash on delivery|货到付款
ปลายทาง|Drop|终点
ออกเดินทางไปต้นทาง|Head to origin|前往起点
ถึงต้นทางแล้ว|Arrived at origin|已到达起点
ถึงจุดส่งแล้ว|Arrived at drop|已到达送货点
ขึ้นของ|Load|装货
ลงของ|Unload|卸货
จบเที่ยว|End trip|结束行程
ขึ้นของที่ต้นทาง|Loading at origin|起点装货
นับสินค้าที่ขึ้นรถ|Count loaded goods|清点装车货物
ตามใบสั่ง|Per order|按订单
สแกนบาร์โค้ด|Scan barcode|扫描条码
สแกนเพื่อนับอัตโนมัติ|Scan to count automatically|扫描自动计数
สแกนแล้ว ตรงกับใบสั่งทุกรายการ|Scanned · matches all order lines|已扫描 · 与订单全部一致
รูปตอนขึ้นของ|Loading photos|装货照片
เลขซีลตู้ / ประตูรถ|Seal number|封条号
เลขซีล|Seal no.|封条号
ขึ้นของเสร็จ · ออกเดินทาง|Loaded · depart|装货完成 · 出发
ถ่ายใบส่งของ|Photo of delivery note|拍摄送货单
ถ่ายสลิป|Photo of slip|拍摄转账单
เวลารอลงของ|Unloading wait|卸货等待时间
นาที|min|分钟
กำลังรอ · นับจากเวลาถึงจุด|Waiting · counted from arrival|等待中 · 自到达起计
กำลังลงของ|Unloading|卸货中
เวลาที่บันทึก|Recorded times|记录时间
ถึงจุด|Arrived|到达
จาก geofence|From geofence|来自地理围栏
เริ่มลงของ|Start unloading|开始卸货
ลงของเสร็จ|Unloading done|卸货完成
กดปุ่มในแอป|Tapped in app|在应用中点击
แก้ไขแล้ว|Edited|已修改
เวลาถึงจุดบันทึกอัตโนมัติจาก geofence การแก้ไขต้องระบุเหตุผล และฝ่ายจัดรถจะเห็นประวัติการแก้|Arrival is recorded automatically by geofence. Edits need a reason and dispatch can see the history.|到达时间由地理围栏自动记录，修改需填写原因，调度可查看修改记录
ยืนยันการส่ง (POD)|Confirm delivery (POD)|确认送达 (POD)
ยืนยันการส่ง|Confirm delivery|确认送达
รูปสินค้าที่ส่ง|Photos of delivered goods|送达货物照片
หลักฐานผู้รับ|Recipient proof|收货人凭证
ลายเซ็นดิจิทัล|Digital signature|电子签名
รูปใบส่งของ|Delivery note photo|送货单照片
ให้ผู้รับเซ็นชื่อในกรอบนี้|Recipient signs in this box|请收货人在此框内签名
ล้าง|Clear|清除
ถ่ายใบส่งของกระดาษที่ผู้รับเซ็นและประทับตราแล้ว ให้เห็นทั้งแผ่น|Photograph the signed and stamped paper delivery note, showing the whole page|拍摄已签名盖章的纸质送货单，需完整入镜
แผน|Plan|计划
ส่งน้อยกว่าแผน จะบันทึกเป็นส่งบางส่วนในขั้นถัดไป|Less than planned — will be recorded as partial delivery next|少于计划，下一步将记录为部分送达
ยอดที่ต้องเก็บ|Amount to collect|应收金额
เงินสด|Cash|现金
โอนเงิน|Transfer|转账
รับเงินครบตามยอดแล้ว|Full amount received|已收取全额
สแกนและชั่งน้ำหนัก (ไม่บังคับ)|Scan and weigh (optional)|扫描与称重（可选）
สแกน QR / บาร์โค้ด|Scan QR / barcode|扫描二维码 / 条码
ใช้เมื่อสินค้ามีบาร์โค้ดหรือ QR|Use when goods have a barcode or QR|货物有条码或二维码时使用
อ่านแล้ว 2 รหัส ตรงกับใบส่งของ|2 codes read · match delivery note|已读取 2 个码 · 与送货单一致
บันทึกส่งบางส่วน|Save partial delivery|保存部分送达
ส่งบางส่วน|Partial delivery|部分送达
ไม่ได้ให้สิทธิ์กล้อง|Camera permission denied|未授予相机权限
ต้องใช้กล้องถ่ายรูปหลักฐานการส่ง|The camera is needed for proof-of-delivery photos|需要相机拍摄送达凭证
เปิดการตั้งค่า|Open Settings|打开设置
ไม่มีผู้รับ|No one to receive|无人签收
โทรแล้วไม่มีคนรับ หรือสถานที่ปิด|No answer or premises closed|电话无人接听或场所关闭
ผู้รับปฏิเสธรับ|Recipient refused|收货人拒收
ลูกค้าไม่รับสินค้าบางส่วนหรือทั้งหมด|Customer refused some or all goods|客户拒收部分或全部货物
บรรจุภัณฑ์หรือสินค้าเสียหายระหว่างขนส่ง|Packaging or goods damaged in transit|运输途中包装或货物损坏
ที่อยู่หรือพิกัดไม่ตรงกับใบส่งของ|Address or location does not match the delivery note|地址或坐标与送货单不符
ระบุเหตุผล|Specify reason|填写原因
ส่งได้|Delivered|已送达
คืน|returned|退回
รูปหลักฐาน (บังคับ)|Proof photos (required)|凭证照片（必填）
สินค้าที่ไม่ได้ส่ง|Undelivered goods|未送达货物
นัดส่งใหม่|Reschedule|重新预约
ของยังอยู่บนรถ|Goods still on the truck|货物仍在车上
คืนคลังต้นทาง|Return to origin warehouse|退回起点仓库
รอฝ่ายจัดรถตัดสินใจ|Wait for dispatch decision|等待调度决定
วันนัดส่งใหม่|New delivery date|新送货日期
หมายเหตุ|Note|备注
เวลา|Time|时间
รูปหลักฐาน|Proof photos|凭证照片
รูป|photos|张照片
สินค้าที่เหลือ|Remaining goods|剩余货物
กลับหน้างานวันนี้|Back to today's jobs|返回今日任务
ข้อมูลอยู่ในคิวส่งข้อมูล ไม่ต้องทำซ้ำ|It's in the upload queue — no need to redo|数据已在上传队列中，无需重复操作
สรุปเที่ยว|Trip summary|行程摘要
ออกรถ|Departed|出车
เวลารอลงของรวม|Total unloading wait|卸货等待总时长
เลขไมล์|Odometer|里程
เลขไมล์เริ่ม|Start odometer|起始里程
เลขไมล์ปิด (กม.)|End odometer (km)|结束里程（公里）
ระยะทาง|Distance|距离
เงินเบิก|Advance|预支款
เงินทอนคืน|Change to return|应退余额
คืนเงินทอนให้การเงินแล้ว|Change returned to finance|已将余额退还财务
ปิดใบคุมรถ|Close trip sheet|关闭派车单
ฝ่ายจัดรถจะติดต่อกลับภายใน 10 นาที|Dispatch will call back within 10 minutes|调度将在 10 分钟内回电
เลขอ้างอิง|Reference|参考编号
ประเภทปัญหา|Issue type|问题类型
เครื่องยนต์ ยาง เบรก ไฟ หรือรถวิ่งต่อไม่ได้|Engine, tyres, brakes, lights, or vehicle can't continue|发动机、轮胎、刹车、灯光或无法继续行驶
ชน เฉี่ยว หรือมีผู้บาดเจ็บ|Collision, scrape or injury|碰撞、刮擦或有人受伤
รถติด ถนนปิด หรือรอคิวนาน|Traffic, road closed or long queue|堵车、道路封闭或排队过久
ปัญหาที่ลูกค้า|Customer issue|客户问题
ติดต่อไม่ได้ ไม่รับของ หรือเอกสารไม่ครบ|Unreachable, refused goods or missing documents|联系不上、拒收或文件不全
เรื่องอื่นที่ต้องการให้ฝ่ายจัดรถทราบ|Anything else dispatch should know|其他需告知调度的事项
ตำแหน่ง|Location|位置
แนบอัตโนมัติ · แม่นยำ 8 ม.|Attached automatically · 8 m accuracy|自动附加 · 精度 8 米
ไม่ทราบตำแหน่ง|Location unknown|位置未知
เปิด GPS เพื่อแนบตำแหน่ง|Turn on GPS to attach location|开启 GPS 以附加位置
เงินเบิกคงเหลือ|Advance balance|预支余额
น้ำมัน|Fuel|燃油
มีลิตรและเลขไมล์|Includes litres and odometer|含升数和里程
จำนวนเงิน|Amount|金额
เลขไมล์ (กม.)|Odometer (km)|里程（公里）
ใบเสร็จ (บังคับ)|Receipt (required)|收据（必填）
เดือนนี้|This month|本月
ค่าเที่ยวโดยประมาณ|Estimated trip pay|预计运费
ข้อความจากฝ่ายจัดรถ|Messages from dispatch|调度消息
คิวส่งข้อมูล|Upload queue|上传队列
ออกจากระบบหรือไม่|Sign out?|确定退出登录？
เวอร์ชัน|Version|版本
ส่งไม่ได้|Failed|发送失败
ส่งซ้ำทั้งหมด|Retry all|全部重试
รอสัญญาณ|Waiting for signal|等待信号
บันทึกเมื่อ|Recorded at|记录于
ส่งข้อมูลครบแล้ว|All data sent|数据已全部上传
ไม่มีรายการค้างส่ง ข้อมูลที่บันทึกตอนออฟไลน์จะแสดงที่นี่|Nothing pending. Items saved while offline appear here.|没有待上传项目，离线时保存的数据会显示在这里
ข้อมูลบันทึกในเครื่องตามเวลาที่ทำจริง และจะส่งอัตโนมัติเมื่อมีสัญญาณ|Data is stored on the device with the actual time and sent automatically when there's signal|数据按实际时间保存在设备上，有信号时自动上传
ข้อความ|Messages|消息
อ่านทั้งหมด|Mark all read|全部已读
เซสชันหมดอายุ|Session expired|会话已过期
เข้าสู่ระบบอีกครั้งเพื่อทำงานต่อ ข้อมูลที่บันทึกไว้ยังอยู่ในเครื่อง|Sign in again to continue. Saved data is still on this device.|请重新登录以继续，已保存的数据仍在设备上
ใช้รถคันนี้|Use this vehicle|使用此车辆
รถสำรอง|Spare vehicle|备用车辆
หมายเหตุ (ไม่บังคับ)|Note (optional)|备注（可选）
ระบบจะบันทึกพิกัดจริงพร้อมเหตุผลให้ฝ่ายจัดรถตรวจ|Your actual location and reason will be recorded for dispatch to review|系统将记录实际位置和原因供调度审核
หรือระบุเหตุผลอื่น|Or enter another reason|或填写其他原因
แก้ไขเวลา|Edit time|修改时间
ต้องระบุเหตุผล ฝ่ายจัดรถจะเห็นประวัติการแก้ไข|A reason is required. Dispatch can see the edit history.|必须填写原因，调度可查看修改记录
เหตุผลที่แก้ไข (บังคับ)|Reason for edit (required)|修改原因（必填）
บันทึกเวลา|Save time|保存时间
จำลองการสแกน|Simulate scan|模拟扫描
วางบาร์โค้ดให้อยู่ในกรอบ|Place the barcode inside the frame|将条码置于框内
แอปคนขับ (ePOD)|Driver app (ePOD)|司机应用 (ePOD)
ภาพรวมทุกจอ|All screens|全部界面
หน้ารถร่วม|Subcontractor page|外包车页面
เริ่มใหม่|Reset|重置
ข้อเสนองาน|Job offer|任务邀约
อัปโหลด POD|Upload POD|上传 POD
ปฏิเสธงานแล้ว|Declined|已拒绝
รอตอบรับ|Awaiting response|待回复
ยาง|Tyres|轮胎
อุบัติเหตุและเคลม|Accidents & claims|事故与理赔
ใบสั่งและค่าปรับ|Traffic fines|交通罚单
ผลตรวจรถก่อนออก|Pre-trip inspections|出车前检查结果
ผู้ขาย / อู่ซ่อม|Vendors / garages|供应商 / 修理厂
ไม่ผ่าน|Failed|未通过
ยังไม่ตรวจ|Not inspected|未检查
ข้อบกพร่องค้าง|Open defects|未处理缺陷
แจ้งเหตุ|Reported|已报案
ยื่นเคลม|Claim filed|已提交理赔
ประกันอนุมัติ|Insurer approved|保险已批准
รอชำระ|Unpaid|待缴
หักแล้ว|Deducted|已扣款
หักคนขับ|Deduct from driver|从司机扣款
บริษัทจ่าย|Company pays|公司支付
ขับเร็ว|Speeding|超速
จอดห้าม|Illegal parking|违停
ดอกยางต่ำ|Low tread|胎纹过浅
สต็อก|In stock|库存
หล่อดอก|Retread|翻新
ทิ้ง|Scrapped|报废
ห้ามจ่ายงาน|Cannot dispatch|禁止派单
ดูสาเหตุ|View reason|查看原因
กม.|km|公里
พขร.มีเงินเดือน · ศรีไทยขนส่ง|Salaried driver · Srithai Transport|带薪司机 · 诗泰运输
พขร.มีเงินเดือน|Salaried driver|带薪司机
ส่งข้อมูลแล้ว|Synced|已上传
รายการ|items|项
ทะเบียนรถ|Vehicle register|车辆登记
ใบสั่งซ่อม|Work orders|维修工单
ปฏิทินซ่อมบำรุง|Maintenance calendar|保养日历
น้ำมันและค่าใช้จ่าย|Fuel & expenses|燃油与费用
เอกสารรถ|Vehicle documents|车辆证件
คนขับและผู้รับเหมา|Drivers & subcontractors|司机与外包商
โปรไฟล์รถ|Vehicle profile|车辆档案
เปิดใบสั่งซ่อม|Open work order|开维修单
สร้างใบสั่งซ่อม|Create work order|创建维修单
แจ้งซ่อมจากคนขับ|Driver repair reports|司机报修
อนุมัติใบสั่งซ่อม|Approve work order|批准维修单
มีใบสั่งซ่อมแล้ว|Work order exists|已有维修单
ประวัติใบสั่งซ่อม|Work order history|维修记录
กำลังซ่อม|In repair|维修中
แจ้งซ่อม|Reported|报修
ปลดระวาง|Retired|已退役
ครบกำหนด|Due|到期
วางแผนแล้ว|Planned|已计划
ตามแผน|Scheduled|按计划
ผิดปกติ|Anomaly|异常
ตรวจแล้ว|Verified|已核对
ซ่อม/ครบ PM|Repair / PM due|维修 / 保养到期
ซ่อมเสร็จ|Repair done|维修完成
ปิดงาน|Close job|关闭工单
ต่ออายุ|Renew|续期
บันทึกการต่ออายุ|Save renewal|保存续期
บันทึกเติมน้ำมัน|Log fuel|记录加油
นำเข้าจากบัตรฟลีท (CSV)|Import fleet card (CSV)|导入车队卡 (CSV)
ครบกำหนดใน 14 วัน|Due in 14 days|14 天内到期
แผน PM ต่อประเภทรถ|PM plan by vehicle type|按车型保养计划
บันทึกแผน PM|Save PM plan|保存保养计划
ซ่อมบำรุง|Maintenance|保养
ค่าปรับ/จอด|Fines / parking|罚款 / 停车
ทางด่วน|Tolls|过路费
อื่นๆ|Other|其他
ประกันภัย|Insurance|保险
ตรวจสภาพ ตรอ.|Vehicle inspection|车检
ใบอนุญาตขนส่ง|Transport licence|运输许可
วงเงินอนุมัติ|Approved limit|批准额度
รถทั้งหมด|All vehicles|全部车辆
เอกสารใกล้หมด 30 วัน|Docs expiring in 30 days|30 天内到期证件
เสร็จเดือนนี้|Done this month|本月完成
ค่าซ่อมเดือนนี้ (฿)|Repair cost this month (฿)|本月维修费 (฿)
ลิตรเดือนนี้|Litres this month|本月升数
บาทเดือนนี้|Baht this month|本月金额
กม. / ลิตรเฉลี่ย|Avg km / L|平均 公里/升
รายการผิดปกติ|Anomalies|异常记录
ภายใน 7 วัน|Within 7 days|7 天内
ภายใน 30 วัน|Within 30 days|30 天内
ภายใน 60 วัน|Within 60 days|60 天内
หมดแล้ว|Expired|已过期
ส่งออกให้ฝ่ายธุรการ|Export for admin|导出给行政
รายการงาน|Work items|工作项目
รูปและใบเสร็จ|Photos & receipts|照片与收据
ใบเสร็จอู่|Garage receipt|修理厂收据
รูปจากคนขับ|Driver photos|司机照片
ต้นทุน|Cost|成本
ประวัติ|History|历史
SO รอกำหนดเส้นทาง|SO awaiting route|待定路线 SO
รถล่าช้าวันนี้|Late vehicles today|今日延误车辆
ใบแจ้งหนี้เกินกำหนด|Overdue invoices|逾期发票
ค้นหาหรือสั่งงาน|Search or run a command|搜索或执行命令
ค้นหา|Search|搜索
โหมดตัวอย่าง|Preview mode|预览模式
ไม่เชื่อม ERP|No ERP|未连接 ERP
เชื่อม 1 ตัว|1 connector|连接 1 个
ไม่ได้เชื่อมระบบบัญชี|No accounting system linked|未连接财务系统
ฝ่ายวางแผนรถ|Fleet planning|车辆调度部
ใหม่|New|新
งานวันนี้|Jobs today|今日任务
รอกำหนดเส้นทาง|Awaiting route|待定路线
ยังไม่จับคู่ลูกค้า|Customer unmatched|客户未匹配
รับคำสั่งแล้ว|Order received|已接单
จัดรถแล้ว|Vehicle assigned|已派车
ระหว่างส่ง|In transit|运输中
ส่งแล้ววันนี้|Delivered today|今日已送达
ส่งแล้ว|Delivered|已送达
ร่าง|Draft|草稿
ตีกลับบางส่วน|Partially returned|部分退回
วางบิลแล้ว|Billed|已开票
ส่งไม่สำเร็จ|Failed|失败
ออกแล้ว|Issued|已开具
ชำระบางส่วน|Partially paid|部分付款
ชำระแล้ว|Paid|已付款
เกินกำหนดชำระ|Overdue|逾期未付
เกินกำหนด|Overdue|逾期
ยกเลิก|Cancel|取消
ปิดแล้ว|Closed|已关闭
รอตรวจ|To review|待审核
รออนุมัติ|Pending approval|待审批
อนุมัติแล้ว|Approved|已审批
จ่ายแล้วเดือนนี้|Paid this month|本月已付
จ่ายแล้ว|Paid|已付
รอตอบ|Awaiting reply|待回复
รับงานแล้ว|Accepted|已接受
รับงาน|Orders|接单
ปฏิเสธ|Decline|拒绝
หมดเวลา|Expired|已超时
ไม่ตรง|Mismatch|不一致
รอส่งซ้ำ|Retry pending|待重发
ถูกปฏิเสธ|Rejected|被拒绝
ซิงก์แล้ว|Synced|已同步
รอส่ง|Queued|待发送
ล้มเหลว|Failed|失败
สำเร็จ|Success|成功
ข้าม|Skipped|跳过
รอดำเนินการ|Pending|处理中
มีการแก้ไข|Edited|已修改
วางแผน|Planning|调度
เบิกแล้ว|Advanced|已预支
รอเคลียร์|To clear|待核销
เคลียร์แล้ว|Cleared|已核销
กำลังวิ่ง|En route|行驶中
ถึงจุดแล้ว|Arrived|已到达
ล่าช้า|Late|延误
ออกนอกเส้นทาง|Off route|偏离路线
จอดนาน|Long stop|长时间停车
พร้อมใช้|Available|可用
ซ่อมบำรุง|Maintenance|维修中
ระหว่างงาน|On job|任务中
ลาพัก|On leave|休假
ใช้งาน|Active|启用
ปิดใช้|Inactive|停用
ระงับชั่วคราว|Suspended|暂停
มีผล|Effective|生效
หมดอายุ|Expired|已过期
ใกล้หมดอายุ|Expiring|即将过期
เชื่อมต่อ|Connected|已连接
ยังไม่เชื่อม|Not connected|未连接
น้ำหนักเกิน|Overweight|超重
ใบขับขี่ไม่ตรง|License mismatch|驾照不符
เอกสารรถหมดอายุ|Vehicle docs expired|车辆证件过期
ยกเว้นแล้ว|Overridden|已豁免
ต่าง|Differs|不同
ผ่าน|Passed|通过
รอหลักฐาน|Awaiting proof|待凭证
ใบลดหนี้|Credit note|贷项通知单
ใบเพิ่มหนี้|Debit note|借项通知单
ใบแจ้งหนี้/ใบกำกับภาษี|Invoice / Tax invoice|发票 / 税务发票
ใบแจ้งหนี้|Invoice|发票
ใบวางบิล|Billing note|账单通知
ใบเสร็จรับเงิน/ใบกำกับภาษี|Receipt / Tax invoice|收据 / 税务发票
ใบเสร็จรับเงิน|Receipt|收据
ใบกำกับภาษี|Tax invoice|税务发票
หนังสือรับรอง 50 ทวิ|WHT certificate (50 Tawi)|预扣税证明 (50 Tawi)
หนังสือรับรองการหักภาษี ณ ที่จ่าย|Withholding tax certificate|预扣税证明
หัก ณ ที่จ่าย|Withholding tax|预扣税
ทั้งหมด|All|全部
ตัวกรอง|Filters|筛选
ล้างทั้งหมด|Clear all|全部清除
ล้างตัวกรอง|Clear filters|清除筛选
มุมมอง|View|视图
ของฉันวันนี้|My day|我的今日
ทั้งทีม|Whole team|全团队
การกระทำ|Actions|操作
คอลัมน์|Columns|列
ตัวเลือก|Options|选项
แสดง|Show|显示
ต่อหน้า|per page|每页
ส่งออก CSV|Export CSV|导出 CSV
ส่งออก Excel|Export Excel|导出 Excel
ส่งออกให้นักบัญชี|Export for accountant|导出给会计
ส่งออกรายงาน|Export report|导出报表
ส่งออก|Export|导出
นำเข้า Excel|Import Excel|导入 Excel
นำเข้า CSV|Import CSV|导入 CSV
ดูรายละเอียด|View details|查看详情
รายละเอียด|Details|详情
ไทม์ไลน์|Timeline|时间线
เอกสาร|Documents|文件
บันทึกระบบ|System log|系统日志
สรุป|Summary|摘要
ปิดหน้าต่าง|Close|关闭
ปิด|Close|关闭
บันทึก|Save|保存
แก้ไข|Edit|编辑
ลบ|Delete|删除
ย้อนกลับ|Back|返回
ถัดไป|Next|下一步
ยืนยัน|Confirm|确认
อนุมัติ|Approve|审批
ส่งอนุมัติ|Submit for approval|提交审批
ส่งขออนุมัติ|Request approval|申请审批
ขออนุมัติแก้|Request correction|申请更正
พิมพ์ PDF|Print PDF|打印 PDF
พิมพ์ตัวอย่าง|Print preview|打印预览
พิมพ์ใบส่งของ|Print delivery order|打印送货单
พิมพ์ใบคุมรถ|Print trip sheet|打印派车单
พิมพ์ใบสำคัญจ่าย|Print payment voucher|打印付款凭证
พิมพ์ใบเบิก|Print advance slip|打印预支单
ใบสำคัญจ่าย|Payment voucher|付款凭证
สร้าง SO ใหม่|New SO|新建 SO
สร้าง SO|New SO|新建 SO
สร้างใบวางบิล|Create billing note|创建账单通知
เปิดกระดานวางแผน|Open planning board|打开调度看板
เสนอรถ|Suggest vehicle|推荐车辆
จัดรถตามคำแนะนำ|Assign recommended|按推荐派车
จัดรถ|Assign vehicle|派车
ส่งต่อรถร่วม|Send to subcontractor|转外包
ยกเลิก SO|Cancel SO|取消 SO
จับคู่ลูกค้า|Match customer|匹配客户
ยืนยันส่งแล้ว|Confirm delivered|确认已送达
ปล่อยงานให้คนขับ|Release to driver|下发给司机
ปล่อยเที่ยว|Release trip|下发车次
ออกเอกสาร|Issue document|开具单据
ยกเลิกร่าง|Void draft|作废草稿
บันทึกรับชำระ|Record payment|登记收款
ออกใบลด/เพิ่มหนี้|Issue credit/debit note|开具贷/借项单
ออกใบลดหนี้ / เพิ่มหนี้|Issue credit/debit note|开具贷/借项单
ออกใบลดหนี้|Issue credit note|开具贷项单
ออกใบเพิ่มหนี้|Issue debit note|开具借项单
บันทึกจ่าย|Record payment|登记付款
เคลียร์ค่าใช้จ่าย|Clear expenses|核销费用
อนุมัติเคลียร์|Approve clearing|批准核销
บันทึกเบิกเงิน|New advance|新建预支
ส่งผ่าน LINE|Send via LINE|通过 LINE 发送
คัดลอกลิงก์|Copy link|复制链接
ใช้ค่า TMS ส่งซ้ำ|Resend with TMS values|以 TMS 数据重发
ส่งซ้ำหลายรายการ|Resend selected|批量重发
ส่งซ้ำทั้งหมดที่รอ|Resend all pending|重发全部待处理
ส่งซ้ำ|Resend|重发
ลองใหม่|Retry|重试
ดู log|View log|查看日志
ทดสอบ|Test|测试
ตัดการเชื่อมต่อ|Disconnect|断开连接
ตั้งเวลาส่งรายงาน|Schedule reports|定时发送报表
ดูใบแจ้งหนี้|View invoice|查看发票
ส่งใบแจ้งเตือนชำระ|Send payment reminder|发送付款提醒
เลข SO|SO No.|SO 编号
เลข DO|DO No.|DO 编号
เลข SA|SA No.|SA 编号
เลขเที่ยว|Trip No.|车次编号
เลขเอกสาร|Document No.|单据编号
เลขใบแจ้งหนี้|Invoice No.|发票编号
เลขที่เบิก|Advance No.|预支编号
เลข SO / DO|SO / DO No.|SO / DO 编号
เส้นทางหลัก|Main route|主线路
เส้นทาง|Route|路线
น้ำหนัก (กก.)|Weight (kg)|重量 (公斤)
น้ำหนัก / เที่ยว|Weight / trips|重量 / 车次
น้ำหนักรวม (กก.)|Total weight (kg)|总重量 (公斤)
น้ำหนักบรรทุก|Payload|载重
น้ำหนัก|Weight|重量
กำหนดส่ง|Due|交付期限
เหตุผล / สถานะ|Reason / status|原因 / 状态
สถานะ|Status|状态
ที่มา|Source|来源
รถ / คนขับ|Vehicle / driver|车辆 / 司机
รถ / หาง|Vehicle / trailer|车辆 / 挂车
คนขับ / สังกัด|Driver / affiliation|司机 / 所属
วันที่ส่ง|Delivery date|送货日期
วันที่เบิก|Advance date|预支日期
วันที่|Date|日期
สินค้า|Goods|货物
ประเภทรถ|Vehicle type|车型
ประเภท|Type|类型
ผู้รับเหมา / คนขับ|Subcontractor / driver|外包商 / 司机
ผู้รับเหมา|Subcontractor|外包商
งวด / อ้างอิง|Period / ref|期间 / 参考
งวด|Period|期间
ครบกำหนด|Due date|到期日
ยอดสุทธิ (฿)|Net (฿)|净额 (฿)
คงค้าง (฿)|Outstanding (฿)|未付 (฿)
รับแล้ว (฿)|Received (฿)|已收 (฿)
ยอดซื้อ (฿)|Purchase (฿)|采购额 (฿)
หัก (฿)|Deductions (฿)|扣除 (฿)
สุทธิ (฿)|Net (฿)|净额 (฿)
ราคาซื้อ (฿)|Buy price (฿)|采购价 (฿)
รายได้ (฿)|Revenue (฿)|收入 (฿)
ค่าเที่ยว (฿)|Trip fee (฿)|运费 (฿)
เบิก (฿)|Advance (฿)|预支 (฿)
ใช้จริง (฿)|Actual (฿)|实际 (฿)
คืน / จ่ายเพิ่ม (฿)|Refund / top-up (฿)|退还 / 补付 (฿)
ระบบบัญชี|Accounting system|财务系统
ฟิลด์ที่ต่าง|Differing fields|差异字段
ครั้งที่ส่ง|Attempts|发送次数
ส่งล่าสุด|Last sent|最近发送
ส่งข้อเสนอเมื่อ|Offer sent|报价发送于
หมดเวลาใน|Expires in|剩余时间
จุด / DO|Stops / DO|站点 / DO
การแก้ไข|Edits|修改
เที่ยว|Trips|车次
รหัส|Code|代码
ชื่อ|Name|名称
เลขผู้เสียภาษี / สาขา|Tax ID / branch|税号 / 分支
เลขผู้เสียภาษี|Tax ID|税号
เครดิต|Credit|信用期
รอบวางบิล|Billing cycle|账单周期
ยอดค้าง (฿)|Outstanding (฿)|未付 (฿)
ทะเบียน|Plate|车牌
เจ้าของ|Owner|车主
ประกัน / ภาษี / พรบ.|Insurance / tax / CMI|保险 / 车税 / 强制险
เบอร์|Phone|电话
ใบขับขี่|License|驾照
รถประจำ|Assigned vehicle|固定车辆
สังกัด|Affiliation|所属
จำนวนรถ|Vehicles|车辆数
ตรงเวลา|On time|准时
ตีกลับ|Returns|退回
สูตร|Formula|计价方式
ราคา (฿)|Price (฿)|价格 (฿)
ค่าเพิ่มต่อจุด (฿)|Extra per stop (฿)|每站附加 (฿)
มีผล ตั้งแต่ – ถึง|Valid from – to|有效期
ต้องทำวันนี้|To do today|今日待办
ส่งสำเร็จ 7 วัน|Deliveries, last 7 days|近 7 天送达
ลูกหนี้ค้างชำระ|Receivables outstanding|应收未付
ไปหน้ารับชำระ|Go to receipts|前往收款
อายุลูกหนี้|Receivables aging|账龄
ยังไม่ครบกำหนด|Not yet due|未到期
เกิน 90 วัน|Over 90 days|超过 90 天
ค้างรับ|Outstanding|待收
ยอดค้างรับ (฿)|Outstanding (฿)|待收 (฿)
เกินกำหนด (฿)|Overdue (฿)|逾期 (฿)
รับชำระเดือนนี้ (฿)|Received this month (฿)|本月收款 (฿)
ครบกำหนดใน 7 วัน|Due in 7 days|7 天内到期
DO รอวางบิล|DO to bill|待开票 DO
ใบแจ้งหนี้ร่าง|Draft invoices|草稿发票
ยอดค้างชำระ (฿)|Outstanding (฿)|未付 (฿)
สร้างใบวางบิล|Create billing|创建账单
เลือกลูกค้าและงวด|Customer & period|选择客户与期间
ติ๊ก DO|Select DO|勾选 DO
ตรวจ|Review|审核
ช่วงวันที่ส่ง|Delivery period|送货期间
รหัสลูกค้า|Customer code|客户代码
เอกสารที่จะออก|Documents to issue|将开具单据
ค่าขนส่ง (ยกเว้น VAT)|Freight (VAT exempt)|运费 (免增值税)
ค่าขนส่ง/หน่วย|Freight / unit|运费 / 单位
ค่าขนส่ง|Freight|运费
บริการประกอบ|Ancillary services|附加服务
VAT 7% บริการประกอบ|VAT 7% on ancillary|附加服务增值税 7%
VAT 7% ทุกรายการ|VAT 7% on all|全部增值税 7%
สุทธิ|Net|净额
ยอด (฿)|Amount (฿)|金额 (฿)
จำนวน|Qty|数量
รถทั้งหมด|All vehicles|全部车辆
คนขับ|Driver|司机
รถ|Vehicle|车辆
หาง|Trailer|挂车
SO รอจัด|SO to plan|待调度 SO
รถว่างวันนี้|Free vehicles today|今日空闲车辆
กม.รวม|Total km|总公里
วันนี้|Today|今天
พรุ่งนี้|Tomorrow|明天
7 วัน|7 days|7 天
DO รอเข้าเที่ยว|DO awaiting trip|待装车 DO
เที่ยวใหม่|New trip|新车次
ใช้รถร่วม|Using subcontractor|使用外包
จุดรับ / ส่ง ตามลำดับ|Pickup / drop sequence|装卸顺序
ความคืบหน้าเที่ยว|Trip progress|车次进度
รับสินค้า|Pickup|提货
ส่งสินค้า|Drop-off|送货
รับ|Pickup|提货
ส่ง|Drop|送货
ยอดที่รถร่วมเรียก|Amount claimed|外包申报金额
ยอดอนุมัติ|Approved amount|核准金额
POD ครบ|POD complete|签收单齐全
ราคาตรง rate card|Price matches rate card|价格符合费率表
ค่าใช้จ่ายหน้างานมีหลักฐาน|Site expenses evidenced|现场费用有凭证
หักเงินเบิก / หัก ณ ที่จ่าย|Advances / withholding|预支 / 预扣
เทียบ SO · DO · เที่ยว · ใบแจ้งหนี้รถร่วม|Match SO · DO · trip · sub invoice|核对 SO · DO · 车次 · 外包发票
ยืนยันหลักฐาน|Confirm evidence|确认凭证
ได้รับแล้ว|Received|已收到
ตรวจแล้ว|Checked|已核对
เปรียบเทียบตัวเลือกรถ|Compare vehicle options|比较车辆选项
เงื่อนไขงาน|Job conditions|任务条件
รถบริษัท|Company vehicle|自有车辆
รถร่วมประจำ|Regular subcontractor|固定外包
รถร่วมอื่น|Other subcontractor|其他外包
แนะนำ|Recommended|推荐
ต้นทุน|Cost|成本
ความจุ|Capacity|容量
เลือก|Select|选择
กำไรต่อเที่ยว|Profit per trip|每车次利润
กำไรต่อลูกค้า|Profit per customer|每客户利润
กำไรต่อรถ|Profit per vehicle|每车利润
ลูกหนี้คงค้าง|Receivables|应收账款
ต้นทุนรถร่วม|Subcontract cost|外包成本
กำไร|Profit|利润
ต้นทุนประเมิน|Est. cost|预估成本
รายได้|Revenue|收入
ยอดซื้อ|Purchases|采购额
เฉลี่ย / เที่ยว|Avg / trip|平均 / 车次
รวม|Total|合计
ค่าใช้จ่ายระหว่างเที่ยว|Trip expenses|途中费用
เพิ่มรายการ|Add line|添加项目
มีใบเสร็จ|Has receipt|有收据
ไม่มีใบเสร็จ|No receipt|无收据
ยอดเบิก|Advance|预支
คนขับคืนเงิน|Driver refunds|司机退还
จ่ายเพิ่มให้คนขับ|Top up driver|补付司机
ยอดเบิกค้าง (฿)|Open advances (฿)|未核销预支 (฿)
บันทึกตารางส่ง|Save schedule|保存计划
รายงานที่ส่ง|Reports to send|发送报表
รอบการส่ง|Frequency|频率
ช่องทาง|Channels|渠道
ผู้รับ|Recipients|收件人
อีเมล|Email|电子邮件
ทั่วไป|General|常规
ที่อยู่ส่ง|Delivery addresses|收货地址
รหัสระบบบัญชี|Accounting codes|财务代码
เงื่อนไข|Terms|条款
องค์กร|Organization|组织
นิติบุคคลและสาขา|Entities & branches|法人与分支
เลขที่เอกสาร|Document numbering|单据编号
ผู้ใช้และสิทธิ์|Users & permissions|用户与权限
ภาษี|Tax|税务
การเชื่อมต่อ|Integrations|集成
การแจ้งเตือน|Notifications|通知
เหตุผล|Reasons|原因
ความปลอดภัย|Security|安全
เชิญผู้ใช้|Invite user|邀请用户
ผู้ใช้|Users|用户
สิทธิ์ตามบทบาท|Role-based access|按角色授权
การเชื่อมต่ออื่น|Other integrations|其他集成
บันทึกการซิงก์|Sync log|同步日志
การจับคู่และเลขเอกสาร|Mapping & numbering|映射与编号
ดู payload|View payload|查看 payload
วันที่เริ่มซิงก์|Sync start date|同步开始日期
ใครออกเลขเอกสาร|Who issues document numbers|由谁生成单据编号
รอบวางบิล|Billing cycle|账单周期
ต่อเที่ยว|Per trip|按车次
รายสัปดาห์|Weekly|每周
รายเดือน|Monthly|每月
เหมาเที่ยว|Per trip (flat)|按趟包价
ต่อกม.|Per km|按公里
ต่อตัน|Per ton|按吨
เหมาวัน|Per day (flat)|按天包价
ขาขาย · ลูกค้า|Sell · customers|销售 · 客户
ขาซื้อ · รถร่วม|Buy · subcontractors|采购 · 外包
ไม่พบรายการ|No results|无结果
ไม่พบ|Not found|未找到
ไม่มีข้อมูล|No data|无数据
งานวันนี้ทั้งหมด|All jobs today|今日全部任务
สวัสดี|Hello|你好
งานวันนี้|Today's jobs|今日任务
ความคืบหน้า|Progress|进度
แจ้งปัญหา|Report a problem|报告问题
โทรหาผู้จ่ายงาน|Call dispatcher|致电调度员
นำทาง|Navigate|导航
อยู่ในระยะจุด|Within geofence|在围栏范围内
อยู่นอกระยะจุด|Outside geofence|在围栏范围外
จำลองระยะ|Simulate distance|模拟距离
ถึงจุดรับ|Arrived at pickup|到达提货点
ถึงจุดส่ง|Arrived at drop|到达送货点
ออกจากจุด|Depart stop|离开站点
ถ่ายรูปและเซ็นรับ (POD)|Photo & signature (POD)|拍照签收 (POD)
หลักฐานการส่ง (POD)|Proof of delivery (POD)|送达凭证 (POD)
รูปถ่าย|Photos|照片
จำนวนที่ส่งจริง|Quantity delivered|实际送达数量
ลายเซ็นผู้รับ|Recipient signature|收货人签名
ชื่อผู้รับ|Recipient name|收货人姓名
บังคับ|Required|必填
ไม่บังคับ|Optional|选填
ถ่ายรูป|Take photo|拍照
เกิดอะไรขึ้น|What happened?|发生了什么？
รูปประกอบ|Photos|照片
รายละเอียดเพิ่มเติม|More details|更多细节
ส่งแจ้งปัญหา|Send report|提交报告
ยืนยันถึงจุด|Confirm arrival|确认到达
รถเสีย|Breakdown|车辆故障
อุบัติเหตุ|Accident|事故
ลูกค้าปิดทำการ|Customer closed|客户已关门
สินค้าเสียหาย|Goods damaged|货物损坏
รถติดหนัก|Heavy traffic|严重拥堵
อื่น ๆ|Other|其他
ออฟไลน์|Offline|离线
ออนไลน์|Online|在线
รอส่ง|Queued|待发送
ลองส่ง|Try sending|尝试发送
ส่งครบทุกจุดแล้ว|All stops completed|全部站点已完成
รอรับงาน|Awaiting acceptance|待接单
กำลังทำ|In progress|进行中
เสร็จแล้ว|Done|已完成
พอร์ทัลรถร่วม|Subcontractor portal|外包门户
งาน|Jobs|任务
ส่ง POD|Submit POD|提交 POD
การเงิน|Finance|财务
ใบสั่งงาน|Work order|工作单
ราคาจ้าง|Contract price|承运价
ยืนยันรับงาน|Confirm acceptance|确认接单
ยืนยันปฏิเสธ|Confirm decline|确认拒绝
ข้อมูลรถที่จะมารับงาน|Vehicle for this job|执行车辆信息
ทะเบียนรถ|License plate|车牌
ชื่อคนขับ|Driver name|司机姓名
เบอร์คนขับ|Driver phone|司机电话
เหตุผลที่ปฏิเสธ|Reason for declining|拒绝原因
อัปโหลดหลักฐานการส่ง|Upload proof of delivery|上传送达凭证
รอรับเงิน|Awaiting payment|待收款
ใบจ่ายเงิน|Payment slip|付款单
หนังสือ 50 ทวิ|WHT certificate|预扣税证明
ติดตามพัสดุ|Track shipment|追踪货件
ติดตามการจัดส่ง|Track delivery|追踪配送
เวลาถึงโดยประมาณ|Estimated arrival|预计到达
คนขับ|Driver|司机
ม.ค.|Jan|1月
ก.พ.|Feb|2月
มี.ค.|Mar|3月
เม.ย.|Apr|4月
พ.ค.|May|5月
มิ.ย.|Jun|6月
ก.ค.|Jul|7月
ส.ค.|Aug|8月
ก.ย.|Sep|9月
ต.ค.|Oct|10月
พ.ย.|Nov|11月
ธ.ค.|Dec|12月
ทางลัด|Shortcut|快捷键
งานปฏิบัติการประจำวันที่|Operations for|运营日期
หลังจากนั้น|Later|之后
ยังไม่จัดรถ|Not assigned|未派车
ยังไม่กำหนดคนขับ|No driver assigned|未指定司机
แถว|rows|行
รายการ|items|项
จุด|stops|个站点
วัน|days|天
คัน|vehicles|辆
ใบ|docs|张
หน่วย|units|件
ร้านยาง|Tyre shop|轮胎店
เพิ่มยาง · รับเข้าสต็อก|Add tyres · receive to stock|新增轮胎 · 入库
ยางใหม่จะขึ้นในสถานะ "สต็อก" พร้อมเลขยางรายเส้น|New tyres appear as "In stock" with individual tyre numbers|新轮胎以"库存"状态显示并附单条编号
ยี่ห้อ|Brand|品牌
ขนาด|Size|尺寸
จำนวน (เส้น)|Quantity (tyres)|数量(条)
รับเข้าได้ครั้งละไม่เกิน 20 เส้น|Max 20 tyres per receipt|每次最多入库 20 条
ราคาต่อเส้น (฿)|Price per tyre (฿)|单价 (฿)
DOT / สัปดาห์ผลิต|DOT / production week|DOT / 生产周
รับเข้าสต็อก|Receive to stock|入库
คลังยาง|Tyre store|轮胎仓
รับเข้าสต็อกจาก|Received from|入库自
ไม่มียางในสต็อก · เพิ่มยางก่อน|No tyres in stock · add tyres first|库存无轮胎 · 请先新增
ติดตั้งยางบนรถ|Install tyre on vehicle|安装轮胎到车辆
ยางจากสต็อก|Tyre from stock|库存轮胎
หน้าซ้าย|Front left|左前
หน้าขวา|Front right|右前
หลังซ้ายนอก|Rear left outer|左后外
หลังซ้ายใน|Rear left inner|左后内
หลังขวาใน|Rear right inner|右后内
หลังขวานอก|Rear right outer|右后外
เลขไมล์ขณะติดตั้ง|Odometer at install|安装时里程
ถอดออกเพื่อติดตั้ง|Removed for install|拆下以安装
ถอดไปที่|Remove to|拆下去向
เก็บเข้าสต็อก|Return to stock|退回库存
ส่งหล่อดอก|Send for retread|送翻新
ทิ้ง (หมดสภาพ)|Scrap (worn out)|报废
ความลึกดอกขณะถอด (มม.)|Tread at removal (mm)|拆下时花纹深度 (mm)
ถอดยาง|Remove tyre|拆胎
บันทึกใบสั่ง / ค่าปรับ|Record ticket / fine|记录罚单
ระบบจับคู่คนขับจากเที่ยวรถ ณ เวลาที่ถูกปรับ|Driver is matched from the trip at the time of the fine|系统按罚单时间匹配行程司机
คนขับ (จับคู่อัตโนมัติ)|Driver (auto-matched)|司机(自动匹配)
รูปแบบเวลา 08:42|Time format 08:42|时间格式 08:42
ฝ่าไฟแดง|Red light|闯红灯
จำนวนเงิน (฿)|Amount (฿)|金额 (฿)
สถานที่ / รายละเอียด|Location / details|地点 / 详情
ชำระภายใน (วัน)|Pay within (days)|付款期限(天)
ไม่ได้วิ่งงาน|Not on a job|未在作业
ใช้กับรถที่คนขับไม่มีแอป · บันทึกชื่อผู้บันทึกแทนในประวัติ|For drivers without the app · your name is logged as recorder|用于无 App 的司机 · 记录代填人
ผลตรวจ|Result|检查结果
ข้อวิกฤต (เบรก ยาง ไฟ)|Critical items (brakes, tyres, lights)|关键项(刹车、轮胎、灯)
มีข้อวิกฤต · ห้ามออกรถ|Critical defect · do not dispatch|有关键缺陷 · 禁止出车
ข้อบกพร่องที่พบ|Defects found|发现的缺陷
เช่น ยางหลังซ้ายนอกบวม, ไฟเลี้ยวขวาไม่ติด|e.g. rear-left outer tyre bulge, right indicator out|例:左后外胎鼓包、右转向灯不亮
รูปข้อบกพร่อง|Defect photos|缺陷照片
บันทึกผลตรวจ|Save inspection|保存检查
ห้ามออกรถ แจ้งฝ่ายจัดรถแล้ว|do not dispatch, dispatch notified|禁止出车,已通知调度
ร้านอะไหล่|Parts shop|配件店
ชื่ออะไหล่|Part name|配件名称
มีอะไหล่ชื่อนี้แล้ว|A part with this name already exists|已有同名配件
คงเหลือเริ่มต้น|Opening quantity|期初数量
จุดสั่งซื้อ|Reorder point|再订货点
ต้นทุนต่อหน่วย (฿)|Unit cost (฿)|单位成本 (฿)
ผู้ขายหลัก|Main vendor|主要供应商
ยอดยกมา|Opening balance|期初余额
รับอะไหล่เข้า|Receive parts|配件入库
เบิกอะไหล่ออก|Issue parts|配件领用
คงเหลือไม่พอ (มี|Not enough stock (have|库存不足(现有
เลข PO / ใบกำกับ|PO / invoice no.|采购单 / 发票号
เกินความจุถัง 20,000 ลิตร (คงเหลือ|Exceeds 20,000 L tank capacity (balance|超出 20,000 升油罐容量(余量
฿ / ลิตร|฿ / L|฿ / 升
เลขใบกำกับ|Invoice no.|发票号
น้ำมันในถังไม่พอ (คงเหลือ|Not enough fuel in tank (balance|油罐油量不足(余量
บันทึกวัดยอดถัง|Record tank dip|记录油罐测量
ปริมาณที่วัดได้ (ลิตร)|Measured volume (L)|实测量(升)
ยอดตามระบบ|System balance|系统余额
คงเหลือตามระบบ|System balance|系统余额
วัดถัง|Tank dip|油罐测量
รับเข้าถัง|Tank receipt|油罐入库
จ่ายน้ำมันให้|Fuel issued to|发油给
ทะเบียนหาง|Trailer plate|挂车车牌
มีทะเบียนนี้แล้ว|This plate already exists|车牌已存在
หางพ่วง 2 เพลา|2-axle trailer|2 轴挂车
หางลาก 3 เพลา|3-axle semi-trailer|3 轴半挂车
หางพ่วงคอก|Stake trailer|栏板挂车
หางตู้|Box trailer|厢式挂车
ปี (ค.ศ.)|Year (AD)|年份(公元)
ปีไม่ถูกต้อง|Invalid year|年份无效
ภาษีหมดอายุอีก (วัน)|Tax expires in (days)|税到期(天)
ประกันหมดอายุอีก (วัน)|Insurance expires in (days)|保险到期(天)
ตรวจเบรกหาง|Trailer brake check|挂车刹车检查
พ่วง / ปลดหาง|Couple / uncouple trailer|挂接 / 解挂
หัวลาก|Tractor|牵引车
หัวลากนี้พ่วง|This tractor is coupled to|该牵引车已挂
ไม่ได้พ่วงอยู่|Not coupled|未挂接
ปลดก่อน|uncouple first|请先解挂
เพิ่มผู้ขาย / อู่ซ่อม|Add vendor / garage|新增供应商 / 修理厂
มีผู้ขายชื่อนี้แล้ว|A vendor with this name already exists|已有同名供应商
ต้องเป็นตัวเลข 13 หลัก|Must be 13 digits|须为 13 位数字
เครดิต (วัน)|Credit (days)|账期(天)
ราคาตกลง / หมายเหตุ|Agreed price / notes|约定价格 / 备注
เลือกรถก่อนเพื่อดึงตำแหน่ง GPS|Select a vehicle first to get its GPS position|请先选择车辆以获取 GPS 位置
ลานจอดบริษัท บางนา|Company yard, Bang Na|公司停车场 Bang Na
ยืนยันสัญญาณเหตุเป็นเคสอุบัติเหตุ|Confirm signal as accident case|确认信号为事故案件
บันทึกเคสด้วยตนเอง · คนขับแจ้งจากแอปได้เช่นกัน|Manual case · drivers can also report from the app|手动登记 · 司机也可在 App 上报
ก. เหตุการณ์|A. Incident|A. 事件
พิมพ์ชื่อสถานที่ แตะแผนที่เพื่อปักหมุด หรือใช้ GPS ของรถ|Type a place, tap the map to drop a pin, or use vehicle GPS|输入地点、点击地图标记或使用车辆 GPS
ค้นหาสถานที่ หรือใช้ตำแหน่ง GPS ของรถ|Search a place or use vehicle GPS|搜索地点或使用车辆 GPS
ชนรถ|Vehicle collision|撞车
ชนทรัพย์สิน|Property damage|撞物
พลิกคว่ำ|Rollover|翻车
ความรุนแรง|Severity|严重程度
เล็กน้อย|Minor|轻微
ปานกลาง|Moderate|中等
รุนแรง|Severe|严重
มีผู้บาดเจ็บ|Injuries|有人受伤
คำอธิบาย|Description|描述
เกิดอะไรขึ้น ความเสียหายที่เห็น|What happened, visible damage|发生了什么,可见损伤
อธิบายอย่างน้อย 10 ตัวอักษร|Describe in at least 10 characters|至少 10 个字符
ข. รถและคน|B. Vehicle and people|B. 车辆与人员
รถ (ทะเบียน)|Vehicle (plate)|车辆(车牌)
เลือกรถแล้วระบบเติมคนขับและเที่ยวที่วิ่งอยู่ ณ เวลานั้นให้ แก้ได้|Selecting a vehicle fills the driver and trip at that time; editable|选择车辆后自动填入当时司机与行程,可修改
เที่ยวรถ / DO|Trip / DO|行程 / DO
ค. คู่กรณี|C. Other parties|C. 对方
คู่กรณี|Other party|对方
คู่กรณีรายที่|Party|对方
เลขแจ้งความ|Police report no.|报案号
เช่น 2611/0457|e.g. 2611/0457|例:2611/0457
สถานีตำรวจ|Police station|警局
ง. หลักฐาน|D. Evidence|D. 证据
รูปที่เกิดเหตุ|Scene photos|现场照片
อย่างน้อย 2 รูป · มุมกว้างและจุดเสียหาย|At least 2 photos · wide shot and damage|至少 2 张 · 全景和损伤处
ใบแจ้งความ|Police report|报案单
ใบเคลมจากหน้างาน|On-site claim form|现场理赔单
รอสรุป|Pending|待结论
ประกันเรา|Our insurer|我方保险
ประกันคู่กรณี|Other party's insurer|对方保险
ประกันสินค้า|Cargo insurance|货物保险
ประเภทเคลม|Claim type|理赔类型
เคสนี้ยื่นเคลมประเภทนี้แล้ว|A claim of this type was already filed|该类型理赔已提交
บริษัทประกัน|Insurer|保险公司
ดึงจากเอกสารประกันภัยของ|Pulled from insurance document of|取自保险单
ดึงจากข้อมูลคู่กรณีในเคส|Pulled from the other party in this case|取自案件对方信息
เลขกรมธรรม์|Policy no.|保单号
เลขเคลม|Claim no.|理赔号
ใส่เมื่อได้รับจากประกัน|Enter when received from insurer|收到后填写
วันยื่น|Filed on|提交日期
ยอดเรียกร้อง (฿)|Claim amount (฿)|索赔金额 (฿)
ค่าเสียหายส่วนแรก (฿)|Deductible (฿)|免赔额 (฿)
ใบเคลม ใบเสนอราคาอู่ รูปความเสียหาย|Claim form, garage quote, damage photos|理赔单、修理报价、损伤照片
ยื่นแล้ว|Filed|已提交
ยอดอนุมัติ (฿)|Approved amount (฿)|批准金额 (฿)
เกินยอดเรียกร้อง ฿|Exceeds claim amount ฿|超出索赔金额 ฿
วันที่รับเงิน|Payment date|收款日期
ยอดที่ได้รับ (฿)|Amount received (฿)|收到金额 (฿)
เลขอ้างอิงการโอน|Transfer reference|转账参考号
รับเงินแล้ว|Paid|已收款
บันทึกรับเงินเคลม|Record claim payment|记录理赔收款
ประกันปฏิเสธ|Insurer declined|保险拒赔
ระบุเหตุผลอย่างน้อย 5 ตัวอักษร|Give a reason of at least 5 characters|理由至少 5 个字符
ถูกปฏิเสธ · บันทึกเหตุผลแล้ว|Declined · reason recorded|已拒赔 · 理由已记录
ยังมีเคลมค้าง|Claims still open|仍有未结理赔
ปิดเคสไม่ได้|cannot close case|无法结案
เปิดใบสั่งซ่อมใหม่|Open new work order|新建维修单
ปิดเคส|Close case|结案
บันทึกสรุป|Save summary|保存结论
สรุปผลเคส|Case summary|案件结论
ฝ่ายผิด|At fault|过错方
ฝ่ายเราผิด|Our fault|我方过错
คู่กรณีผิด|Other party at fault|对方过错
ประมาทร่วม|Shared fault|双方过失
ไม่มีฝ่ายผิด|No fault|无过错
หักคนขับ (฿)|Driver deduction (฿)|司机扣款 (฿)
ส่งไปที่|Send to|发送至
ไม่ต้องซ่อม|No repair needed|无需维修
บันทึกและปิดเคส|Save and close case|保存并结案
จับคู่จาก|Matched from|匹配自
ยังไม่เลือก|Not selected|未选择
วันเวลา|Date and time|日期时间
กำหนดชำระ|Due|到期
ผู้รับผิดชอบ|Responsible|责任方
นำเข้าไฟล์ใบสั่ง|Import ticket file|导入罚单文件
เลือกใบสั่งที่รอชำระ|Select unpaid tickets|选择待付罚单
บันทึกบริษัทจ่าย|Record company paid|记录公司支付
บันทึกเคส |Saved case |已保存案件 
เลือกวันที่|Select date|选择日期
— เลือก —|— Select —|— 请选择 —
ต้องมีอย่างน้อย|minimum|至少
แนบอย่างน้อย|Attach at least|至少附加
กรอกตัวเลขมากกว่า 0|Enter a number greater than 0|请输入大于 0 的数字
กรุณากรอก|Please enter |请填写
กรอกชื่อและเบอร์คู่กรณีรายที่|Enter name and phone of party|请填写对方姓名和电话 第
กรอกข้อมูลให้ครบ|Complete the required fields:|请填写完整:
สัญญาณรอยืนยัน|Signals to confirm|待确认信号
ยืนยันเป็นเคส|Confirm as case|确认为案件
ยกเลิกสัญญาณ|Dismiss signal|忽略信号
บันทึกว่าไม่ใช่อุบัติเหตุ|recorded as not an accident|已记录为非事故
เคสใหม่จากแอปคนขับ|New case from driver app|来自司机 App 的新案件
แจ้งเตือนฝ่ายจัดรถแล้ว|dispatch notified|已通知调度
ปักหมุด|Pinned|已标记
เหตุผลยกเลิก|Cancellation reason|取消理由
บันทึกเพิ่มเติมสำหรับทีม|Add a note for the team|给团队的备注
สร้างร่างใหม่จาก|Create new draft from|基于…新建草稿
สร้างใบใหม่|Create document|创建单据
บันทึกการแก้ไข|Save changes|保存修改
สร้างจากสำเนา|Created as copy of|复制自
ไม่มีการเปลี่ยนแปลง|No changes|无修改
เอกสารจะยังอยู่ในระบบพร้อมเหตุผล และย้อนกลับไม่ได้|The document stays in the system with the reason and cannot be undone|单据将保留并记录理由,且无法撤销
ยืนยันยกเลิก|Confirm cancellation|确认取消
ยังไม่มีแบบพิมพ์ A4 สำหรับ|No A4 print template yet for |暂无 A4 打印模板:
ยอดเงิน|Amounts|金额
ยกเว้น VAT|VAT exempt|免增值税
ฐาน VAT 7%|VAT 7% base|7% 增值税基数
ตามการตั้งค่าลูกค้า|Per customer settings|按客户设置
ค่าขนส่งยกเว้น VAT · บริการประกอบ VAT 7%|Freight VAT-exempt · ancillary services VAT 7%|运费免税 · 附加服务 7% 增值税
บริการประกอบ (ขึ้น / ลงสินค้า ค่ารอ)|Ancillary services (loading, waiting)|附加服务(装卸、等待)
ค่ารอ (บริการ)|Waiting (service)|等待费(服务)
ค่าขึ้น / ลงสินค้า (บริการ)|Loading / unloading (service)|装卸费(服务)
รายการ DO|DO lines|DO 明细
รายการเที่ยว|Trips|行程明细
และอีก|and|另有
เวลาชนกัน|Time conflict|时间冲突
เลือกคนขับ|Choose driver|选择司机
ต้องใช้ใบขับขี่|requires licence|需要驾照
ค้นหาชื่อคนขับ|Search driver name|搜索司机姓名
ไม่พบคนขับ|No drivers found|未找到司机
ใบขับขี่หมดอายุ|Licence expired|驾照过期
ประจำ|Assigned to|固定于
เปิดใบสั่งขนส่ง|Open sales order|打开运输单
รถติดกฎห้ามจ่ายงาน · ต้องย้ายรถ|Vehicle blocked from dispatch · reassign|车辆禁止派车 · 需换车
ไม่ได้|not possible|无法
ให้ |to |给 
ประเภทเอกสาร|Document type|单据类型
บริษัท / หน่วยงาน|Company / agency|公司 / 机构
เริ่ม – หมด|Start – expiry|开始 – 到期
เบี้ย / ค่าใช้จ่าย (฿)|Premium / cost (฿)|保费 / 费用 (฿)
ไฟล์แนบ|Attachments|附件
ค่าซ่อมเดือนนี้|Repair cost this month|本月维修费
เลข WO|WO no.|维修单号
แจ้งเสีย|Breakdown|报修
อาการ / งาน|Symptom / job|故障 / 作业
วันเข้า – ออก|In – out|进厂 – 出厂
ค่าใช้จ่าย (฿)|Cost (฿)|费用 (฿)
ผู้อนุมัติ|Approver|审批人
พิมพ์ใบสั่งซ่อม|Print work order|打印维修单
ปั๊ม / ผู้ขาย|Station / vendor|加油站 / 供应商
บาท / ลิตร|฿ / L|฿ / 升
รวม (฿)|Total (฿)|合计 (฿)
บัตรฟลีท|Fleet card|车队卡
ขั้นตอนเคส|Case steps|案件步骤
ประเภท / ความรุนแรง|Type / severity|类型 / 严重度
เที่ยว / DO|Trip / DO|行程 / DO
ยื่นเคลมเพิ่ม|File another claim|追加理赔
ยังไม่ยื่นเคลม|No claim filed|未提交理赔
ยอดเรียกร้องรวม|Total claimed|索赔合计
ต้นทุนเฉลี่ย|Average cost|平均成本
ยอดในระบบ|System|系统量
วัดได้จริง|Measured|实测
ราคา / ลิตร|Price / L|单价 / 升
มูลค่า|Value|金额
ยี่ห้อ / ปี|Brand / year|品牌 / 年份
ไม่ได้พ่วง|Not coupled|未挂接
ระยะสะสม|Accumulated distance|累计里程
ภาษีหมดอายุ|Tax expiry|税到期
ประกันหมดอายุ|Insurance expiry|保险到期
PM ถัดไป|Next PM|下次保养
ไม่มีหัวลากว่าง|No free tractor|无空闲牵引车
เครดิตเทอม|Credit term|账期
ราคาประจำ|Standard price|标准价格
ระยะเวลาซ่อมเฉลี่ย|Average repair time|平均维修时长
ยอดซื้อปีนี้|Purchases this year|今年采购额
เดือนก่อน|Last month|上月
เที่ยว / ระยะทาง|Trips / distance|行程 / 里程
ขับเร็วเกินกำหนด|Speeding|超速
เบรกแรง|Harsh braking|急刹车
จอดติดเครื่อง|Idling|怠速
ชั่วโมงขับเฉลี่ย / วัน|Avg driving hours / day|日均驾驶时长
ส่งผลให้คนขับ|Send result to driver|发送结果给司机
ถึงจุดสั่งซื้อ|At reorder point|达到再订货点
ส่วนต่าง|Variance|差异
บันทึกความลึกดอก|Record tread depth|记录花纹深度
สลับกับ|Swap with|与…对调
ติดตั้งบนรถ|Install on vehicle|安装到车辆
ระยะใช้งาน|Distance used|使用里程
ความลึกดอก|Tread depth|花纹深度
ต้นทุน / กม.|Cost / km|成本 / 公里
รถ / ตำแหน่ง|Vehicle / position|车辆 / 位置
เวลาตรวจ|Inspected at|检查时间
รูปแนบ|Photos|照片
ข้อบกพร่อง|Defects|缺陷
รูปจากแอปคนขับ|Photo from driver app|司机 App 照片
ปี|Year|年
นักพัฒนา / Open API|Developers / Open API|开发者 / Open API
ตั้งค่าระบบ|System settings|系统设置
ศูนย์ข้อยกเว้น|Exceptions|异常中心
สถานที่ / จุดรับส่ง|Locations|地点 / 取送点
สินค้าและหน่วย|Products & units|商品与单位
ค่าบริการเสริม|Accessorials|附加费用
Log การเรียก|API log|调用日志
ขีดจำกัดและแพ็กเกจ|Limits & plans|限额与套餐
สถานะ API|API status|API 状态
เปิดใช้ Open API|Enable Open API|启用 Open API
คำขอ 7 วันล่าสุด|Requests, last 7 days|近 7 天请求
คำขอทั้งหมด|All requests|全部请求
สำหรับนักพัฒนา|Developers|开发者
ไม่มีการแจ้งเตือน|No alerts|暂无提醒
เอกสาร API|API docs|API 文档
สถานะระบบ|System status|系统状态
เรียกเดือนนี้|Calls this month|本月调用
Error rate 24 ชม.|Error rate 24h|24 小时错误率
Key ที่ใช้งาน|Active keys|有效密钥
สร้าง API key|Create API key|创建 API 密钥
สร้าง API key แล้ว|API key created|已创建 API 密钥
เพิ่ม endpoint|Add endpoint|添加 endpoint
เพิ่ม webhook endpoint|Add webhook endpoint|添加 webhook endpoint
ส่ง event ทดสอบ|Send test event|发送测试事件
ประวัติการส่ง|Delivery history|投递记录
ดูข้อมูล|View|查看
หมุนเวียน key|Rotate key|轮换密钥
เพิกถอน|Revoke|吊销
แก้ scope|Edit scope|编辑权限
หมุนเวียน|Rotating|轮换中
ล้มเหลวต่อเนื่อง|Failing|持续失败
ชื่อ key|Key name|密钥名称
IP ที่อนุญาต|Allowed IPs|允许的 IP
สร้างโดย|Created by|创建人
ใช้ล่าสุด|Last used|最近使用
ไม่หมดอายุ|Never|永不过期
ทุก IP|Any IP|任意 IP
Event ที่สมัคร|Subscribed events|订阅事件
สำเร็จ 7 วัน|Success 7d|7 天成功率
เวลาตอบ|Latency|响应时间
คัดลอก request id|Copy request ID|复制 request ID
คัดลอก|Copy|复制
คัดลอกแล้ว|Copied|已复制
คัดลอกแล้ว · ปิดหน้าต่าง|I've copied it · Close|已复制 · 关闭
พารามิเตอร์|Parameters|参数
ตัวอย่าง request|Example request|请求示例
ลองเรียกใน Sandbox|Try in Sandbox|在沙盒中试用
ลองเรียก|Try it|试用
คู่มือ|Guides|指南
เริ่มต้นใช้งาน|Getting started|快速开始
แพ็กเกจและขีดจำกัด|Plans and limits|套餐与限额
การใช้งานเดือนนี้|Usage this month|本月用量
ขออัปเกรดแพ็กเกจ|Request upgrade|申请升级
ปัจจุบัน|Current|当前
ไม่เชื่อม|Not connected|未连接
ใช้งานอยู่|In use|使用中
ใช้โหมดนี้|Use this mode|使用此模式
ไปหน้า Open API|Go to Open API|前往 Open API
ทีมภายใน|Internal team|内部团队
แจ้งลูกค้าปลายทาง|Notify consignees|通知收货方
ดูข้อความ|Preview|预览
ตั้งค่าต่อลูกค้า|Per-customer settings|按客户设置
แจ้งอัตโนมัติ|Auto notify|自动通知
รับเรื่อง|Take ownership|接手
มอบหมาย|Assign|指派
ปิดเหตุ|Resolve|关闭事件
เปิดเอกสารอ้างอิง|Open reference|打开关联单据
กำลังจัดการ|In progress|处理中
เกิน SLA|SLA breached|超出 SLA
เลขเหตุ|Exception no.|事件编号
ตรวจพบ|Detected|发现时间
เพิ่มสถานที่|Add location|新增地点
เพิ่มสินค้า|Add product|新增商品
เพิ่มประเภทรถ|Add vehicle type|新增车型
เพิ่มค่าบริการ|Add accessorial|新增附加费
ยังไม่ปักหมุด|No pin|未标记
รถเข้าได้สูงสุด|Max vehicle|最大可进车型
เวลาทำการ|Opening hours|营业时间
ประมาณจากที่อยู่|Estimate from address|按地址估算
หน่วยคิด|Unit|计费单位
ใบขับขี่ขั้นต่ำ|Min. licence|最低驾照
ปริมาตร|Volume|容积
OTIF รายลูกค้า|OTIF by customer|按客户 OTIF
OTIF รายเส้นทาง|OTIF by route|按线路 OTIF
อายุเจ้าหนี้รถร่วม|Subcontractor AP aging|外包应付账龄
ภาษีหัก ณ ที่จ่าย|Withholding tax|预扣税
การเชื่อมต่อ API|API access|API 接入
สร้าง key สำหรับผู้ส่งสินค้า|Create shipper key|创建发货方密钥
ดูทั้งหมดในหน้า Open API|View all in Open API|在 Open API 查看全部
ฟิลด์เพิ่มเติม|Custom fields|自定义字段
เพิ่มฟิลด์|Add field|添加字段
แก้ไขฟิลด์|Edit field|编辑字段
บันทึกฟิลด์|Save field|保存字段
ลบฟิลด์|Delete field|删除字段
ปิดฟิลด์|Disable field|停用字段
เปิดฟิลด์|Enable field|启用字段
ข้อมูลเพิ่มเติม|Additional info|附加信息
ก. ข้อมูลฟิลด์|A. Field details|A. 字段信息
ข. ประเภท|B. Type|B. 类型
ค. กฎ|C. Rules|C. 规则
ง. แสดงที่ไหน|D. Where to show|D. 显示位置
จ. สิทธิ์|E. Permissions|E. 权限
ฉ. API|F. API|F. API
ชื่อที่แสดง|Display name|显示名称
แสดงที่|Shown in|显示于
ใช้ใน mapping|Used in mappings|映射使用
ลำดับ|Order|顺序
บังคับทุกครั้ง|Always required|始终必填
บังคับเฉพาะเมื่อสถานะ =|Required when status =|状态为…时必填
ค่าเริ่มต้น|Default value|默认值
ต่ำสุด|Min|最小值
สูงสุด|Max|最大值
ความยาวสูงสุด|Max length|最大长度
รูปแบบ (regex)|Pattern (regex)|格式 (regex)
ตัวอย่างที่ถูก|Valid example|正确示例
ห้ามซ้ำภายในบริษัท|Unique within company|公司内唯一
บทบาทที่เห็น|Roles that can view|可查看角色
บทบาทที่แก้ได้|Roles that can edit|可编辑角色
อ่านผ่าน API|Readable via API|API 可读
เขียนผ่าน API (POST / PATCH)|Writable via API (POST / PATCH)|API 可写 (POST / PATCH)
ส่งใน webhook|Include in webhook|包含在 webhook
ไม่แสดง|Hidden|不显示
อ่านอย่างเดียว|Read only|只读
ให้คนขับกรอกได้|Driver can fill|司机可填写
ลบแล้ว · กู้คืนได้ภายใน 30 วัน|Deleted · restorable within 30 days|已删除 · 30 天内可恢复
กู้คืน|Restore|恢复
ยังไม่มีฟิลด์เพิ่มเติม|No custom fields yet|暂无自定义字段
บทบาท|Role|角色
ไม่มีสิทธิ์เข้าถึง|No access|无访问权限
ไม่มีสิทธิ์เข้าถึงหน้านี้|You don't have access to this page|您无权访问此页面
กลับหน้าภาพรวม|Back to overview|返回概览
จับคู่ฟิลด์|Field mapping|字段映射
สร้างชุดจับคู่|Create mapping|新建映射
แก้ไขชุดจับคู่|Edit mapping|编辑映射
บันทึกชุดจับคู่|Save mapping|保存映射
ชุดจับคู่ทั้งหมด|All mappings|全部映射
ชื่อชุดจับคู่|Mapping name|映射名称
แหล่งข้อมูล|Source|数据来源
Entity ปลายทาง|Target entity|目标实体
ประเภทแหล่งข้อมูล|Source type|来源类型
ตัวอย่างข้อมูลต้นทาง|Sample source data|源数据示例
อ่านชื่อฟิลด์|Read fields|读取字段
ฟิลด์ต้นทาง|Source field|源字段
การแปลงค่า|Transform|转换
ฟิลด์ TMS|TMS field|TMS 字段
ฟิลด์ปลายทาง (ระบบภายนอก)|Target field (external)|目标字段(外部)
ยืนยันทั้งหมด|Confirm all|全部确认
ฟิลด์บังคับของ TMS ที่ยังไม่ได้จับคู่|Required TMS fields not mapped|未映射的 TMS 必填字段
ผลการทดสอบ|Test result|测试结果
JSON ที่ TMS จะได้|Resulting TMS JSON|TMS 将得到的 JSON
ปัญหาทีละฟิลด์|Issues by field|按字段问题
ไม่มีปัญหา|No issues|无问题
ผ่านทุกฟิลด์|All fields passed|全部通过
ไม่แปลง|No transform|不转换
ตัดช่องว่าง|Trim spaces|去除空格
ตัวพิมพ์ใหญ่|Uppercase|大写
ตัวพิมพ์เล็ก|Lowercase|小写
แปลงตามตาราง|Lookup table|按表转换
ค่าคงที่|Constant|常量
รวมหลายฟิลด์|Combine fields|合并字段
ค่าเริ่มต้นถ้าว่าง|Default if empty|为空时默认
เพิ่มค่าคงที่|Add constant|添加常量
เปลี่ยนสถานที่|Change location|更改地点
+ เพิ่มสถานที่ใหม่|+ Add new location|+ 新增地点
ไม่พบสถานที่|No locations found|未找到地点
ข้อมูลอ้างอิง|Reference info|参考信息
แล้ว||
กล่องรับงาน|Order inbox|订单收件箱
สร้างจากข้อความ/ไฟล์|Create from text/file|从文本/文件创建
สร้าง SO จากข้อความ/ไฟล์|Create SO from text/file|从文本/文件创建 SO
สร้าง SO จากข้อความ / ไฟล์|Create SO from text / file|从文本 / 文件创建 SO
AI แนะนำ|AI suggested|AI 建议
ให้ AI อ่าน|Let AI read|让 AI 读取
ให้ AI แนะนำ|Ask AI to suggest|让 AI 建议
วางข้อความ|Paste text|粘贴文本
อัปโหลดไฟล์|Upload file|上传文件
เลือกจากกล่องรับงาน|Pick from inbox|从接单箱选择
ต้นฉบับ|Source|原文
ร่างใบสั่งขนส่ง|Draft sales order|运输单草稿
ไม่พบในต้นฉบับ · กรอกเองหรือเว้นว่าง|Not found in source · fill in or leave blank|原文未找到 · 手动填写或留空
แก้ต้นฉบับ|Edit source|修改原文
ปฏิเสธร่างนี้|Reject this draft|拒绝此草稿
สร้างเฉพาะใบนี้|Create this one only|仅创建此单
สูง|High|高
กลาง|Medium|中
ต่ำ|Low|低
แก้แล้ว|Edited|已修改
สร้าง SO แล้ว|SO created|已创建 SO
ไม่ใช่งาน|Not an order|非订单
ผลตรวจ POD|POD check|POD 检查
ยอมรับผลตรวจ|Accept result|接受结果
ปฏิเสธผล AI|Reject AI result|拒绝 AI 结果
ขอ POD ใหม่จากคนขับ|Request new POD from driver|向司机重新索取 POD
ส่งเข้าศูนย์ข้อยกเว้น|Send to exception center|发送至异常中心
แสดงเฉพาะ DO ที่ POD ผ่าน AI แล้ว|Only DOs whose POD passed AI|仅显示 POD 已通过 AI 的 DO
อ่านใบเสร็จด้วย AI|Read receipt with AI|AI 识别收据
อ่านใบแจ้งหนี้อู่ด้วย AI|Read garage invoice with AI|AI 识别修理厂发票
อ่านกรมธรรม์ด้วย AI|Read policy with AI|AI 识别保单
ถาม AI|Ask AI|问 AI
ลองถาม|Try asking|试着问
ถามใหม่|Ask again|重新提问
AI credit เดือนนี้|AI credit this month|本月 AI 额度
ซื้อ credit เพิ่ม|Buy more credit|购买更多额度
ซื้อ AI credit เพิ่ม|Buy more AI credit|购买更多 AI 额度
ความแม่นยำ 30 วัน|Accuracy, 30 days|30 天准确率
ความเป็นส่วนตัว|Privacy|隐私
ประวัติ AI|AI history|AI 记录
ฟีเจอร์|Features|功能
รับเลย|Accepted|直接接受
แก้แล้วรับ|Edited then accepted|修改后接受
เชื่อมต่อโปรแกรม AI กับ TMS|Connect AI apps to TMS|将 AI 应用连接到 TMS
เพิ่มในโปรแกรม AI|Add to your AI app|添加到 AI 应用
การเชื่อมต่อที่ใช้งานอยู่|Active connections|活跃连接
แคตตาล็อก tool|Tool catalog|工具目录
ตัวอย่างประโยค|Example prompt|示例语句
ข้อควรรู้|Good to know|注意事项
งานขนส่ง|Transport jobs|运输作业
สร้างร่างใบสั่งขนส่ง ราคาคำนวณจาก rate card|Create a draft sales order, priced from the rate card|创建运输单草稿,按费率卡计价
ร่างจะไปอยู่ในกล่องรับงาน ต้องมีคนยืนยันใน TMS ก่อนเป็น SO|Drafts land in the order inbox and must be confirmed in TMS before becoming an SO|草稿进入收单箱,需在 TMS 确认后才成为运输单
ชื่อหรือรหัสลูกค้า|Customer name or code|客户名称或编码
จุดรับ: location_id หรือชื่อสถานที่|Pickup: location_id or place name|取货点:location_id 或地点名称
วันเวลารับ ISO 8601|Pickup date-time, ISO 8601|取货日期时间 ISO 8601
น้ำหนักรวม|Total weight|总重量
เลข PO ลูกค้า|Customer PO|客户采购单号
ลูกค้าเดิมบอกชื่อพอ ระบบจับคู่กับข้อมูลหลัก|For existing customers a name is enough; it is matched to master data|老客户只需名称,系统匹配主数据
ระบบออกเลข SO ให้เมื่อยืนยัน|The SO number is issued on confirmation|确认后系统分配运输单号
ถ้าจับคู่สถานที่ไม่ได้ AI จะถามกลับก่อนสร้าง|If a place can't be matched, the AI asks before creating|地点无法匹配时 AI 会先追问
อ่าน|Read|读取
ค้นหาใบสั่งขนส่งตามลูกค้า สถานะ วันที่ หรือ custom field|Search sales orders by customer, status, date or custom field|按客户、状态、日期或自定义字段搜索运输单
สถานะ SO|SO status|运输单状态
ค้นด้วย custom field ที่ตั้ง "ค้นหาได้"|Search by custom fields marked "searchable"|按标记为"可搜索"的自定义字段搜索
ประเมินราคาจาก rate card ของลูกค้า|Quote a price from the customer's rate card|按客户费率卡报价
ต้นทาง → ปลายทาง|Origin → destination|起点 → 终点
ติดตาม / POD|Tracking / POD|跟踪 / POD
ตำแหน่งรถและเวลาถึงโดยประมาณของ DO|Vehicle position and ETA for a DO|DO 的车辆位置与预计到达
ดูหลักฐานการส่งและผลตรวจ POD|View proof of delivery and POD check result|查看签收证明与 POD 检查结果
รูปส่งเป็นลิงก์อายุ 15 นาที|Photos are returned as links valid for 15 minutes|照片以 15 分钟有效链接返回
เสนอรถที่เหมาะกับงานพร้อมเหตุผล|Suggest suitable vehicles with reasons|推荐合适车辆并说明理由
ร่างการจัดรถและคนขับให้ SO|Draft a vehicle and driver assignment for an SO|为运输单起草派车与司机
การจ่ายงานรถต้องยืนยันใน TMS|Dispatch must be confirmed in TMS|派车需在 TMS 中确认
ตรวจน้ำหนัก ใบขับขี่ และเอกสารรถเหมือนการจัดในหน้าจอ|Checks weight, licence and vehicle documents like on-screen dispatch|与界面派车相同,检查重量、驾照和车辆证件
จากเอกสาร / ข้อความ|From documents / messages|来自文件 / 消息
อ่านข้อความแล้วสร้างร่าง SO หนึ่งหรือหลายใบ|Read a message and create one or more draft SOs|读取消息并创建一张或多张运输单草稿
ข้อความจากลูกค้า|Message from customer|客户消息
ถ้ารู้ลูกค้า|If the customer is known|如已知客户
ใช้ AI credit 2 ต่อใบ|Uses 2 AI credits per order|每单消耗 2 个 AI 点数
อ่าน PDF Excel หรือรูปใบสั่งงาน|Read a PDF, Excel or photo of an order|读取 PDF、Excel 或订单照片
สร้าง SO จากไฟล์ที่แนบ|Create SOs from the attached file|从附件创建运输单
ลิงก์ไฟล์|File link|文件链接
อ่านใบเสร็จเป็นร่างค่าใช้จ่าย|Read a receipt into a draft expense|读取收据生成费用草稿
ร่างใบแจ้งหนี้จาก DO ที่ส่งแล้ว|Draft invoices from delivered DOs|从已送达 DO 起草发票
กระทบเงินและภาษี จึงเป็นร่างเสมอ|Affects money and tax, so always a draft|涉及金额与税务,始终为草稿
ใช้ VAT ตามการตั้งค่าลูกค้า|Uses the customer's VAT setting|按客户增值税设置
ลูกหนี้เกินกำหนดแยกตามอายุหนี้|Overdue receivables by age|按账龄列出逾期应收
เอกสารรถที่จะหมดอายุ|Expiring vehicle documents|即将到期的车辆证件
ค้นหาสถานที่ เวลาทำการ และข้อจำกัดรถ|Find places, opening hours and vehicle restrictions|查找地点、营业时间与车辆限制
ขอลบสถานที่|Request to delete a place|申请删除地点
การลบเป็นร่างเสมอ|Deletion is always a draft|删除始终为草稿
OTIF ตามลูกค้าหรือเส้นทาง|OTIF by customer or route|按客户或线路的 OTIF
ข้อยกเว้น|Exceptions|异常
เหตุที่ยังไม่ปิดพร้อม SLA|Open incidents with SLA|未关闭事件及 SLA
เขียน|Write|写入
ปิดเหตุพร้อมเหตุผล|Close an incident with a reason|填写理由并关闭事件
AI ต้องขอยืนยันจากผู้ใช้ก่อนเรียก|The AI must ask the user before calling|AI 调用前需获得用户确认
อย่างน้อย 10 ตัวอักษร|At least 10 characters|至少 10 个字符
ร่าง · ยืนยันใน TMS|Draft · confirm in TMS|草稿 · 在 TMS 确认
เขียน · ยืนยันใน AI|Write · confirm in the AI app|写入 · 在 AI 中确认
รันในเทอร์มินัล แล้วพิมพ์ /mcp เพื่อเข้าสู่ระบบ|Run in the terminal, then type /mcp to sign in|在终端运行,然后输入 /mcp 登录
ทำได้โดยผู้ดูแลบัญชี Claude ของทีม|Done by your team's Claude admin|由团队 Claude 管理员操作
ต้องเปิดโหมดนักพัฒนาในบัญชี ChatGPT|Developer mode must be enabled in ChatGPT|需在 ChatGPT 账户开启开发者模式
ใช้กับโปรแกรมที่รองรับ MCP แบบ HTTP (Streamable HTTP)|For apps that support MCP over HTTP (Streamable HTTP)|适用于支持 HTTP MCP(Streamable HTTP)的应用
อื่นๆ (JSON)|Other (JSON)|其他(JSON)
REST เดือนนี้|REST this month|本月 REST
MCP เดือนนี้|MCP this month|本月 MCP
สร้าง / ร่าง|Create / draft|创建 / 草稿
แก้ / อื่นๆ|Edit / other|修改 / 其他
เพิกถอนการเชื่อมต่อ|Revoke connection|撤销连接
· AI จะเรียก tool ไม่ได้ทันที ต้องเชื่อมต่อและอนุญาตใหม่|· the AI loses tool access immediately and must reconnect|· AI 立即无法调用工具,需重新连接授权
อ่านข้อความ LINE อีเมล PDF Excel และรูปใบสั่งงาน เป็นร่าง SO|Reads LINE, email, PDF, Excel and order photos into draft SOs|读取 LINE、邮件、PDF、Excel 和订单照片生成运输单草稿
อ่านเอกสาร (OCR)|Document reading (OCR)|文档识别(OCR)
ใบเสร็จน้ำมัน ใบแจ้งหนี้อู่ กรมธรรม์ ภาษี ตรอ.|Fuel receipts, garage invoices, insurance, tax, inspections|加油收据、修理发票、保单、税单、车检
ตรวจ POD|Check POD|核查 POD
ตรวจรูป ลายเซ็น จำนวน และความเสียหายจากหลักฐานส่ง|Checks photos, signature, quantity and damage in proof of delivery|检查签收照片、签名、数量和损坏
แนะนำการจับคู่ฟิลด์|Field mapping suggestions|字段映射建议
เสนอการจับคู่และการแปลงค่าใน Field mapping|Suggests mappings and value transforms in Field mapping|在字段映射中建议匹配与转换
ถามข้อมูลด้วยภาษาพูด|Ask in natural language|自然语言提问
ตอบจากข้อมูลตามสิทธิ์ผู้ใช้ อ่านอย่างเดียว|Answers from data the user can access · read-only|按用户权限回答 · 只读
เปิดใช้ AI ทั้งบริษัท|AI enabled for the company|全公司启用 AI
ปิด AI ทั้งบริษัท · ฟีเจอร์ทั้งหมดหยุดทำงาน|AI disabled company-wide · all features stopped|全公司关闭 AI · 所有功能停止
ถามข้อมูล|Ask|提问
ความแม่น|Accuracy|准确率
ยังไม่มีประวัติ|No history yet|暂无记录
credit / ครั้ง|credits / use|点数 / 次
เปิด AI ทั้งบริษัทก่อน|Enable company-wide AI first|请先全公司启用 AI
รีเซ็ต 1 ธ.ค. 2569|Resets 1 Dec 2026|2026年12月1日重置
· โควตาตามแพ็กเกจ|· quota from plan|· 按套餐配额
ข้อมูลประมวลผลบนเซิร์ฟเวอร์ในภูมิภาคเอเชียแปซิฟิก และลบภายใน 30 วัน|Data is processed on Asia-Pacific servers and deleted within 30 days|数据在亚太区服务器处理,30 天内删除
ผู้ให้บริการ AI ไม่นำข้อมูลของบริษัทไปฝึกโมเดล|The AI provider does not train models on your company's data|AI 服务商不会用贵公司数据训练模型
ผลลัพธ์ทุกครั้งเป็นร่าง ต้องมีคนยืนยันก่อนบันทึก|Every result is a draft and must be confirmed before saving|所有结果均为草稿,需确认后保存
AI เห็นเฉพาะข้อมูลที่ผู้ใช้คนนั้นมีสิทธิ์|The AI sees only data the user is allowed to see|AI 仅能看到该用户有权限的数据
ครั้งใน 30 วัน|uses in 30 days|30 天内次数
ถามเป็นภาษาพูด เช่น ลูกหนี้เกิน 60 วันมีใครบ้าง แล้วกด Enter|Ask in plain words, e.g. "who is over 60 days overdue", then press Enter|用自然语言提问,如"哪些应收超过60天",按 Enter
ค้นหาเอกสาร ลูกค้า รถ หน้า หรือคำสั่ง|Search documents, customers, vehicles, pages or commands|搜索单据、客户、车辆、页面或命令
อ่านใบเสร็จน้ำมัน|Read fuel receipt|识别加油收据
บันทึกร่างค่าน้ำมัน|Save fuel expense draft|保存油费草稿
ปั๊ม|Station|加油站
เลขผู้เสียภาษีผู้ขาย|Vendor tax ID|卖方税号
ราคา / ลิตร (฿)|Price / L (฿)|单价 / 升 (฿)
ยอดรวม (฿)|Total (฿)|合计 (฿)
อ่านใบแจ้งหนี้อู่|Read garage invoice|识别修理厂发票
บันทึกร่างรายการซ่อม|Save repair lines draft|保存维修明细草稿
เลขที่ใบแจ้งหนี้|Invoice no.|发票号
อ่านกรมธรรม์ประกันภัย|Read insurance policy|识别保单
บันทึกร่างเอกสารรถ|Save vehicle document draft|保存车辆证件草稿
เลขที่กรมธรรม์|Policy no.|保单号
วันเริ่ม|Start date|开始日期
วันหมดอายุ|Expiry date|到期日
เบี้ยรวม (฿)|Total premium (฿)|总保费 (฿)
เลือกใบสั่งซ่อมที่จะเติมรายการก่อน|Choose the work order to add lines to first|请先选择要添加明细的维修单
เปิดรายการ|Open record|打开记录
ปฏิเสธผล AI · กรอกเองได้ในฟอร์มปกติ|AI result rejected · enter it manually in the normal form|已拒绝 AI 结果 · 可在常规表单手动填写
ตัวอย่างอีเมล 2 งาน|Sample email · 2 jobs|示例邮件 · 2 单
ตัวอย่างข้อความ LINE|Sample LINE message|示例 LINE 消息
ไม่พบในต้นฉบับ|Not found in source|原文中未找到
ข้อความที่วาง|Pasted text|粘贴的文本
สร้างแล้ว|Created|已创建
ลงฟิลด์ custom_fields.|Goes to custom_fields.|写入 custom_fields.
ไม่มีฟิลด์ปลายทาง · บันทึกในหมายเหตุ|No matching field · saved in notes|无对应字段 · 存入备注
สร้างทั้งหมด|Create all|全部创建
อีเมลรับงาน|Order email|收单邮箱
เข้าเมื่อ|Received|收到时间
AI พบ|AI found|AI 识别
ตรวจและสร้าง SO|Review and create SO|检查并创建运输单
ตอบกลับลูกค้า|Reply to customer|回复客户
ชื่อลูกค้า|Customer name|客户名称
มีลูกค้าชื่อนี้แล้ว|A customer with this name already exists|已有同名客户
รหัสสาขา|Branch code|分支代码
ต้องเป็นตัวเลข 5 หลัก|Must be 5 digits|须为 5 位数字
น้ำหนักบรรทุก (กก.)|Payload (kg)|载重 (kg)
สร้างใบสั่งขนส่ง|Create sales order|创建运输单
สร้างใบส่งของ|Create delivery order|创建交货单
เพิ่มลูกค้า|Add customer|新增客户
เพิ่มรถ|Add vehicle|新增车辆
เลขที่ถัดไป|Next number|下一个编号
สร้าง DO|Create DO|创建 DO
· ฟิลด์เพิ่มเติม|· custom fields|· 自定义字段
AI อ่านใบเสร็จ|AI receipt reading|AI 识别收据
รายการในใบสั่งซ่อม|lines to work order|条明细到维修单
· หมดอายุใหม่|· new expiry|· 新到期日
สร้างจากการจับคู่ฟิลด์|Created from field mapping|由字段映射创建
(AI แนะนำ)|(AI suggested)|(AI 建议)
จาก AI แนะนำในการจับคู่ฟิลด์|from an AI suggestion in field mapping|来自字段映射的 AI 建议
สร้างฟิลด์เพิ่มเติม|Created custom field|已创建自定义字段
และจับคู่แล้ว|and mapped it|并已映射
วางตัวอย่าง JSON หรือ CSV ก่อนให้ AI แนะนำ|Paste a JSON or CSV sample before asking the AI|请先粘贴 JSON 或 CSV 示例再让 AI 建议
ตัวอย่างเป็นวันที่ พ.ศ. แปลงเป็น ISO|Sample is a Buddhist-era date · convert to ISO|示例为佛历日期 · 转为 ISO
ชื่อฟิลด์บอกหน่วยตัน แปลงเป็น กก.|Field name says tonnes · convert to kg|字段名为吨 · 转为公斤
ปรับเป็นตัวพิมพ์ใหญ่ตามรูปแบบ|Uppercase to match the format|按格式转为大写
ตัวเลข|Number|数字
ชุดใหม่|New set|新映射
AI แนะนำการจับคู่|AI suggested mappings|AI 建议映射
· ตรวจแล้วกดบันทึก|· review and save|· 检查后保存
ยอมรับทั้งหมด|Accept all|全部接受
ยอมรับ|Accept|接受
AI แนะนำ · สร้างฟิลด์เพิ่มเติมใหม่|AI suggestion · create a new custom field|AI 建议 · 新建自定义字段
สร้างและจับคู่|Create and map|创建并映射
ไม่ต้อง|No thanks|不需要
คำอธิบายข้อมูล|Field reference|字段说明
ตัวอย่างโค้ด|Code samples|代码示例
ความยาว|Length|长度
ส่ง request ไป Sandbox|Send request to Sandbox|发送请求到 Sandbox
ลองเรียกได้เฉพาะ Sandbox · ไม่กระทบข้อมูลจริง|Sandbox only · does not affect live data|仅限 Sandbox · 不影响正式数据
endpoint นี้ไม่มีพารามิเตอร์|This endpoint has no parameters|此端点无参数
แหล่ง|Source|来源
เติมรายการลงใบสั่งซ่อม|Add lines to work order|添加明细到维修单
กรอบคือตำแหน่งที่ AI อ่าน · กรอบส้ม = ไม่มั่นใจ|Boxes show where the AI read · orange = low confidence|方框为 AI 识别位置 · 橙色 = 不确定
AI อ่านแล้วเติมฟอร์มเป็นร่าง · ไม่มีอะไรบันทึกจนกว่าคุณกดสร้าง|The AI fills a draft form · nothing is saved until you press Create|AI 填写草稿表单 · 点击创建前不会保存
ลองใช้|Try|试用
ลากไฟล์มาวาง หรือเลือกตัวอย่างด้านล่าง|Drop a file or choose a sample below|拖入文件或选择下方示例
PDF · Excel · รูปถ่ายใบสั่งงาน ไม่เกิน 10 MB|PDF · Excel · order photo up to 10 MB|PDF · Excel · 订单照片,最大 10 MB
ส่วนที่ไฮไลต์คือข้อความที่ AI ดึงไปเติมฟอร์ม · ชี้เพื่อดูว่าเป็นช่องไหน|Highlights show text the AI used · hover to see the field|高亮为 AI 提取的文字 · 悬停查看对应字段
เปิด SO|Open SO|打开运输单
ปฏิเสธร่างนี้แล้ว · ไม่สร้าง SO|Draft rejected · no SO created|已拒绝此草稿 · 未创建运输单
พารามิเตอร์ · schema เดียวกับ REST API|Parameters · same schema as the REST API|参数 · 与 REST API 相同的 schema
คำอธิบาย / ตัวอย่าง|Description / example|说明 / 示例
tool อื่นในหมวดเดียวกัน|Other tools in this group|同组其他工具
อ่านอย่างเดียว · ตอบตามสิทธิ์ของคุณ · ใช้ 1 AI credit ต่อคำถาม|Read-only · answers within your permissions · 1 AI credit per question|只读 · 按你的权限回答 · 每问 1 点
REST API, MCP, webhook และเอกสาร ใช้ schema ชุดเดียวกัน รวมฟิลด์เพิ่มเติมของบริษัท|REST API, MCP, webhooks and docs share one schema, including company custom fields|REST API、MCP、webhook 和文档使用同一 schema,含公司自定义字段
URL เดียวกันทุกบริษัท · ระบบรู้บริษัทและผู้ใช้จาก token หลังเข้าสู่ระบบ|Same URL for every company · company and user come from the token after sign-in|所有公司同一 URL · 登录后从 token 识别公司与用户
เข้าสู่ระบบ TMS แล้วกด "อนุญาต"|Sign in to TMS and press "Allow"|登录 TMS 并点击"允许"
ครั้งแรกที่ใช้ โปรแกรม AI จะเปิดหน้าเข้าสู่ระบบของ TMS ให้เลือก scope ที่อนุญาต AI ได้ token โดยไม่เห็นรหัสผ่าน|On first use the AI app opens the TMS sign-in page to choose scopes; the AI gets a token without seeing your password|首次使用时 AI 应用会打开 TMS 登录页选择授权范围,AI 获得 token 而看不到密码
สิทธิ์ของ AI = สิทธิ์ตามบทบาทของผู้ใช้ ∩ scope ที่อนุญาตตอนเชื่อมต่อ|AI permissions = the user's role permissions ∩ scopes granted at connection|AI 权限 = 用户角色权限 ∩ 连接时授权的范围
โปรแกรม|App|应用
Scope ที่อนุญาต|Granted scopes|已授权范围
เชื่อมเมื่อ|Connected|连接时间
เรียก 7 วัน|Calls (7 days)|7 天调用
ผลจาก AI เป็นร่างเสมอ ต้องมีคนกดยอมรับก่อนบันทึก|AI results are always drafts and must be accepted before saving|AI 结果始终为草稿,需接受后才保存
ผู้ยืนยัน|Confirmed by|确认人
ปิดบังเลขบัตรประชาชนและเบอร์โทรก่อนส่งให้ AI|Mask ID card and phone numbers before sending to AI|发送给 AI 前隐藏身份证号和电话
ไม่จำกัด|Unlimited|不限
รถ active เดือนนี้|Active vehicles this month|本月活跃车辆
นับรถบริษัท + รถร่วมที่วิ่งจริงในเดือน|Company and subcontractor vehicles that ran this month|统计本月实际运行的自有车与外包车
พื้นที่รูป POD|POD photo storage|POD 照片存储
Connector บัญชี|Accounting connector|会计连接器
แพ็กเกจนี้ส่งออกไฟล์ให้นักบัญชีได้|This plan can export files for your accountant|此套餐可导出文件给会计
API calls เดือนนี้|API calls this month|本月 API 调用
ไม่รวมในแพ็กเกจนี้|Not included in this plan|此套餐不含
ฟิลด์เพิ่มเติม (entity ที่ใช้มากสุด)|Custom fields (most-used entity)|自定义字段(使用最多的实体)
SMS / LINE แจ้งลูกค้า|SMS / LINE customer notifications|SMS / LINE 客户通知
โควตา|Quota|配额
add-on ที่ซื้อแล้ว|add-ons purchased|已购附加
ซื้อเพิ่มได้|Can buy more|可加购
ในแพ็กเกจ|In plan|套餐内
ค้างชำระ|Outstanding|未付
Onboarding มีคนช่วย|Assisted onboarding|协助上手
บัตรเครดิต / เดบิต|Credit / debit card|信用卡 / 借记卡
สแกนจ่ายทุกรอบบิล ไม่ตัดอัตโนมัติ|Scan to pay each cycle · no auto-charge|每期扫码支付 · 不自动扣款
โอนเงิน + แนบสลิป|Bank transfer + slip|转账 + 上传凭证
ทีมการเงินตรวจภายใน 1 วันทำการ|Finance checks within 1 business day|财务 1 个工作日内核对
/ รถ / เดือน|/ vehicle / month|/ 车 / 月
รายเดือน · ตัดรอบวันที่ 1|Monthly · billed on the 1st|按月 · 每月 1 日结算
ทดลองใช้|Trial|试用
เริ่มคิดเงิน 16 พ.ย. 2569|Billing starts 16 Nov 2026|2026年11月16日开始计费
ยกเลิกเมื่อครบรอบ 30 พ.ย. 2569|Cancels at period end 30 Nov 2026|2026年11月30日周期结束取消
ต่ออายุ 1 ธ.ค. 2569|Renews 1 Dec 2026|2026年12月1日续期
ดาวน์โหลดใบกำกับภาษี / ใบเสร็จ|Download tax invoice / receipt|下载税务发票 / 收据
ยกเลิกคำขอยกเลิกแล้ว · แพ็กเกจต่ออายุตามปกติ|Cancellation withdrawn · plan renews as usual|已撤回取消 · 套餐照常续期
บริษัทที่คุณเป็นสมาชิก|Companies you belong to|你所属的公司
สร้างบริษัทใหม่|Create new company|新建公司
สถานะบัญชี|Account status|账户状态
· ทุกการกระทำถูกบันทึกใน audit log|· every action is recorded in the audit log|· 所有操作记录在审计日志
เริ่มต้นใช้งาน TMS|Getting started with TMS|TMS 入门
ซ่อน|Hide|隐藏
ซื้อ Add-on|Buy add-on|购买附加
เทียบแพ็กเกจ|Compare plans|比较套餐
มีในแพ็กเกจ|Included|已包含
ข้อมูลเดิมไม่หาย · เปลี่ยนแพ็กเกจได้ทุกเมื่อ ไม่มีค่าปรับ|Your data stays · change plans anytime with no penalty|数据不丢失 · 随时更换套餐,无违约金
แพ็กเกจปัจจุบัน|Current plan|当前套餐
รอบบิล|Billing cycle|账单周期
เปลี่ยนแพ็กเกจ|Change plan|更换套餐
ชำระเงิน|Pay|付款
ยกเลิกเมื่อครบรอบ|Cancel at period end|周期结束取消
ไม่ยกเลิกแล้ว|Keep plan|不取消
โมดูลในแพ็กเกจ|Modules in plan|套餐模块
ไม่ล็อก POD และวางบิลไว้ที่แพ็กเกจสูง|POD and billing are never locked to higher plans|POD 和开票不限于高级套餐
ซื้อเพิ่ม|Buy more|加购
วิธีชำระ|Payment method|付款方式
ใบกำกับภาษี / ใบเสร็จจากผู้ให้บริการ TMS|Tax invoices / receipts from the TMS provider|TMS 服务商的税务发票 / 收据
ค่าบริการซอฟต์แวร์ที่เราเรียกเก็บจากบริษัทคุณ · แยกจากใบแจ้งหนี้ที่คุณออกให้ลูกค้าของคุณ|Software fees we charge your company · separate from invoices you issue to your customers|我们向贵公司收取的软件费 · 与你开给客户的发票分开
แสดงรายการเริ่มต้นใช้งานอีกครั้ง|Show the getting-started checklist again|再次显示入门清单
เต็มโควตา|Quota reached|配额已满
ดูแพ็กเกจ|View plans|查看套餐
ดูการอัปเกรด|View upgrade|查看升级
ซื้อแล้ว|Purchased|已购买
รวมต่อเดือน (ก่อน VAT)|Monthly total (before VAT)|每月合计(税前)
เหตุผลที่ยกเลิก|Reason for cancelling|取消原因
ยอดชำระ (รวม VAT 7%)|Amount due (incl. VAT 7%)|应付金额(含 7% 增值税)
เปลี่ยนบัตร|Change card|更换卡
สร้างเมื่อกดชำระจริง|Generated when you pay|付款时生成
สแกนด้วยแอปธนาคาร|Scan with your banking app|用银行 App 扫码
QR ใช้ได้ 15 นาที · ระบบยืนยันอัตโนมัติ|QR valid for 15 minutes · confirmed automatically|二维码 15 分钟有效 · 自动确认
แนบสลิป|Attach slip|上传凭证
ผล|Result|结果
รับเลย|Accepted|直接接受
แก้แล้วรับ|Edited & accepted|修改后接受
ความแม่นยำ 30 วัน|Accuracy · 30 days|30 天准确率
ประวัติ AI|AI history|AI 记录
↑ ↓ เลื่อน|↑ ↓ Move|↑ ↓ 移动
Enter เปิด|Enter Open|Enter 打开
Esc ปิด|Esc Close|Esc 关闭
นโยบายการสมัคร|Signup policy|注册策略
อนุมัติอัตโนมัติ|Auto-approve|自动批准
ต้องให้ทีมตรวจ|Team review required|需团队审核
เลขผู้เสียภาษีตัวอย่าง: 0105556078912 มีในระบบแล้ว · ขึ้นต้น 9 ไม่พบใน DBD · OTP ที่ถูก 123456|Sample tax IDs: 0105556078912 already exists · starting with 9 not found in DBD · correct OTP 123456|示例税号:0105556078912 已存在 · 以 9 开头在 DBD 中查无 · 正确 OTP 123456
ระบบบริหารงานขนส่ง|Transport management system|运输管理系统
ติดต่อ|Contact|联系
ทดลองใช้ฟรี|Start free trial|免费试用
ทดลอง 30 วัน ไม่ต้องใช้บัตร|30-day trial, no card required|试用 30 天,无需信用卡
จ่ายตามจำนวนรถที่วิ่งจริงในเดือน|Pay for the vehicles that actually run each month|按当月实际运行车辆付费
นับรถบริษัทและรถร่วมที่มีงานในเดือนนั้น ผู้ใช้ไม่จำกัดทุกแพ็กเกจ ไม่ผูกสัญญา ไม่มีค่าปรับ|Counts company and subcontractor vehicles with jobs that month. Unlimited users on every plan, no contract, no penalties.|按当月有任务的自有车与外包车计费。所有套餐用户不限,无合约,无罚金。
รายปี|Yearly|按年
ลด 2 เดือน|2 months free|省 2 个月
สำหรับบริษัทขนส่งที่เริ่มเปลี่ยนจาก Excel|For carriers moving off Excel|适合从 Excel 转型的运输公司
เริ่มทดลองใช้ 30 วัน|Start 30-day trial|开始 30 天试用
SO/DO, วางแผน, แอปคนขับ + POD, วางบิล/ใบแจ้งหนี้/รับชำระ|SO/DO, planning, driver app + POD, billing / invoices / receipts|SO/DO、调度、司机 App + POD、开票 / 发票 / 收款
Connector บัญชี: export ไฟล์|Accounting connector: file export|财务连接器:文件导出
Connector บัญชี: 1 ตัว|Accounting connector: 1|财务连接器:1 个
Connector บัญชี: ไม่จำกัด|Accounting connector: unlimited|财务连接器:不限
นิยม|Popular|热门
มีรถร่วม ติดตามรถ และเชื่อมโปรแกรมบัญชี|Subcontractors, live tracking and accounting integration|外包车、车辆追踪与财务软件对接
+ รถร่วม + Settlement, ติดตามรถ, รายงาน, fleet พื้นฐาน|+ subcontractors + settlement, live tracking, reports, basic fleet|+ 外包车 + 结算、车辆追踪、报表、基础车队
หลายนิติบุคคล fleet เต็ม และ customer portal|Multiple entities, full fleet and customer portal|多法人、完整车队与客户门户
ติดต่อฝ่ายขาย|Contact sales|联系销售
รถไม่จำกัด · SLA และ onboarding เฉพาะ|Unlimited vehicles · dedicated SLA and onboarding|车辆不限 · 专属 SLA 与上线支持
+ fleet เต็ม (ยาง อะไหล่ ถังน้ำมัน), หลายนิติบุคคล, customer portal|+ full fleet (tyres, parts, fuel tanks), multiple entities, customer portal|+ 完整车队(轮胎、配件、油罐)、多法人、客户门户
ฟิลด์เพิ่มเติม ไม่จำกัด ต่อ entity|Unlimited custom fields per entity|每个实体自定义字段不限
คำนวณค่าใช้จ่าย|Cost calculator|费用计算
จำนวนรถ active ต่อเดือน (รวมรถร่วม)|Active vehicles per month (incl. subcontractors)|每月活跃车辆(含外包车)
ต่อปี|Per year|每年
จ่ายรายปี|Billed yearly|按年支付
เปรียบเทียบแพ็กเกจ|Compare plans|套餐对比
ใบสั่งขนส่ง (SO) / ใบส่งของ (DO)|Shipment orders (SO) / delivery orders (DO)|运输订单 (SO) / 送货单 (DO)
แอปคนขับ + POD|Driver app + POD|司机 App + POD
ติดตามรถ (GPS)|Live tracking (GPS)|车辆追踪 (GPS)
วางบิล / ใบแจ้งหนี้ / รับชำระ|Billing / invoices / receipts|开票 / 发票 / 收款
เชื่อมโปรแกรมบัญชี (connector)|Accounting integration (connector)|财务软件对接(连接器)
เชื่อมโปรแกรมบัญชี|Accounting integration|财务软件对接
export ไฟล์|File export|文件导出
หลายนิติบุคคล|Multiple entities|多法人
ทะเบียนรถ เอกสารรถ ใบสั่งซ่อม|Vehicle register, documents, work orders|车辆登记、车辆文件、维修单
ยาง อะไหล่ ถังน้ำมัน|Tyres, parts, fuel tanks|轮胎、配件、油罐
รายงานและลูกค้า|Reports & customers|报表与客户
แจ้งลูกค้าปลายทาง SMS / LINE (ข้อความ/เดือน)|Consignee SMS / LINE notifications (messages/month)|收货人 SMS / LINE 通知(条/月)
ตกลง|Custom|协商
Open API + MCP (req/นาที)|Open API + MCP (req/min)|Open API + MCP(次/分钟)
ฟิลด์เพิ่มเติม (ต่อ entity)|Custom fields (per entity)|自定义字段(每实体)
รถ active / เดือน|Active vehicles / month|活跃车辆 / 月
AI credit / เดือน|AI credit / month|AI 点数 / 月
รถเกินโควตา|Vehicles over quota|超额车辆
ต่อคัน / เดือน|per vehicle / month|每车 / 月
Connector บัญชีเพิ่ม|Extra accounting connector|额外财务连接器
ต่อตัว / เดือน|per connector / month|每个 / 月
SMS / LINE แจ้งลูกค้าเกินโควตา|SMS / LINE notifications over quota|超额 SMS / LINE 通知
ต่อ 1,000 ข้อความ|per 1,000 messages|每 1,000 条
AI credit เพิ่ม|Extra AI credit|额外 AI 点数
ต่อ 1,000 credit|per 1,000 credits|每 1,000 点
ครั้งเดียว|One-time|一次性
Fleet เต็ม (ยาง อะไหล่ ถังน้ำมัน)|Full fleet (tyres, parts, fuel tanks)|完整车队(轮胎、配件、油罐)
ต่อรถ / เดือน|per vehicle / month|每车 / 月
คำถามที่พบบ่อย|FAQ|常见问题
ไม่พบคำตอบ ติดต่อทีมงานได้ทาง LINE @tms-th หรือ 02-118-4400|Can't find an answer? Contact us on LINE @tms-th or 02-118-4400|找不到答案?请通过 LINE @tms-th 或 02-118-4400 联系我们
ไม่ผูกสัญญายาว ไม่มีค่าปรับ|No long contract, no penalties|无长期合约,无罚金
คิดเงินตามรถ active ที่วิ่งจริงในเดือน (รถบริษัท + รถร่วม)|Billed on active vehicles that ran in the month (company + subcontractor)|按当月实际运行的活跃车辆计费(自有 + 外包)
รายปีลด 2 เดือน (จ่าย 10 เดือน ใช้ 12 เดือน)|Yearly saves 2 months (pay 10, use 12)|按年省 2 个月(付 10 个月用 12 个月)
คิดเงินยังไง|How is billing calculated?|如何计费?
คิดตามจำนวนรถ active ในเดือน คือรถที่มีงาน (SO/DO หรือเที่ยว) อย่างน้อย 1 งานในเดือนนั้น รถที่จอดทั้งเดือนไม่ถูกนับ ตัดรอบทุกวันที่ 1 และออกใบกำกับภาษีให้อัตโนมัติ|By active vehicles in the month: any vehicle with at least one job (SO/DO or trip) that month. Vehicles parked all month aren't counted. Billing closes on the 1st and tax invoices are issued automatically.|按当月活跃车辆计费:当月至少有 1 个任务(SO/DO 或车次)的车辆。整月停放的车辆不计。每月 1 日结算并自动开具税务发票。
นับรถร่วมไหม|Are subcontractor vehicles counted?|外包车计费吗?
นับ ถ้ารถร่วมคันนั้นวิ่งงานของคุณในเดือน เพราะใช้แอปคนขับ POD และ Settlement เหมือนรถบริษัท ผู้รับเหมาเปิดลิงก์ LINE ได้โดยไม่ต้องมีบัญชี|Yes, if it ran your jobs that month, since it uses the driver app, POD and settlement like company vehicles. Subcontractors open the LINE link without an account.|计费,若该外包车当月承运了您的任务,因为它与自有车一样使用司机 App、POD 与结算。外包商无需账号即可打开 LINE 链接。
ยกเลิกได้ไหม|Can I cancel?|可以取消吗?
ยกเลิกได้ทุกเมื่อ มีผลเมื่อครบรอบบิล ไม่มีค่าปรับ หลังยกเลิกเป็นอ่านอย่างเดียวและเก็บข้อมูลไว้ 90 วัน export ได้ตลอดช่วงนั้น|Cancel anytime, effective at the end of the billing cycle, no penalties. After cancelling the account is read-only and data is kept for 90 days, exportable throughout.|可随时取消,于账期结束生效,无罚金。取消后账号只读,数据保留 90 天,期间可随时导出。
ข้อมูลอยู่ที่ไหน|Where is my data stored?|数据存放在哪里?
เก็บบนเซิร์ฟเวอร์ในประเทศไทย เข้ารหัสทั้งระหว่างส่งและจัดเก็บ สำรองทุกวัน และเป็นไปตาม พ.ร.บ. คุ้มครองข้อมูลส่วนบุคคล (PDPA)|On servers in Thailand, encrypted in transit and at rest, backed up daily and compliant with the Personal Data Protection Act (PDPA).|存放于泰国境内服务器,传输与存储均加密,每日备份,符合个人数据保护法 (PDPA)。
ใช้กับโปรแกรมบัญชีไหนได้|Which accounting software works with it?|支持哪些财务软件?
เชื่อมตรงกับ Express, PEAK, FlowAccount, KRS และ SAP B1 หรือส่งออกไฟล์ให้นักบัญชีได้ทุกแพ็กเกจ ระบบอื่นเชื่อมผ่าน Open API|Direct integration with Express, PEAK, FlowAccount, KRS and SAP B1, or file export for your accountant on every plan. Other systems connect via Open API.|直接对接 Express、PEAK、FlowAccount、KRS 与 SAP B1,或在所有套餐导出文件给会计。其他系统通过 Open API 对接。
© 2569 TMS · บจก. ทีเอ็มเอส แพลตฟอร์ม|© 2026 TMS · TMS Platform Co., Ltd.|© 2026 TMS · TMS 平台有限公司
เงื่อนไขการใช้งาน · นโยบายความเป็นส่วนตัว (PDPA)|Terms of use · Privacy policy (PDPA)|使用条款 · 隐私政策 (PDPA)
สร้างบัญชี|Create account|创建账号
ใช้อีเมลบริษัท เราจะส่งรหัสยืนยันไปที่มือถือ|Use your company email. We'll send a verification code to your mobile.|使用公司邮箱,我们会向您的手机发送验证码。
สมัครด้วย Google|Sign up with Google|使用 Google 注册
หรือกรอกข้อมูล|or fill in your details|或填写信息
อีเมลบริษัท|Company email|公司邮箱
ใช้อีเมลโดเมนบริษัท ไม่ใช้ gmail / hotmail|Use a company domain, not gmail / hotmail|请使用公司域名邮箱,不可用 gmail / hotmail
เบอร์มือถือ|Mobile number|手机号
ใช้รับรหัส OTP|For receiving the OTP code|用于接收 OTP 验证码
รหัสผ่าน|Password|密码
ขั้น 1 จาก 3|Step 1 of 3|第 1 步,共 3 步
ขั้น 2 จาก 3|Step 2 of 3|第 2 步,共 3 步
ขั้น 3 จาก 3|Step 3 of 3|第 3 步,共 3 步
ขั้น 1 จาก 3 · ยืนยันเบอร์มือถือ|Step 1 of 3 · verify mobile|第 1 步,共 3 步 · 验证手机
เริ่มใช้งานได้ใน 3 ขั้น|Get started in 3 steps|3 步即可开始
บัญชีผู้ใช้|User account|用户账号
อีเมลบริษัทและยืนยันเบอร์มือถือ|Company email and mobile verification|公司邮箱与手机验证
ข้อมูลบริษัท|Company details|公司信息
ดึงชื่อและที่อยู่จากเลขผู้เสียภาษี|Name and address pulled from the tax ID|根据税号自动获取名称与地址
เริ่มทดลองใช้|Start trial|开始试用
ทดลองแพ็กเกจมาตรฐาน 30 วัน ไม่ใช้บัตร|Try the Standard plan for 30 days, no card|试用标准版 30 天,无需信用卡
ข้อมูลเก็บในประเทศไทย เข้ารหัสทั้งระหว่างส่งและจัดเก็บ|Data stored in Thailand, encrypted in transit and at rest|数据存放于泰国,传输与存储均加密
ยกเลิกได้ทุกเมื่อ export ข้อมูลได้|Cancel anytime and export your data|可随时取消并导出数据
อย่างน้อย 8 ตัว มีตัวเลข|At least 8 characters with a number|至少 8 位,包含数字
ยังไม่มีบัญชี|No account yet?|还没有账号?
ทดลองใช้ฟรี 30 วัน|Start 30-day free trial|免费试用 30 天
เข้าสู่ระบบด้วย Google|Sign in with Google|使用 Google 登录
ลืมรหัสผ่าน|Forgot password|忘记密码
เราจะส่งลิงก์ตั้งรหัสผ่านใหม่ไปที่อีเมล ลิงก์ใช้ได้ 30 นาที|We'll email you a reset link, valid for 30 minutes.|我们会将重置链接发送到您的邮箱,30 分钟内有效。
ส่งลิงก์|Send link|发送链接
กลับไปเข้าสู่ระบบ|Back to sign in|返回登录
เป็นสมาชิก 3 บริษัท|Member of 3 companies|您属于 3 家公司
สำนักงานใหญ่ · มาตรฐาน|Head office · Standard|总部 · 标准版
สำนักงานใหญ่ · องค์กร|Head office · Enterprise|总部 · 企业版
สาขา 00001 · เริ่มต้น|Branch 00001 · Starter|分支 00001 · 入门版
เราได้รับข้อมูลแล้ว|We've received your details|我们已收到您的信息
ทีมงานจะตรวจข้อมูลบริษัทและแจ้งผลทางอีเมลภายใน 1 วันทำการ ระหว่างนี้ยังไม่ต้องทำอะไรเพิ่ม|Our team will review your company details and email you within 1 business day. Nothing else to do for now.|团队将审核公司信息,并在 1 个工作日内邮件通知您。目前无需其他操作。
ส่งคำขอเข้าร่วมแล้ว|Join request sent|已发送加入申请
ผู้ดูแลระบบของ บจก. ศรีไทยขนส่ง จะได้รับคำขอทางอีเมล เมื่ออนุมัติคุณจะเข้าใช้งานได้ทันที|The admin of Srithai Transport will get your request by email. You'll have access as soon as they approve.|诗泰运输的管理员将通过邮件收到申请,批准后即可使用。
เราได้รับคำขอ demo แล้ว|We've received your demo request|我们已收到演示申请
ฝ่ายขายจะติดต่อเพื่อนัด demo และเสนอราคาภายใน 1 วันทำการ|Sales will contact you within 1 business day to schedule a demo and quote.|销售将在 1 个工作日内联系您安排演示并报价。
ผู้สมัคร|Applicant|申请人
รอยืนยัน|Pending verification|待确认
กลับหน้าหลัก|Back to home|返回首页
พร้อมใช้งานแล้ว|You're all set|已可使用
เข้าใช้งาน TMS|Open TMS|进入 TMS
เลขผู้เสียภาษี (13 หลัก)|Tax ID (13 digits)|税号(13 位)
ชื่อนิติบุคคล|Legal entity name|法人名称
ที่อยู่|Address|地址
สำนักงานใหญ่|Head office|总部
สาขา|Branch|分支
รถร่วม|Subcontractors|外包车
โปรแกรมบัญชีที่ใช้อยู่|Current accounting software|当前使用的财务软件
ไม่มี|None|无
ยอมรับเงื่อนไขการใช้บริการ|I accept the terms of service|我接受服务条款
ยอมรับนโยบายความเป็นส่วนตัว และยินยอมให้ประมวลผลข้อมูลตาม PDPA|I accept the privacy policy and consent to data processing under PDPA|我接受隐私政策并同意按 PDPA 处理数据
รับข่าวสารและเคล็ดลับการใช้งาน (ไม่บังคับ)|Receive news and tips (optional)|接收资讯与使用技巧(可选)
ต้องยอมรับเงื่อนไขและนโยบายความเป็นส่วนตัว|You must accept the terms and privacy policy|必须接受条款与隐私政策
ทดลองใช้มาตรฐาน 30 วัน|Standard trial, 30 days|标准版试用 30 天
แนะนำ · ครบทุกโมดูลหลักรวมรถร่วม ติดตามรถ และ connector บัญชี 1 ตัว|Recommended · all core modules incl. subcontractors, tracking and 1 accounting connector|推荐 · 全部核心模块,含外包、追踪与 1 个财务连接器
ทดลองใช้เริ่มต้น 30 วัน|Starter trial, 30 days|入门版试用 30 天
SO/DO วางแผน แอปคนขับ POD และวางบิล|SO/DO, planning, driver app, POD and billing|SO/DO、调度、司机 App、POD 与开票
องค์กร · นัด demo|Enterprise · book a demo|企业版 · 预约演示
มากกว่า 80 คัน หลายนิติบุคคล fleet เต็ม|80+ vehicles, multiple entities, full fleet|80 辆以上、多法人、完整车队
นัด demo|Book a demo|预约演示
บริษัทนี้มีบัญชีในระบบแล้ว|This company already has an account|该公司已有账号
ขอเข้าร่วมบริษัทนี้|Request to join this company|申请加入该公司
ไม่พบข้อมูลใน DBD กรอกเองได้ ทีมงานจะตรวจก่อนเปิดใช้งาน|Not found in DBD. Enter it manually; our team will review before activation.|DBD 中未找到,可手动填写,团队将在开通前审核。
พบข้อมูลจาก DBD|Found in DBD|已在 DBD 中找到
เชื่อม|connect|对接
ฟีเจอร์ / limit|Feature / limit|功能 / 限额
Feature / limit|Feature / limit|功能 / 限额
บริษัท|Company|公司
แพ็กเกจ|Plan|套餐
ใช้ออกใบกำกับภาษีค่าบริการ และตั้งค่าเอกสารของคุณ|Used for your service tax invoices and document settings|用于开具服务费税务发票及设置您的单据
เลขประจำตัวผู้เสียภาษี (13 หลัก)|Tax ID (13 digits)|税号(13 位)
เลขประจำตัวผู้เสียภาษี|Tax ID|税号
ข้อมูลจากกรมพัฒนาธุรกิจการค้า · แก้ได้|From the Department of Business Development · editable|来自商业发展厅 · 可编辑
ที่อยู่ออกใบกำกับภาษี|Tax invoice address|税务发票地址
รถบริษัท (โดยประมาณ)|Company vehicles (approx.)|自有车辆(约)
รถร่วม (โดยประมาณ)|Subcontractor vehicles (approx.)|外包车辆(约)
โปรแกรมบัญชีที่ใช้|Accounting software in use|使用中的财务软件
ส่งรหัส OTP ไปที่|OTP sent to|OTP 已发送至
เลือกแพ็กเกจ|Choose a plan|选择套餐
ทดลอง 30 วัน ไม่ต้องใช้บัตร เปลี่ยนแพ็กเกจได้ทุกเมื่อ|30-day trial, no card required. Change plans anytime.|试用 30 天,无需信用卡,可随时更换套餐。
หลังทดลอง|After trial|试用后
ประมาณการหลังทดลอง|Estimate after trial|试用后预估
ก่อน VAT|before VAT|未含增值税
ไม่มีการตัดเงินระหว่างทดลอง|no charge during the trial|试用期间不扣费
ทีมขายจะนัด demo และเสนอราคาตามจำนวนรถ|Sales will book a demo and quote by vehicle count|销售将预约演示并按车辆数报价
กรอกรหัส 6 หลักที่ส่งไปที่|Enter the 6-digit code sent to|输入发送至以下号码的 6 位验证码
ขอรหัสใหม่ได้ใน|Request a new code in|重新获取验证码剩余
ขอรหัสใหม่|Request new code|重新获取
ส่งรหัสใหม่แล้ว|New code sent|已发送新验证码
วินาที|seconds|秒
รหัสไม่ถูกต้อง เหลือ|Incorrect code, attempts left:|验证码错误,剩余次数:
รหัสหมดอายุแล้ว กดขอรหัสใหม่|Code expired, request a new one|验证码已过期,请重新获取
กรอกเลขผู้เสียภาษี 13 หลัก|Enter the 13-digit tax ID|输入 13 位税号
กดค้นหาเพื่อดึงข้อมูลบริษัท|Press Search to fetch company details|点击搜索获取公司信息
เลขผู้เสียภาษีต้องเป็นตัวเลข 13 หลัก|Tax ID must be 13 digits|税号必须为 13 位数字
กรอกชื่อนิติบุคคลและที่อยู่|Enter the legal name and address|请填写法人名称与地址
รหัสสาขา 5 หลัก เช่น 00001|5-digit branch code, e.g. 00001|5 位分支代码,如 00001
กรอกชื่อ-นามสกุล|Enter your full name|请输入姓名
อีเมลไม่ถูกต้อง|Invalid email|邮箱无效
ใช้อีเมลบริษัท|Use a company email|请使用公司邮箱
เบอร์มือถือ 9 หลักหลัง +66|9-digit mobile after +66|+66 后 9 位手机号
อย่างน้อย 8 ตัวอักษรและมีตัวเลข|At least 8 characters with a number|至少 8 位并包含数字
รหัสผ่านใช้ได้|Password OK|密码可用
กรอกอีเมลและรหัสผ่าน|Enter email and password|请输入邮箱和密码
อีเมลหรือรหัสผ่านไม่ถูกต้อง|Incorrect email or password|邮箱或密码错误
เชื่อมบัญชี Google แล้ว · ยืนยันเบอร์มือถือเพื่อความปลอดภัย|Google account linked · verify your mobile for security|已关联 Google 账号 · 请验证手机以保障安全
ส่งคำขอ demo แล้ว · ฝ่ายขายจะติดต่อภายใน 1 วันทำการ|Demo request sent · sales will contact you within 1 business day|已发送演示申请 · 销售将在 1 个工作日内联系您
หน้าฟีเจอร์อยู่ระหว่างจัดทำ · ดูรายละเอียดในตารางเปรียบเทียบ|Features page coming soon · see the comparison table|功能页面建设中 · 请查看对比表
ส่งข้อความถึงทีมงานแล้ว · เราจะติดต่อกลับภายใน 1 วันทำการ|Message sent · we'll get back to you within 1 business day|消息已发送 · 我们将在 1 个工作日内回复
ประมาณการเดือนนี้|Estimate this month|本月预估
เวอร์ชันราคา|Price version|价格版本
คงราคาเดิม|keeps current price|保持原价
ราคาใหม่สำหรับลูกค้าใหม่|new price for new customers|新客户新价格
ค้นหาลูกค้า เลขผู้เสียภาษี|Search customer, tax ID|搜索客户、税号
บทบาท (demo)|Role (demo)|角色 (演示)
คิวอนุมัติ|Approval queue|审批队列
การใช้งาน API และ AI|API & AI usage|API 与 AI 用量
ทีมงาน|Team|团队
ข้อมูล ณ|Data as of|数据截至
จากเดือนก่อน|vs last month|较上月
ลูกค้าใช้งาน|Active customers|活跃客户
ทดลองใกล้หมด 7 วัน|Trials ending in 7 days|7 天内试用到期
ติดตามก่อนหมดทดลอง|Follow up before trial ends|试用到期前跟进
เปลี่ยนเป็นจ่ายจริง|Trial-to-paid conversion|试用转付费
ทดลอง 90 วันล่าสุด|Trials, last 90 days|近 90 天试用
จ่าย|paid|付费
รถ active รวม|Total active vehicles|活跃车辆合计
ทุก tenant เดือนนี้|All tenants this month|本月所有租户
ค้างชำระรวม|Total outstanding|未付合计
MRR 6 เดือน|MRR · 6 months|MRR · 6 个月
ค่าบริการรายเดือนก่อน VAT|Monthly fees before VAT|月度服务费(未含增值税)
ต้องจัดการวันนี้|Needs action today|今日待处理
คำขอสมัครรออนุมัติ|Signups awaiting approval|待审批注册
ราย|requests|个
รายเลขผู้เสียภาษีซ้ำ|duplicate tax ID|个税号重复
รายไม่พบใน DBD|not found in DBD|个在 DBD 中查无
สลิปโอนรอตรวจ|Transfer slips to review|待审核转账凭证
ใบยอดไม่ตรง|amount mismatch|笔金额不符
ทดลองใช้หมดใน 7 วัน|Trials ending in 7 days|7 天内试用到期
ค้างชำระเกิน 30 วัน|Overdue more than 30 days|逾期超过 30 天
เป็นอ่านอย่างเดียวแล้ว|is now read-only|已转为只读
บริษัทที่ใช้ TMS ทั้งหมด · คลิกแถวเพื่อดูรายละเอียดและจัดการ|All companies on TMS · click a row for details and actions|所有使用 TMS 的公司 · 点击行查看详情并管理
รถ active / โควตา|Active vehicles / quota|活跃车辆 / 配额
วันต่ออายุ|Renewal date|续费日期
ยอดค้าง|Outstanding|未付
ตั้งแต่|since|起
คิวอนุมัติการสมัคร|Signup approval queue|注册审批队列
นโยบายปัจจุบัน: ต้องให้ทีมตรวจทุกราย|Current policy: team reviews every signup|当前策略:所有注册需团队审核
เปลี่ยนเป็น อนุมัติอัตโนมัติ|Switch to auto-approve|改为自动批准
ตรวจ DBD|DBD check|DBD 核查
สมัครเมื่อ|Signed up|注册时间
ตรงกัน|Match|一致
เลขซ้ำ|Duplicate|重复
ไม่พบใน DBD|Not in DBD|DBD 查无
ข้อมูลต่าง|Differs|不一致
ราคาและ feature matrix ที่หน้าราคาและแอปลูกค้าใช้ · บันทึกแล้วเป็นเวอร์ชันใหม่|Prices and feature matrix used by the pricing page and customer app · saving creates a new version|定价页与客户应用使用的价格与功能矩阵 · 保存即生成新版本
Preview หน้าราคา|Preview pricing page|预览定价页
บันทึกเป็นเวอร์ชันใหม่|Save as new version|另存为新版本
บันทึกเวอร์ชัน|Save version|保存版本
แสดงบนหน้าราคา|Show on pricing page|在定价页显示
ยกเลิกการแก้ไข|Discard changes|放弃修改
มีการแก้ไขที่ยังไม่บันทึก|Unsaved changes|有未保存的修改
มี|Yes|有
ราคา add-on ดึงจากข้อมูลแพ็กเกจชุดเดียวกับหน้าราคา|Add-on prices come from the same plan data as the pricing page|加购价格与定价页使用同一套套餐数据
เพิ่ม Add-on|Add add-on|新增加购
คูปอง|Coupons|优惠券
ลูกค้าที่ซื้อ|Customers using|购买客户
ขายในแพ็กเกจ|Sold in plans|适用套餐
ทุกแพ็กเกจ|All plans|所有套餐
ใบกำกับภาษีค่าบริการซอฟต์แวร์ (VAT 7%) ที่เราออกให้ลูกค้า|Software service tax invoices (VAT 7%) we issue to customers|我们向客户开具的软件服务税务发票(增值税 7%)
ส่งออกรายงานภาษีขาย|Export sales tax report|导出销项税报表
ใบกำกับภาษีที่ออก|Issued tax invoices|已开税务发票
การชำระ|Payments|付款
ตรวจสลิปโอน|Review transfer slips|审核转账凭证
ค่าบริการ TMS|TMS service fee|TMS 服务费
AI credit ใช้ / โควตา|AI credit used / quota|AI 点数已用 / 配额
ค่าใช้จ่าย AI ประมาณ|Estimated AI cost|AI 预估费用
ของโควตา|of quota|配额
ตามสัญญา|per contract|按合同
ไม่มีในแพ็กเกจ|Not in plan|套餐不含
ปรับ|Adjust|调整
ปรับ rate limit|Adjust rate limit|调整速率限制
ทีมงานและสิทธิ์|Team & permissions|团队与权限
สิทธิ์ตามบทบาท · เปลี่ยนบทบาทใน demo ที่แถบบนเพื่อทดสอบ|Role-based permissions · switch roles in the top bar to test|按角色授权 · 在顶部切换演示角色以测试
เชิญทีมงาน|Invite teammate|邀请成员
สิทธิ์|Permissions|权限
เข้าใช้ล่าสุด|Last active|最近登录
ทุกอย่าง รวมแก้แพ็กเกจและทีมงาน|Everything, incl. editing plans and team|全部权限,含编辑套餐与团队
ลูกค้า · เปลี่ยนแพ็กเกจ ขยายทดลอง ส่วนลด · อนุมัติการสมัคร|Customers · change plans, extend trials, discounts · approve signups|客户 · 更换套餐、延长试用、折扣 · 审批注册
ลูกค้า · เข้าใช้งานแทน · API/AI · อนุมัติการสมัคร · แก้แพ็กเกจไม่ได้|Customers · impersonate · API/AI · approve signups · cannot edit plans|客户 · 代为登录 · API/AI · 审批注册 · 不可编辑套餐
การเงิน · ตรวจสลิป · ส่งเตือน · ระงับบัญชีค้างชำระ|Finance · review slips · send reminders · suspend overdue accounts|财务 · 审核凭证 · 发送提醒 · 暂停逾期账户
ทุกการกระทำของทีมเรากับลูกค้า · เก็บ 2 ปี แก้ไขไม่ได้|Every action our team takes on customers · kept 2 years, immutable|团队对客户的所有操作 · 保存 2 年,不可修改
ใคร|Who|操作人
ทำอะไร|Action|操作
เข้าใช้งานแทน|Impersonate|代为登录
ยืนยันสลิปโอน|Confirm transfer slip|确认转账凭证
ขยายทดลองใช้|Extend trial|延长试用
ระงับบัญชี|Suspend account|暂停账户
ปลดระงับ|Unsuspend|解除暂停
ช่วงย้ายระบบ WMS 2 สัปดาห์|2-week WMS migration window|WMS 迁移期 2 周
ลูกค้าแจ้งนำเข้า Excel รถไม่ผ่าน ticket #4412|Customer reported vehicle Excel import failing, ticket #4412|客户反映车辆 Excel 导入失败,工单 #4412
ยอดตรงกับใบแจ้งค่าบริการ TMS-B-2611-0006|Amount matches service invoice TMS-B-2611-0006|金额与服务账单 TMS-B-2611-0006 一致
รอบอร์ดอนุมัติงบ ลูกค้าขอเวลาเพิ่ม|Waiting for board budget approval, customer asked for more time|等待董事会批预算,客户申请延期
แจ้งเตือนครบ 3 ครั้งแล้ว|Reminded 3 times already|已提醒 3 次
บันทึกแพ็กเกจเวอร์ชันใหม่|Saved new plan version|保存套餐新版本
ลูกค้าเดิม|Existing customers|现有客户
คงราคาเดิม (ไม่ย้าย)|Keep current price (don't move)|保持原价(不迁移)
ย้ายลูกค้าเดิมมาเวอร์ชันใหม่|Move existing customers to new version|将现有客户迁移到新版本
แจ้งล่วงหน้าก่อนย้าย (วัน)|Notice before moving (days)|迁移前通知(天)
ส่งอีเมลแจ้งลูกค้าและแสดง banner ในแอป|Emails customers and shows an in-app banner|邮件通知客户并在应用内显示横幅
ลูกค้าใหม่ใช้ราคาเวอร์ชันนี้ทันที · ลูกค้าเดิมคงราคาเดิมจนกว่าจะย้าย|New customers get this version immediately · existing customers keep their price until moved|新客户立即使用此版本 · 现有客户保持原价直至迁移
มีลูกค้าใช้|In use|使用中
เลิกขาย|Retired|已停售
เวอร์ชันปัจจุบัน · ลูกค้าใหม่|Current · new customers|当前版本 · 新客户
ลูกค้าเดิมคงราคานี้|Existing customers kept|现有客户保留
ย้ายลูกค้าแล้ว|Customers moved|已迁移
ลูกค้าในเวอร์ชันนี้|Customers on this version|此版本客户
ราคา / รถ|Price / vehicle|价格 / 车
ปิด AI|Turn off AI|关闭 AI
เปิด AI|Turn on AI|开启 AI
ปิด MCP|Turn off MCP|关闭 MCP
เปิด MCP|Turn on MCP|开启 MCP
เรียก REST เดือนนี้|REST calls this month|本月 REST 调用
เรียก MCP เดือนนี้|MCP calls this month|本月 MCP 调用
ค่าใช้จ่าย AI ประมาณ (ต้นทุนเรา)|Estimated AI cost (our cost)|AI 预估费用(我方成本)
บันทึก audit log|logged to audit log|已记入审计日志
ปิด AI/MCP ต้องระบุเหตุผล|turning off AI/MCP requires a reason|关闭 AI/MCP 需填写原因
ใกล้เต็มโควตา AI|near AI quota|接近 AI 配额
ต้นทุน AI ประมาณ|estimated AI cost|AI 预估成本
AI credit รวม|AI credit total|AI 点数合计
ครั้ง|calls|次
ระงับ|Suspended|已暂停
บันทึกในเครื่องตามเวลาที่ทำจริง|saved on device with actual time|按实际时间保存在设备
ส่งให้ฝ่ายบัญชีตรวจ|Send to accounting for review|提交财务审核
AI อ่านใบเสร็จแล้ว|AI read the receipt|AI 已识别收据
ช่องไม่มั่นใจ ตรวจก่อนส่ง|uncertain fields, check before sending|个字段不确定,提交前请核对
ตรวจให้ตรงกับใบเสร็จก่อนส่ง|check against the receipt before sending|提交前请与收据核对
ไม่มั่นใจ · ตรวจกับใบเสร็จ|Uncertain · check the receipt|不确定 · 请核对收据
รูปอยู่ในคิวส่งข้อมูล|Photo is in the sync queue|照片在上传队列中
จะอ่านใบเสร็จอัตโนมัติเมื่อมีสัญญาณ|The receipt will be read automatically when you're back online|有信号后将自动识别收据
กรอกเอง|Enter manually|手动填写
ถ่ายรูปใบเสร็จแล้ว AI จะเติมวันที่ ปั๊ม ลิตร ราคา และยอดให้เป็นร่าง|Take a photo of the receipt and AI drafts the date, station, litres, price and total|拍摄收据后 AI 将预填日期、加油站、升数、单价与总额
สถานที่|Place|地点
ยอดรวม|Total|合计
Add-on และคูปอง|Add-ons & coupons|加购与优惠券
เลขที่|No.|编号
มาตรฐาน|Standard|标准版
เริ่มต้น|Starter|入门版
/ รถ|/ vehicle|/ 车
ระบบจัดการขนส่ง (TMS) สำหรับธุรกิจขนส่ง B2B|Transport management system (TMS) for B2B carriers|面向 B2B 运输企业的运输管理系统 (TMS)
ระบบจัดการขนส่งสำหรับบริษัทรถบรรทุกไทย ทั้งรถบริษัทและรถร่วม|Transport management for Thai trucking companies, for your own fleet and subcontractors|为泰国卡车运输公司打造的运输管理系统,自有车与外包车统一管理
รับงาน จัดรถ ติดตาม เก็บ POD และวางบิลในระบบเดียว ใช้ได้ทันทีโดยไม่ต้องมี ERP และเชื่อมโปรแกรมบัญชีได้เมื่อพร้อม|Take orders, dispatch, track, collect POD and bill in one system. Works on its own without an ERP, and connects to your accounting software when you're ready.|接单、派车、追踪、收集 POD、开票,一个系统完成。无需 ERP 即可使用,准备好后可对接财务软件。
ดูราคา|See pricing|查看价格
ไม่ต้องใช้บัตร · ยกเลิกได้ทุกเมื่อ|No card required · cancel anytime|无需信用卡 · 可随时取消
เชื่อมต่อได้กับ|Connects with|可对接
งานหนึ่งงาน ตั้งแต่รับคำสั่งจนได้เงิน|One job, from order to payment|一单业务,从接单到回款
ทุกขั้นอยู่ในระบบเดียว ไม่ต้องคีย์ซ้ำระหว่างฝ่าย|Every step in one system, no re-keying between teams|所有环节在一个系统,部门之间无需重复录入
วิ่งงาน / ติดตาม|On the road / tracking|运输 / 追踪
วางบิล / รับชำระ|Billing / payment|开票 / 收款
รับคำสั่งจาก LINE อีเมล CSV หรือ API เข้ากล่องเดียว|Orders from LINE, email, CSV or API land in one inbox|来自 LINE、邮件、CSV 或 API 的订单进入同一个收件箱
งานจาก LINE และอีเมลถูกร่างเป็นใบสั่งขนส่ง (SO) ให้ตรวจก่อนยืนยัน|LINE and email requests are drafted as shipment orders (SO) for you to check before confirming|LINE 与邮件需求自动起草为运输订单 (SO),确认前由您审核
ราคาคำนวณจาก rate card ของลูกค้าแต่ละราย|Prices come from each customer's rate card|价格按每个客户的费率卡计算
จับคู่ลูกค้าและสถานที่กับข้อมูลหลักอัตโนมัติ|Customers and locations are matched to master data automatically|客户与地点自动匹配主数据
ลาก SO ลงรถบนกระดานวางแผน ระบบเตือนก่อนจัดผิด|Drag SOs onto vehicles on the planning board, with warnings before a bad assignment|在调度板上把 SO 拖到车辆上,分配有误时系统先提醒
เห็นรถทุกคันตามช่วงเวลาในวันเดียว|See every vehicle on one day's timeline|在一天的时间轴上查看所有车辆
เตือนน้ำหนักเกินพิกัด ใบขับขี่ไม่ตรงประเภท และเอกสารรถหมดอายุ|Warns on overweight loads, wrong licence class and expired vehicle documents|提醒超载、驾照类别不符与车辆文件过期
"เสนอรถ" เทียบรถบริษัทกับรถร่วมจากต้นทุน ตรงเวลา และความจุ|"Suggest vehicle" compares company and subcontractor vehicles on cost, on-time rate and capacity|"推荐车辆"按成本、准时率与载重比较自有车与外包车
ติดตามรถจาก GPS หรือแอปคนขับบนแผนที่เดียว|Track vehicles from GPS or the driver app on one map|在同一地图上通过 GPS 或司机 App 追踪车辆
เตือนเมื่อรถล่าช้ากว่า ETA ออกนอกเส้นทาง หรือจอดนาน|Alerts when a vehicle runs past ETA, leaves the route or stops too long|车辆晚于 ETA、偏离路线或停留过久时提醒
ส่งลิงก์ติดตามให้ผู้รับทาง SMS หรือ LINE|Send tracking links to consignees by SMS or LINE|通过 SMS 或 LINE 向收货人发送追踪链接
ใช้ได้ทั้งรถบริษัทและรถร่วมที่ไม่มีกล่อง GPS|Works for company and subcontractor vehicles without a GPS box|自有车与无 GPS 设备的外包车均可使用
คนขับถ่ายรูป เซ็นรับ และนับจำนวนในแอป ใช้ได้แม้ไม่มีสัญญาณ|Drivers take photos, collect signatures and count items in the app, even without signal|司机在 App 中拍照、签收并清点数量,无信号也可使用
บันทึกในเครื่องตามเวลาที่ทำจริง แล้วส่งเมื่อมีสัญญาณ|Saved on the phone with the actual time, sent when signal returns|按实际时间保存在手机上,有信号时上传
ส่งไม่ครบหรือตีกลับต้องเลือกเหตุผลและแนบรูป|Short deliveries and returns require a reason and a photo|少送或退回需选择原因并附照片
ฝ่ายบัญชีเห็น POD ทันทีที่ส่งขึ้นระบบ|Accounting sees the POD as soon as it's uploaded|POD 上传后财务立即可见
ติ๊ก DO ที่ส่งแล้ว ออกใบวางบิลและใบกำกับภาษีในระบบ|Tick delivered DOs and issue billing notes and tax invoices in the system|勾选已送达的 DO,在系统内开具对账单与税务发票
แยก VAT ค่าขนส่ง (ยกเว้น) กับบริการประกอบ (7%) ตามเงื่อนไขลูกค้า|Splits VAT between freight (exempt) and ancillary services (7%) per customer terms|按客户条款区分运费(免税)与附加服务 (7%) 的增值税
บันทึกรับชำระและหัก ณ ที่จ่ายที่ลูกค้าหัก ดูอายุลูกหนี้ได้|Record payments and customer withholding tax, with receivables aging|记录收款与客户代扣税,查看应收账龄
ส่งต่อโปรแกรมบัญชี หรือส่งออกไฟล์ให้นักบัญชี|Send to your accounting software or export files for your accountant|推送到财务软件或导出文件给会计
ทำมาสำหรับงานขนส่งในไทยโดยเฉพาะ|Built for Thai transport operations|专为泰国运输业务打造
ส่งงานให้รถร่วมผ่าน LINE แล้วจ่ายเงินจาก Settlement|Send jobs to subcontractors over LINE and pay them through settlement|通过 LINE 向外包派单,并通过结算付款
ผู้รับเหมาเปิดลิงก์จาก LINE รับงานและกรอกทะเบียนรถได้โดยไม่ต้องมีบัญชี ระบบเทียบกำไรก่อนส่งข้อเสนอ และส่งต่อผู้รับเหมาลำดับถัดไปเมื่อปฏิเสธ|Subcontractors open the LINE link to accept the job and enter the plate without an account. The system checks your margin before sending the offer and passes it to the next subcontractor if declined.|外包商打开 LINE 链接即可接单并填写车牌,无需账号。系统在发出报价前核算利润,被拒后自动转给下一位外包商。
เห็นคะแนนตรงเวลาและราคา 5 ครั้งล่าสุดของผู้รับเหมาแต่ละราย|See each subcontractor's on-time score and last 5 prices|查看每位外包商的准时评分与最近 5 次价格
Settlement รวมเที่ยว หักเงินเบิกและหัก ณ ที่จ่าย 1% แล้วออกหนังสือรับรอง 50 ทวิ|Settlement totals trips, deducts advances and 1% withholding tax, and issues the 50 Tawi certificate|结算汇总车次,扣除预支与 1% 代扣税,并开具 50 Tawi 扣税证明
ทุกการแก้ยอดมีประวัติก่อน–หลังและเหตุผล|Every amount change keeps a before/after history and reason|每次金额修改都保留前后记录与原因
แอปคนขับที่ใช้ได้ตอนไม่มีสัญญาณ พร้อม ePOD|A driver app that works without signal, with ePOD|无信号也能用的司机 App,含电子 POD
คนขับเห็นงานวันนี้ ตรวจรถก่อนออก ถ่ายรูปและเซ็นรับที่ปลายทาง ทุกขั้นบันทึกในเครื่องพร้อมเวลาจริง แล้วส่งขึ้นระบบเมื่อมีสัญญาณ|Drivers see today's jobs, do the pre-trip check, and take photos and signatures at drop-off. Every step is saved on the phone with the real time and uploaded when signal returns.|司机查看今日任务、出车前检查、在卸货点拍照签收。每一步按实际时间保存在手机上,有信号时上传。
ปุ่มใหญ่ เป้ากด 48px อ่านง่ายกลางแดด|Large buttons, 48px tap targets, readable in sunlight|大按钮,48px 点击区域,阳光下也清晰
ตรวจรถก่อนออก ข้อวิกฤตผิดปกติห้ามออกรถ|Pre-trip check; a failed critical item blocks departure|出车前检查,关键项异常禁止出车
บันทึกค่าใช้จ่ายพร้อมรูปใบเสร็จ AI อ่านยอดให้เป็นร่าง|Log expenses with a receipt photo; AI drafts the amounts|附收据照片记录费用,AI 起草金额
วางบิล ใบกำกับภาษี และหัก ณ ที่จ่าย ออกได้เองในระบบ|Issue billing notes, tax invoices and withholding tax in the system|在系统内开具对账单、税务发票与代扣税
ออกเอกสารจาก DO ที่ส่งแล้ว เอกสารที่ออกแล้วถูกล็อก ปรับยอดผ่านใบลดหนี้หรือใบเพิ่มหนี้อ้างใบเดิม เมื่อพร้อมค่อยส่งต่อโปรแกรมบัญชีที่ใช้อยู่|Documents are issued from delivered DOs and locked once issued; adjustments go through credit or debit notes against the original. Send to your accounting software when you're ready.|从已送达的 DO 开具单据,开具后锁定;通过引用原单的贷项或借项通知单调整金额。准备好后再推送到现用财务软件。
ค่าขนส่งยกเว้น VAT บริการประกอบ VAT 7% ตามเงื่อนไขลูกค้า|Freight VAT-exempt, ancillary services at 7% VAT, per customer terms|按客户条款,运费免增值税,附加服务 7% 增值税
ส่งออกให้นักบัญชีเป็นรูปแบบทั่วไป Express PEAK หรือ FlowAccount|Export for your accountant in general, Express, PEAK or FlowAccount format|按通用、Express、PEAK 或 FlowAccount 格式导出给会计
ตรวจบิลรถร่วมกับ POD และ rate card ก่อนอนุมัติจ่าย|Check subcontractor bills against POD and the rate card before approving payment|批准付款前,对照 POD 与费率卡核对外包账单
ดูแลรถทั้งกอง: เอกสาร PM ยาง น้ำมัน และอุบัติเหตุ|Run the whole fleet: documents, PM, tyres, fuel and accidents|管理整个车队:文件、保养、轮胎、燃油与事故
รถที่ประกัน ภาษี หรือ พรบ. หมดอายุถูกกันไม่ให้จ่ายงานบนกระดานวางแผน ใบสั่งซ่อมผูกกับรถและคนขับ ต้นทุนไหลเข้ารายงานกำไรต่อรถ|Vehicles with expired insurance, tax or compulsory insurance are blocked on the planning board. Work orders link to vehicle and driver, and costs flow into profit per vehicle.|保险、车税或强制险过期的车辆在调度板上禁止派车。维修单关联车辆与司机,成本计入单车利润报表。
แจ้งเตือนเอกสารรถก่อนหมดอายุ 30 วัน|Vehicle document alerts 30 days before expiry|车辆文件到期前 30 天提醒
บันทึกยางรายตำแหน่ง ความลึกดอก และการสลับยาง|Tyre records by position, tread depth and rotations|按位置记录轮胎、花纹深度与换位
ถังน้ำมันบริษัท เทียบยอดระบบกับวัดจริง|Company fuel tanks, system vs measured stock|公司油罐,系统数与实测对比
กำไรต่อเที่ยว ต่อลูกค้า ต่อรถ และ OTIF|Profit per trip, customer and vehicle, plus OTIF|单车次、单客户、单车利润与 OTIF
รายได้จาก DO และต้นทุนจากเที่ยวรถ รถร่วม น้ำมัน และค่าใช้จ่ายหน้างาน รวมเป็นกำไรจริงของแต่ละงาน ตั้งเวลาส่งรายงานทางอีเมลหรือ LINE ได้|Revenue from DOs and costs from trips, subcontractors, fuel and on-site expenses add up to real profit per job. Schedule reports by email or LINE.|DO 收入与车次、外包、燃油、现场费用成本合计为每单的真实利润。可定时通过邮件或 LINE 发送报表。
OTIF แยกตามลูกค้าและเส้นทาง|OTIF by customer and route|按客户与路线的 OTIF
ลูกหนี้คงค้างตามอายุหนี้|Outstanding receivables by age|按账龄的应收余额
ส่งออก Excel ได้ทุกรายงาน|Export any report to Excel|所有报表可导出 Excel
สำหรับนักพัฒนาและ AI|For developers and AI|面向开发者与 AI
Open API, Webhook และ MCP สำหรับเชื่อมระบบของคุณ|Open API, webhooks and MCP to connect your systems|Open API、Webhook 与 MCP,对接您的系统
สร้าง SO ดึงสถานะงาน และรับ webhook เมื่อส่งของหรือออกใบแจ้งหนี้ เชื่อม Claude หรือ ChatGPT ผ่าน MCP เพื่อสั่งงานและถามข้อมูลด้วยภาษาธรรมดา โดยใช้สิทธิ์เดียวกับผู้ใช้|Create SOs, read job status and receive webhooks on delivery or invoicing. Connect Claude or ChatGPT through MCP to create jobs and ask questions in plain language, with the same permissions as the user.|创建 SO、读取任务状态,并在送达或开票时接收 webhook。通过 MCP 连接 Claude 或 ChatGPT,用日常语言下达任务与查询,权限与用户一致。
REST API พร้อม sandbox และ API key แยกตาม scope|REST API with a sandbox and scoped API keys|REST API,含沙箱与按范围划分的 API key
Webhook ลงลายเซ็น HMAC พร้อมส่งซ้ำอัตโนมัติ|HMAC-signed webhooks with automatic retries|HMAC 签名的 Webhook,自动重试
ฟิลด์เพิ่มเติมของคุณอยู่ใน API และ webhook ทันที|Your custom fields appear in the API and webhooks right away|您的自定义字段立即出现在 API 与 webhook 中
อ่านเอกสาร API|Read the API docs|阅读 API 文档
ตั้งค่า MCP|Set up MCP|设置 MCP
สร้างใบสั่งขนส่ง · POST /v1/orders|Create a shipment order · POST /v1/orders|创建运输订单 · POST /v1/orders
AI ช่วยงาน|AI assistance|AI 辅助
AI ร่าง คนยืนยัน|AI drafts, people confirm|AI 起草,人工确认
AI ช่วยงานที่ต้องพิมพ์ซ้ำทุกวัน ทุกผลลัพธ์เป็นร่างที่บอกค่าความมั่นใจรายช่อง ช่องที่ไม่มั่นใจมีขอบสีส้ม และต้องมีคนในทีมกดยืนยันก่อนบันทึก|AI handles the typing you repeat every day. Every result is a draft with a confidence score per field; uncertain fields get an orange border, and someone on your team must confirm before anything is saved.|AI 处理每天重复的录入工作。所有结果都是带逐字段置信度的草稿,不确定的字段显示橙色边框,必须由团队成员确认后才保存。
สร้าง SO จากข้อความ LINE|Create SOs from LINE messages|从 LINE 消息创建 SO
วางข้อความหรือไฟล์ ระบบแยกลูกค้า จุดรับส่ง น้ำหนัก ประเภทรถ และเลข PO เป็นร่างใบสั่ง|Paste a message or file and the system extracts customer, pickup and drop, weight, vehicle type and PO number into a draft order|粘贴消息或文件,系统提取客户、取送点、重量、车型与 PO 号,生成订单草稿
อ่านใบเสร็จ|Read receipts|识别收据
ใบเสร็จน้ำมัน ทางด่วน และค่าซ่อม ถูกอ่านเป็นวันที่ ปั๊ม ลิตร และยอด ให้คนขับหรือบัญชีตรวจ|Fuel, toll and repair receipts are read into date, station, litres and amount for the driver or accounting to check|燃油、过路费与维修收据识别为日期、加油站、升数与金额,由司机或财务核对
ตรวจว่ารูปชัด มีลายเซ็น และจำนวนตรงกับใบส่งของ รายการที่น่าสงสัยเข้าคิวให้คนตรวจ|Checks the photo is clear, signed and matches the delivery order quantities; doubtful items go to a review queue|检查照片清晰、有签名且数量与送货单一致,可疑项进入人工审核队列
ผลลัพธ์ที่วัดได้|Measured results|可衡量的成果
ตัวอย่าง · รอข้อมูลจริง|Example · awaiting real data|示例 · 待真实数据
เวลาจัดรถต่อวัน|Daily dispatch time|每日派车时间
ลดลง —%|—% less|减少 —%
เทียบก่อนใช้ TMS|vs before TMS|与使用 TMS 前相比
วางบิลหลังส่งของ|Billing after delivery|送达后开票
เร็วขึ้น — วัน|— days faster|快 — 天
จากวันที่ส่งถึงวันออกใบแจ้งหนี้|from delivery date to invoice date|从送达日到开票日
งานที่มี POD ครบ|Jobs with complete POD|POD 完整的任务
ภายในวันที่ส่ง|on the delivery day|在送达当天
ส่งตรงเวลา (OTIF)|On time in full (OTIF)|准时足量 (OTIF)
ทุกลูกค้า ทุกเส้นทาง|all customers, all routes|所有客户、所有路线
ตัวเลขจะใส่เมื่อมีผลจากลูกค้าที่ใช้งานจริงและยินยอมให้เปิดเผย|Figures will be added once real customers have results and agree to share them|待真实客户产生成果并同意公开后填入数据
จ่ายตามรถที่วิ่งจริงในเดือน|Pay for the vehicles that actually run each month|按当月实际运行车辆付费
เปรียบเทียบทั้งหมด|Compare all plans|对比全部套餐
ความปลอดภัยและข้อมูล|Security & data|安全与数据
ข้อมูลของแต่ละบริษัทแยกกัน และเป็นของคุณ|Each company's data is isolated, and it's yours|每家公司的数据相互隔离,数据归您所有
แยกข้อมูลรายบริษัท|Per-company data isolation|按公司隔离数据
ข้อมูลแต่ละบริษัทแยกกันทั้งฐานข้อมูลและไฟล์ ผู้ใช้เห็นเฉพาะบริษัทที่ได้รับเชิญ|Each company's database records and files are separate; users only see companies they're invited to|每家公司的数据库与文件相互隔离,用户只能看到受邀的公司
ยืนยันตัวตน 2 ชั้น (2FA)|Two-factor authentication (2FA)|双重身份验证 (2FA)
บังคับ 2FA ทั้งบริษัทได้ ตั้ง session timeout และ IP allowlist|Enforce 2FA company-wide, set session timeout and IP allowlist|可全公司强制 2FA,设置会话超时与 IP 白名单
ผู้วางแผน บัญชี ผู้อนุมัติ ดูอย่างเดียว และนักพัฒนา เห็นเฉพาะงานของตัวเอง|Planners, accounting, approvers, read-only users and developers see only their own work|调度、财务、审批人、只读用户与开发者只能看到各自的工作
Audit log|Audit log|审计日志
ทุกการแก้ไขเก็บว่าใคร ทำอะไร เมื่อไร และเหตุผล แก้ย้อนหลังไม่ได้|Every change records who, what, when and why, and can't be altered later|每次修改记录操作人、内容、时间与原因,事后不可更改
PDPA|PDPA|PDPA
เก็บในประเทศไทย เข้ารหัสทั้งระหว่างส่งและจัดเก็บ ขอลบข้อมูลส่วนบุคคลได้|Stored in Thailand, encrypted in transit and at rest; personal data can be deleted on request|存放于泰国,传输与存储均加密;可申请删除个人数据
Export ได้ทุกเมื่อ|Export anytime|随时导出
ส่งออกข้อมูลทั้งหมดเป็น Excel หรือ CSV ได้ตลอด ไม่ล็อกข้อมูลไว้กับเรา|Export all your data to Excel or CSV at any time; your data is never locked in|随时将全部数据导出为 Excel 或 CSV,数据不会被锁定
ก่อนเริ่มใช้งาน|Before you start|开始使用前
ต้องมี ERP หรือโปรแกรมบัญชีก่อนไหม|Do I need an ERP or accounting software first?|需要先有 ERP 或财务软件吗?
ไม่ต้อง TMS ออกใบวางบิล ใบแจ้งหนี้ ใบกำกับภาษี และใบเสร็จได้เอง เมื่อพร้อมค่อยเชื่อม Express, PEAK, FlowAccount, KRS หรือ SAP B1 หรือส่งออกไฟล์ให้นักบัญชี|No. TMS issues billing notes, invoices, tax invoices and receipts itself. When you're ready, connect Express, PEAK, FlowAccount, KRS or SAP B1, or export files for your accountant.|不需要。TMS 可自行开具对账单、发票、税务发票与收据。准备好后再对接 Express、PEAK、FlowAccount、KRS 或 SAP B1,或导出文件给会计。
รถร่วมต้องลงแอปหรือมีบัญชีไหม|Do subcontractors need the app or an account?|外包商需要安装 App 或注册账号吗?
ไม่ต้อง ผู้รับเหมาได้ลิงก์ทาง LINE เปิดแล้วรับงาน กรอกทะเบียนและคนขับ และส่ง POD ได้เลย ลิงก์มีอายุ 48 ชั่วโมง|No. Subcontractors get a LINE link to accept the job, enter plate and driver, and send POD. The link is valid for 48 hours.|不需要。外包商通过 LINE 链接即可接单、填写车牌与司机并提交 POD,链接有效期 48 小时。
คนขับใช้แอปตอนไม่มีสัญญาณได้ไหม|Does the driver app work without signal?|司机 App 没有信号能用吗?
ได้ ทุกขั้นบันทึกในเครื่องพร้อมเวลาที่ทำจริง แล้วส่งขึ้นระบบอัตโนมัติเมื่อมีสัญญาณ คนขับเห็นคิวที่รอส่งในแอป|Yes. Every step is saved on the phone with the actual time and uploaded automatically when signal returns. Drivers can see the pending queue in the app.|可以。每一步按实际时间保存在手机上,有信号时自动上传,司机可在 App 中查看待上传队列。
ย้ายข้อมูลจาก Excel ได้ไหม|Can I move my data from Excel?|可以从 Excel 迁移数据吗?
ได้ นำเข้ารถ คนขับ ลูกค้า สถานที่ และ rate card จาก Excel ระบบจับคู่คอลัมน์ให้และแสดงแถวที่ผิดก่อนนำเข้า|Yes. Import vehicles, drivers, customers, locations and rate cards from Excel; the system maps columns and shows rows with errors before importing.|可以。从 Excel 导入车辆、司机、客户、地点与费率卡,系统自动匹配列并在导入前显示错误行。
คิดเงินอย่างไร|How is pricing calculated?|如何计费?
คิดตามจำนวนรถ active ในเดือน คือรถที่มีงานอย่างน้อย 1 งาน ผู้ใช้ไม่จำกัด รายปีลด 2 เดือน ไม่ผูกสัญญา|By active vehicles per month, meaning vehicles with at least one job. Unlimited users, yearly saves 2 months, no contract.|按当月活跃车辆计费,即至少有 1 个任务的车辆。用户不限,按年省 2 个月,无合约。
AI ทำอะไรได้บ้าง และใครตัดสินใจ|What does the AI do, and who decides?|AI 能做什么?由谁决定?
AI ร่าง SO จากข้อความ อ่านใบเสร็จ และตรวจรูป POD ทุกอย่างเป็นร่างที่มีค่าความมั่นใจ คนในทีมต้องตรวจและยืนยันก่อนบันทึกเสมอ|AI drafts SOs from messages, reads receipts and checks POD photos. Everything is a draft with a confidence score, and someone on your team always checks and confirms before saving.|AI 从消息起草 SO、识别收据并检查 POD 照片。所有结果都是带置信度的草稿,保存前必须由团队成员审核确认。
ข้อมูลเก็บที่ไหน และขอข้อมูลคืนได้ไหม|Where is data stored, and can I get it back?|数据存放在哪里?可以取回吗?
เก็บบนเซิร์ฟเวอร์ในประเทศไทย เข้ารหัสทั้งระหว่างส่งและจัดเก็บ export ข้อมูลทั้งหมดได้ทุกเมื่อ หลังยกเลิกเก็บไว้ 90 วัน|On servers in Thailand, encrypted in transit and at rest. Export everything at any time; after cancelling, data is kept for 90 days.|存放于泰国服务器,传输与存储均加密。可随时导出全部数据,取消后保留 90 天。
เชื่อมกับระบบของเราเองได้ไหม|Can it connect to our own systems?|可以对接我们自己的系统吗?
ได้ผ่าน Open API และ Webhook มีเอกสารและ sandbox ให้ทดสอบ และเชื่อมผู้ช่วย AI อย่าง Claude หรือ ChatGPT ผ่าน MCP ได้|Yes, through the Open API and webhooks, with docs and a sandbox for testing. You can also connect AI assistants like Claude or ChatGPT through MCP.|可以,通过 Open API 与 Webhook,提供文档与测试沙箱,也可通过 MCP 连接 Claude 或 ChatGPT 等 AI 助手。
เริ่มจากรถ 1 คันและงานพรุ่งนี้|Start with one vehicle and tomorrow's jobs|从 1 辆车和明天的任务开始
ทดลองแพ็กเกจมาตรฐานครบทุกโมดูล 30 วัน ไม่ต้องใช้บัตร|Try the Standard plan with every module for 30 days, no card required|免费试用标准版全部模块 30 天,无需信用卡
ระบบจัดการขนส่งสำหรับบริษัทรถบรรทุกไทย|Transport management for Thai trucking companies|为泰国卡车运输公司打造的运输管理系统
ผลิตภัณฑ์|Product|产品
นักพัฒนา|Developers|开发者
เกี่ยวกับเรา|About us|关于我们
นโยบายความเป็นส่วนตัว|Privacy policy|隐私政策
เงื่อนไขการใช้งาน|Terms of use|使用条款
ข้อมูลเก็บในประเทศไทย · เป็นไปตาม PDPA|Data stored in Thailand · PDPA compliant|数据存放于泰国 · 符合 PDPA
เมนู|Menu|菜单
กระดานวางแผนรถ|Vehicle planning board|车辆调度板
หน้าจ่ายงานรถร่วม|Subcontractor dispatch screen|外包派单页面
หน้ายืนยันการส่ง (POD) ในแอปคนขับ|Delivery confirmation (POD) in the driver app|司机 App 中的签收确认 (POD)
หน้า Settlement รถร่วม|Subcontractor settlement screen|外包结算页面
หน้าเอกสารรถ|Vehicle documents screen|车辆文件页面
หน้ารายงาน|Reports screen|报表页面
หน้าติดตามรถ|Vehicle tracking screen|车辆追踪页面
หน้าวางบิลและใบแจ้งหนี้|Billing and invoices screen|开票与发票页面
รถ active|active vehicles|活跃车辆
ผู้ใช้ไม่จำกัด|unlimited users|用户不限
ราคาเดิม|Legacy price|原价
ไม่มีในแพ็กเกจนี้|Not included in this plan|此套餐不含
ต่อปี · จ่ายรายปี 10 เดือน (ลด 2 เดือน) · ก่อน VAT|Per year · billed yearly, 10 months (2 free) · before VAT|每年 · 按年付 10 个月(省 2 个月)· 未含增值税
ต่อปี · รายเดือน × 12 · ก่อน VAT|Per year · monthly × 12 · before VAT|每年 · 按月 × 12 · 未含增值税
VAT 7% ของยอดต่อปี|VAT 7% on yearly total|年度金额的 7% 增值税
ต่อปี รวม VAT|Per year incl. VAT|每年(含增值税)
ข้อความ LINE ลูกค้าเข้า AI ร่าง SO ให้|A customer LINE message comes in, AI drafts the SO|客户 LINE 消息进来,AI 起草 SO
คุณวิไลจากสยามพลาสติกพิมพ์ใน LINE ว่าพรุ่งนี้รับเม็ดพลาสติก 12 ตันที่คลังบางนา ระบบอ่านเป็นร่างใบสั่งขนส่งพร้อมลูกค้า จุดรับส่ง น้ำหนัก และราคาจาก rate card รอให้คุณกดยืนยัน|Khun Wilai from Siam Plastic types in LINE that tomorrow's pickup is 12 tonnes of resin at the Bang Na warehouse. The system turns it into a draft shipment order with customer, stops, weight and the rate-card price, waiting for you to confirm.|暹罗塑料的 Wilai 在 LINE 上说明天在邦纳仓库提 12 吨塑料粒。系统将其识别为运输订单草稿,带出客户、取送点、重量与费率卡价格,等待您确认。
ลากงานลงรถ ระบบเตือนก่อนจัดผิด|Drag jobs onto trucks, warned before a bad assignment|把任务拖到车上,分配有误前先提醒
ลาก SO ลงแถวรถบนกระดานวางแผน รถ 71-0457 ตรวจสภาพไม่ผ่านและน้ำหนักเกินพิกัด 800 กก. แถวนั้นจึงถูกกันไว้ ระบบเสนอรถคันอื่นที่รับน้ำหนักได้แทน|Drag SOs onto vehicle rows on the planning board. Truck 71-0457 failed its inspection and is 800 kg over capacity, so its row is blocked and the system suggests another truck that can take the load.|在调度板上把 SO 拖到车辆行。车辆 71-0457 车检未通过且超载 800 公斤,因此该行被锁定,系统推荐另一辆可承载的车。
ส่งงานให้รถร่วมผ่าน LINE รับงานใน 3 นาที|Send a job to a subcontractor over LINE, accepted in 3 minutes|通过 LINE 派单给外包,3 分钟内接单
งานบางปูไปแหลมฉบังไม่มีรถบริษัทว่าง ส่งข้อเสนอราคา ฿5,800 ให้ศรีราชาโลจิสติกส์ทาง LINE ผู้รับเหมาเปิดลิงก์ กรอกทะเบียน 74-5521 ชบ. และชื่อคนขับ โดยไม่ต้องมีบัญชี|No company truck is free for the Bang Pu to Laem Chabang job, so a ฿5,800 offer goes to Sriracha Logistics over LINE. The subcontractor opens the link and enters plate 74-5521 and the driver's name, no account needed.|邦浦到林查班的任务没有空闲自有车,于是通过 LINE 向是拉差物流发出 ฿5,800 报价。外包商打开链接填写车牌 74-5521 与司机姓名,无需账号。
คนขับถ่าย POD ในที่ไม่มีสัญญาณ|The driver captures POD with no signal|司机在无信号处拍摄 POD
ที่โรงงานชลบุรีไม่มีสัญญาณ คนขับถ่ายรูปสินค้า ให้ผู้รับเซ็น และนับจำนวนในแอป ทุกอย่างบันทึกพร้อมเวลา 13:25 ในเครื่อง แล้วส่งขึ้นระบบเองเมื่อกลับมามีสัญญาณ|There's no signal at the Chonburi plant. The driver photographs the goods, collects a signature and counts items in the app. Everything is saved on the phone at 13:25 and uploads on its own once the signal is back.|春武里工厂没有信号。司机在 App 中拍摄货物、请收货人签名并清点数量。所有记录以 13:25 保存在手机上,恢复信号后自动上传。
วางบิล 12 ใบจาก DO ที่ POD ผ่าน|Bill 12 invoices from DOs with approved POD|从 POD 已通过的 DO 开出 12 张发票
ฝ่ายบัญชีเลือกลูกค้าและงวด ติ๊ก DO ที่ส่งแล้วและ POD ผ่าน แล้วออกใบวางบิลและใบแจ้งหนี้/ใบกำกับภาษี ค่าขนส่งยกเว้น VAT ส่วนบริการประกอบคิด VAT 7% ตามเงื่อนไขลูกค้า|Accounting picks the customer and period, ticks DOs that are delivered with POD approved, then issues the billing note and invoice / tax invoice. Freight is VAT-exempt and ancillary services carry 7% VAT, per customer terms.|财务选择客户与账期,勾选已送达且 POD 通过的 DO,然后开具对账单与发票/税务发票。按客户条款,运费免增值税,附加服务计 7% 增值税。
จัดรถ ตามงาน เก็บ POD วางบิล — จบในที่เดียว|Dispatch, track, collect POD, bill. All in one place.|派车、追踪、收集 POD、开票,一站完成
สำหรับบริษัทขนส่ง 10–200 คัน ทั้งรถบริษัทและรถร่วม ใช้ได้ทันทีโดยไม่ต้องมี ERP|For carriers with 10–200 trucks, own fleet and subcontractors. Works right away, no ERP needed.|适合 10–200 辆车的运输公司,自有车与外包车皆可,无需 ERP 即可使用
ดูราคา →|See pricing →|查看价格 →
POD ส่งแล้ว 13:25|POD sent 13:25|POD 已上传 13:25
DO-2611-00060 · ลายเซ็นครบ · 3 รูป|DO-2611-00060 · signed · 3 photos|DO-2611-00060 · 已签名 · 3 张照片
รถร่วมรับงานใน 3 นาที|Subcontractor accepted in 3 min|外包 3 分钟内接单
ศรีราชาโลจิสติกส์ · 74-5521 ชบ.|Sriracha Logistics · 74-5521|是拉差物流 · 74-5521
ใช้คู่กับ Express, FlowAccount, KRS, PEAK, SAP B1, LINE และ GPS ได้|Works with Express, FlowAccount, KRS, PEAK, SAP B1, LINE and GPS|可与 Express、FlowAccount、KRS、PEAK、SAP B1、LINE 及 GPS 配合使用
เช้าวันหนึ่งของฝ่ายจัดรถ|A morning in the dispatch office|调度部门的一个早晨
งานหนึ่งงานตั้งแต่ข้อความแรกของลูกค้าจนถึงใบแจ้งหนี้ ทุกช่วงด้านล่างเป็นหน้าจอจริงจากระบบ|One job, from the customer's first message to the invoice. Every step below is a real screen from the system.|一单业务,从客户的第一条消息到发票。下面每一步都是系统的真实界面。
ตาราง Settlement รถร่วม|Subcontractor settlement table|外包结算表
จ่ายรถร่วมจาก Settlement ไม่ต้องทำ Excel|Pay subcontractors from Settlement, no spreadsheet|通过结算付款给外包,无需 Excel
ระบบรวมเที่ยวของผู้รับเหมาแต่ละรายตามงวด ตรวจกับ POD และ rate card ขาซื้อ ก่อนส่งให้ผู้อนุมัติ|Trips are grouped per subcontractor per period and checked against POD and the buy-side rate card before going to the approver.|系统按账期汇总每家外包的车次,并对照 POD 与采购费率卡核对后提交审批。
หัก ณ ที่จ่าย 1% และเงินเบิกล่วงหน้าคนขับ คิดให้อัตโนมัติ|1% withholding tax and driver advances are deducted automatically|自动扣除 1% 代扣税与司机预支
ยอดสุทธิที่ต้องโอน ออกใบสำคัญจ่ายและหนังสือรับรอง 50 ทวิ ได้ทันที|Net amount to transfer, with payment voucher and 50 Tawi certificate issued on the spot|应转账净额,可立即开具付款凭证与 50 Tawi 扣税证明
ทุกการแก้ยอดเก็บค่าก่อน–หลังและเหตุผล|Every amount change keeps the before / after and the reason|每次金额修改都保留前后数值与原因
รถที่เอกสารหมดอายุ จ่ายงานไม่ได้|Trucks with expired documents can't be dispatched|文件过期的车辆无法派单
ประกัน ภาษี พ.ร.บ. ตรอ. และ GPS DLT ของทุกคันเรียงตามวันหมดอายุ แจ้งเตือนก่อน 30 วัน และรถที่หมดแล้วถูกกันบนกระดานวางแผนทันที|Insurance, road tax, compulsory insurance, inspection and GPS DLT for every truck, sorted by expiry. Alerts go out 30 days ahead, and expired trucks are blocked on the planning board immediately.|每辆车的保险、车税、强制险、车检与 GPS DLT 按到期日排列,提前 30 天提醒,过期车辆立即在调度板上被锁定。
สรุปเอกสารรถหมดอายุ|Vehicle document expiry summary|车辆文件到期汇总
ตารางเอกสารรถ|Vehicle documents table|车辆文件表
เอกสารภาษีออกจากระบบได้เอง|Tax documents straight from the system|税务单据由系统直接开具
ออกใบกำกับภาษี ใบเสร็จ และหนังสือรับรองหัก ณ ที่จ่าย 50 ทวิ ได้เอง หรือส่งไป Express / FlowAccount เอกสารที่ออกแล้วถูกล็อก ปรับยอดผ่านใบลดหนี้หรือใบเพิ่มหนี้อ้างใบเดิม|Issue tax invoices, receipts and 50 Tawi withholding certificates yourself, or send them to Express / FlowAccount. Issued documents are locked; adjustments go through credit or debit notes against the original.|可自行开具税务发票、收据与 50 Tawi 代扣税证明,或推送到 Express / FlowAccount。已开具单据会锁定,通过引用原单的贷项或借项通知单调整。
ใบกำกับภาษีแยกมูลค่ายกเว้นภาษีของค่าขนส่งออกจากบริการประกอบที่คิด VAT 7% และพิมพ์หัวเอกสารสองภาษา ไทย / อังกฤษ|Tax invoices separate VAT-exempt freight from ancillary services at 7% VAT, with bilingual Thai / English headings.|税务发票将免税运费与按 7% 计增值税的附加服务分开列示,单据标题为泰英双语。
ใบเสร็จรับเงิน / ใบกำกับภาษี จากระบบ|Receipt / tax invoice from the system|系统开具的收据 / 税务发票
เชื่อมระบบของคุณด้วย Open API, Webhook และ MCP|Connect your systems with Open API, webhooks and MCP|通过 Open API、Webhook 与 MCP 对接您的系统
สร้าง SO และดึงสถานะงานผ่าน REST มี sandbox และ API key แยกตาม scope รับ webhook ลงลายเซ็น HMAC เมื่อส่งของหรือออกใบแจ้งหนี้ ฟิลด์เพิ่มเติมที่คุณตั้งเองอยู่ใน API และ webhook ทันที|Create SOs and read job status over REST, with a sandbox and scoped API keys. Receive HMAC-signed webhooks on delivery or invoicing. Custom fields you define appear in the API and webhooks right away.|通过 REST 创建 SO 并读取任务状态,提供沙箱与按范围划分的 API key。送达或开票时接收 HMAC 签名的 webhook。您自定义的字段立即出现在 API 与 webhook 中。
เชื่อม Claude หรือ ChatGPT ผ่าน MCP แล้วสั่งงานเป็นภาษาไทย ผู้ช่วยใช้สิทธิ์เดียวกับผู้ใช้ และทุกงานที่สร้างเป็นร่างรอคนยืนยัน|Connect Claude or ChatGPT through MCP and give instructions in Thai. The assistant has the same permissions as the user, and everything it creates is a draft awaiting confirmation.|通过 MCP 连接 Claude 或 ChatGPT,用泰语下达指令。助手权限与用户一致,创建的内容均为待确认的草稿。
อ่านเอกสาร API →|Read the API docs →|阅读 API 文档 →
ตั้งค่า MCP →|Set up MCP →|设置 MCP →
พิมพ์ใน Claude|Typed in Claude|在 Claude 中输入
"พรุ่งนี้รับปูน 24 ตันที่อยุธยา ส่งสระบุรีซีเมนต์ก่อนบ่ายสอง ขอรถพ่วง PO 45120098"|"Tomorrow, pick up 24 tonnes of cement in Ayutthaya, deliver to Saraburi Cement before 2 pm, trailer truck, PO 45120098"|"明天在大城提 24 吨水泥,下午两点前送到北标水泥,需要拖挂车,PO 45120098"
TMS สร้าง SO-2611-0134 เป็นร่างในกล่องรับงาน ราคา ฿15,100.00 ตาม rate card รอผู้วางแผนยืนยัน|TMS creates SO-2611-0134 as a draft in the order inbox, ฿15,100.00 from the rate card, waiting for a planner to confirm|TMS 在订单收件箱中创建草稿 SO-2611-0134,按费率卡价格 ฿15,100.00,等待调度员确认
ทดลองใช้ 30 วัน ไม่ใช้บัตร|30-day trial, no card|试用 30 天,无需信用卡
ดูราคาทั้งหมด →|See all pricing →|查看全部价格 →
ทุกเส้นทางทั่วไทย ติดตามได้ในหน้าเดียว|Every route in Thailand, tracked on one screen|泰国每一条路线,一屏追踪
เริ่มจากรถ 1 คันและงานของพรุ่งนี้|Start with one truck and tomorrow's jobs|从 1 辆车和明天的任务开始
ใช้ได้ 3 ภาษา|Available in 3 languages|支持 3 种语言
ออก 50 ทวิ ได้เอง|Issue 50 Tawi certificates yourself|自行开具 50 Tawi 证明
แอปคนขับใช้งานออฟไลน์|Driver app works offline|司机 App 可离线使用
เชื่อม 6 โปรแกรมบัญชี/ERP|Connects to 6 accounting / ERP systems|对接 6 款财务 / ERP 系统
เริ่ม ฿390 ต่อรถต่อเดือน|From ฿390 per truck per month|每车每月 ฿390 起
เริ่ม ฿420 ต่อรถต่อเดือน|From ฿420 per truck per month|每车每月 ฿420 起
จัดรถ ตามงาน เก็บ POD|Dispatch, track, collect POD,|派车、追踪、收集 POD,
วางบิล — จบในที่เดียว|bill. All in one place.|开票,一站完成
เที่ยวปัจจุบัน|Current trip|当前车次
อัปเดตล่าสุดเมื่อ|Last updated|最后更新
กม./ชม.|km/h|公里/时
ระยะทางที่เหลือ|Distance left|剩余距离
เวลาถึงโดยประมาณ|Estimated arrival|预计到达
จุดถัดไป|Next stop|下一站
กลับสู่เวลาจริง|Back to live|返回实时
ลากเพื่อดูตำแหน่งย้อนหลังของวันนี้|Drag to view today's earlier positions|拖动查看今日历史位置
เล่นย้อนหลัง|Replay|回放
หยุดเล่น|Pause|暂停
ตอนนี้|Now|现在
ย้อนหลัง|Replay|回放
ล่าช้ากว่า ETA|Behind ETA|晚于 ETA
นอกเส้นทาง / จอดนาน|Off route / long stop|偏离路线 / 长时间停车
จอดนานเกิน|Stopped over|停车超过
เส้นทางแผน|Planned route|计划路线
วิ่งจริง|Actual route|实际路线
อัปเดตอัตโนมัติ|Auto-update|自动更新
กรองรถบนแผนที่|Filter vehicles on map|筛选地图上的车辆
ย่อแผง|Collapse panel|收起面板
ขยายแผง|Expand panel|展开面板
โทรหาคนขับ|Call driver|致电司机
กำลังโทรหา|Calling|正在呼叫
ความคืบหน้าจุดส่ง|Delivery progress|送货进度
จุดส่ง|Stop|送货点
ส่งครบแล้ว|All delivered|已全部送达
น้ำหนักบรรทุก / ความจุ|Load / capacity|载重 / 容量
ติดตามคันนี้|Follow this truck|跟随此车
เลิกติดตาม|Stop following|停止跟随
ดูเส้นทางทั้งหมด|View full route|查看完整路线
เปิดเที่ยวรถ|Open trip|打开车次
มุมบน 2 มิติ (เหมาะกับเครื่องช้า)|Top-down 2D (for slower devices)|2D 俯视（适合较慢设备）
มุมเอียง 3 มิติ|Tilted 3D view|3D 倾斜视图
หมุนกลับทิศเหนือ|Reset to north|恢复正北
ซูมเข้า|Zoom in|放大
ซูมออก|Zoom out|缩小
ดูรถทั้งหมด|Show all vehicles|显示全部车辆
ความเร็วจำลองสำหรับเดโม|Simulation speed for demo|演示模拟速度
ความเร็วเดโม|Demo speed|演示速度
เดโม|Demo|演示
กำลังโหลดแผนที่ 3 มิติ…|Loading 3D map…|正在加载 3D 地图…
เบราว์เซอร์นี้ไม่รองรับ WebGL · แสดงแผนที่ 2 มิติแทน|This browser doesn't support WebGL · showing the 2D map|此浏览器不支持 WebGL · 改为显示 2D 地图
โหลดแผนที่ 3 มิติไม่สำเร็จ · แสดงแผนที่ 2 มิติแทน|Couldn't load the 3D map · showing the 2D map|3D 地图加载失败 · 改为显示 2D 地图
แสดงฉาก 3 มิติไม่สำเร็จ · แสดงแผนที่ 2 มิติแทน|Couldn't render the 3D scene · showing the 2D map|3D 场景渲染失败 · 改为显示 2D 地图
ติดตามรถ 3D|Live tracking 3D|车辆追踪 3D
`;
  const D = RAW.trim().split('\n').map(l => l.split('|')).filter(a => a.length === 3 && a[0]);
  const MON = ['ม.ค.','ก.พ.','มี.ค.','เม.ย.','พ.ค.','มิ.ย.','ก.ค.','ส.ค.','ก.ย.','ต.ค.','พ.ย.','ธ.ค.'], MEN = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const keys = D.map(a => a[0]).sort((a, b) => b.length - a.length);
  const RX = new RegExp(keys.filter(k => [...k].length >= 4 && k !== 'แล้ว').map(esc).join('|') + '|แล้ว$', 'g');
  const PROT = new RegExp('(?:บจก\\.|บมจ\\.|หจก\\.|บริษัท|ห้างหุ้นส่วนจำกัด|นาย|คุณ)\\s?[\\u0E00-\\u0E7FA-Za-z]+(?:\\s[\\u0E00-\\u0E7FA-Za-z]+)?|ศรีไทยขนส่ง|ศรีไทยโลจิสติกส์|สำนักงานใหญ่|กรุงเทพ|ชลบุรี|ระยอง|บางปู|แหลมฉบัง|อยุธยา|สระบุรี|ลาดกระบัง|นครราชสีมา|สมุทรปราการ|ฉะเชิงเทรา|ศรีราชา|บางพลี|บางนา', 'g');
  const M = { en: {}, zh: {} }; D.forEach(a => { M.en[a[0]] = a[1]; M.zh[a[0]] = a[2]; });
  const mRx = MON.map(esc).join('|');
  const P = [
    [new RegExp('(\\d{1,2})\\s*[–-]\\s*(\\d{1,2}) (' + mRx + ') (25\\d\\d)', 'g'), (L, m) => L === 'en' ? m[1] + '–' + m[2] + ' ' + MEN[MON.indexOf(m[3])] + ' ' + (m[4] - 543) : (m[4] - 543) + '年' + (MON.indexOf(m[3]) + 1) + '月' + m[1] + '–' + m[2] + '日'],
    [new RegExp('(\\d{1,2}) (' + mRx + ') (25\\d\\d)', 'g'), (L, m) => L === 'en' ? m[1] + ' ' + MEN[MON.indexOf(m[2])] + ' ' + (m[3] - 543) : (m[3] - 543) + '年' + (MON.indexOf(m[2]) + 1) + '月' + m[1] + '日'],
    [new RegExp('(' + mRx + ') (25\\d\\d)', 'g'), (L, m) => L === 'en' ? MEN[MON.indexOf(m[1])] + ' ' + (m[2] - 543) : (m[2] - 543) + '年' + (MON.indexOf(m[1]) + 1) + '月'],
    [new RegExp('(\\d{1,2}) (' + mRx + ')', 'g'), (L, m) => L === 'en' ? m[1] + ' ' + MEN[MON.indexOf(m[2])] : (MON.indexOf(m[2]) + 1) + '月' + m[1] + '日'],
    [/อังคารที่ /g, L => L === 'en' ? 'Tuesday, ' : '星期二 '],
    [/เกิน (\d+) วัน/g, (L, m) => L === 'en' ? m[1] + ' days overdue' : '逾期 ' + m[1] + ' 天'],
    [/เหลือ (\d+) ชม\./g, (L, m) => L === 'en' ? m[1] + ' h left' : '剩余 ' + m[1] + ' 小时'],
    [/([\d,.]+) กก\./g, (L, m) => m[1] + (L === 'en' ? ' kg' : ' 公斤')],
    [/([\d,.]+) กม\./g, (L, m) => m[1] + (L === 'en' ? ' km' : ' 公里')],
    [/(\d+) นาที/g, (L, m) => m[1] + (L === 'en' ? ' min' : ' 分钟')],
    [/(\d+) เที่ยว/g, (L, m) => m[1] + (L === 'en' ? ' trips' : ' 车次')],
    [/(\d+) จุด/g, (L, m) => m[1] + (L === 'en' ? ' stops' : ' 个站点')],
    [/(\d+) ใบ/g, (L, m) => m[1] + (L === 'en' ? ' docs' : ' 张')],
    [/(\d+) รายการ/g, (L, m) => m[1] + (L === 'en' ? ' items' : ' 项')],
    [/(\d+) คัน/g, (L, m) => m[1] + (L === 'en' ? ' vehicles' : ' 辆')],
    [/(\d+) วัน/g, (L, m) => m[1] + (L === 'en' ? ' days' : ' 天')],
    [/(\d+) หน่วย/g, (L, m) => m[1] + (L === 'en' ? ' units' : ' 件')],
    [/(\d+) จาก (\d+)/g, (L, m) => m[1] + (L === 'en' ? ' of ' : ' / ') + m[2]],
    [/(^|[^\d,.])(25[5-9]\d)(?![\d,.])/g, (L, m) => m[1] + (m[2] - 543)]
  ];
  const TH = /[\u0E00-\u0E7F]/;
  let lang = 'th';
  try { lang = localStorage.getItem('tms_lang') || 'th'; } catch (e) {}
  function tr(s) {
    if (lang === 'th' || !s || !TH.test(s)) return s;
    const t = s.trim(); if (M[lang][t] !== undefined) return s.replace(t, M[lang][t].replace(/(^|[^\d,.])(25[5-9]\d)(?![\d,.])/g, (m0, p, y) => p + (y - 543)));
    const keep = []; let o = s.replace(PROT, m => { keep.push(m); return '\u0001' + (keep.length - 1) + '\u0001'; });
    P.forEach(([rx, f]) => { o = o.replace(rx, (...g) => f(lang, g)); });
    o = o.replace(RX, k => lang === 'en' ? ' ' + M.en[k] + ' ' : M.zh[k]);
    o = o.replace(/\u0001(\d+)\u0001/g, (m, i) => keep[+i]);
    if (lang === 'en') o = o.replace(/ {2,}/g, ' ').replace(/ ([,.:;)·/])/g, '$1').replace(/\( /g, '(');
    return s.match(/^\s*/)[0] + o.trim() + s.match(/\s*$/)[0];
  }
  const ORIG = new WeakMap(), OUT = new WeakMap(), ATTRS = ['placeholder', 'title', 'aria-label'];
  const skip = n => { for (let e = n.parentElement; e; e = e.parentElement) { if (e.hasAttribute && e.hasAttribute('data-noi18n')) return true; const tg = e.tagName; if (tg === 'SCRIPT' || tg === 'STYLE' || tg === 'PRE' || tg === 'TEXTAREA') return true; } return false; };
  function doText(n, force) {
    if (!force && OUT.get(n) === n.nodeValue) return;
    const v = n.nodeValue; if (!TH.test(v) && !ORIG.has(n)) return;
    if (skip(n)) return;
    const orig = OUT.has(n) && OUT.get(n) === v ? ORIG.get(n) : v;
    ORIG.set(n, orig); const out = lang === 'th' ? orig : tr(orig); OUT.set(n, out); if (out !== v) n.nodeValue = out;
  }
  function doEl(el) {
    if (el.nodeType !== 1 || (el.closest && el.closest('[data-noi18n]'))) return;
    ATTRS.forEach(a => { if (!el.hasAttribute(a)) return; const k = 'data-i18n-' + a, v = el.getAttribute(a), last = el.getAttribute(k + '-out'); let orig = el.getAttribute(k);
      if (orig == null || (last != null && last !== v)) { orig = v; el.setAttribute(k, orig); } const out = lang === 'th' ? orig : tr(orig); el.setAttribute(k + '-out', out); if (out !== v) el.setAttribute(a, out); });
  }
  function walk(root, force) {
    if (!root) return; if (root.nodeType === 3) { doText(root, force); return; }
    if (root.nodeType !== 1) return; doEl(root);
    const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT); let n;
    while ((n = w.nextNode())) { if (n.nodeType === 3) doText(n, force); else doEl(n); }
  }
  function font() {
    const b = document.body; if (!b) return;
    document.documentElement.lang = lang === 'zh' ? 'zh-Hans' : lang;
    b.style.fontFamily = lang === 'zh' ? "'IBM Plex Sans','Noto Sans SC','IBM Plex Sans Thai Looped','IBM Plex Sans',sans-serif" : lang === 'en' ? "'IBM Plex Sans','IBM Plex Sans Thai Looped','IBM Plex Sans',sans-serif" : "'IBM Plex Sans Thai Looped','IBM Plex Sans','IBM Plex Sans',sans-serif";
  }
  function fonts() { if (document.getElementById('tms-i18n-fonts')) return; const l = document.createElement('link'); l.id = 'tms-i18n-fonts'; l.rel = 'stylesheet'; l.href = 'https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600&family=Noto+Sans+SC:wght@400;500;600&display=swap'; document.head.appendChild(l); }
  let mo, subs = [];
  function start() {
    fonts(); font(); walk(document.body); if (FLOAT) floatToggle(FLOAT === '1' ? '' : FLOAT);
    mo = new MutationObserver(ms => { ms.forEach(m => { if (m.type === 'characterData') doText(m.target); else if (m.type === 'attributes') doEl(m.target); else m.addedNodes.forEach(walk); }); });
    mo.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ATTRS });
  }
  function set(l) { lang = l; try { localStorage.setItem('tms_lang', l); } catch (e) {} font(); walk(document.body, true); subs.forEach(f => f(l)); renderFloat(); }
  let fl = null;
  function renderFloat() { if (!fl) return; fl.querySelectorAll('button').forEach(b => { const on = b.dataset.l === lang; b.style.background = on ? '#FFFFFF' : 'transparent'; b.style.color = on ? '#2257C4' : '#3B424C'; b.style.fontWeight = on ? '600' : '500'; b.style.boxShadow = on ? '0 1px 2px rgba(10,23,52,.10)' : 'none'; }); }
  function floatToggle(pos) {
    if (fl) return; fl = document.createElement('div'); fl.setAttribute('data-noi18n', '');
    fl.style.cssText = 'position:fixed;z-index:9999;display:inline-flex;gap:2px;padding:3px;background:#EBEDE8;border:1px solid #D9DCD4;border-radius:999px;box-shadow:0 6px 20px rgba(10,23,52,.07);font-family:inherit;' + (pos || 'top:16px;right:16px;');
    [['th', 'TH'], ['en', 'EN'], ['zh', '中文']].forEach(([k, t]) => { const b = document.createElement('button'); b.dataset.l = k; b.textContent = t; b.style.cssText = 'height:30px;min-width:44px;padding:0 12px;border:0;border-radius:999px;cursor:pointer;font:inherit;font-size:13px'; b.onclick = () => set(k); fl.appendChild(b); });
    document.body.appendChild(fl); renderFloat();
  }
  window.TMSI18N = { set, get: () => lang, t: tr, onChange: f => subs.push(f), floatToggle };
  if (document.body) start(); else document.addEventListener('DOMContentLoaded', start);
})();
