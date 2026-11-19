# PC Health Dashboard

เว็บแอปรับ health check จากเครื่อง Windows แล้วแสดงสถานะบนหน้าเว็บแบบ real-time ใช้ **Cloudflare Workers + KV + Static Assets** ไม่ต้องมี server ของตัวเอง

```
Windows PC  --(send-health.bat)-->  POST /api/health  --> Cloudflare KV
Browser     <--------------------  GET /api/devices  <-- Worker + Dashboard
```

## สิ่งที่ได้

- หน้า Dashboard แสดงจำนวนเครื่อง ปกติ / เฝ้าระวัง / วิกฤต / ออฟไลน์
- ตารางแสดง CPU, RAM, Disk แต่ไดรฟ์, Uptime, ข้อความเตือน และ sparkline ย้อนหลัง 20 ครั้ง
- Auto refresh ทุก 10 วินาที ค้นหาและกรองสถานะได้
- กำหนดสถานะอัตโนมัติจากค่าที่ส่งมา (และฝั่ง server คำนวณซ้ำ ไม่เชื่อ status ที่ agent ส่งเพียงอย่างเดียว)
- Mark เครื่องเป็น `offline` อัตโนมัติถ้าไม่ส่งข้อมูลภายใน `STALE_AFTER_SECONDS` (ค่าเริ่มต้น 300 วินาที)

## เกณฑ์การให้สถานะ

| ตัวชี้วัด | เฝ้าระวัง | วิกฤต |
| --- | ---: | ---: |
| CPU | ≥ 90% | ≥ 98% |
| Memory used | ≥ 90% | ≥ 97% |
| Disk used | ≥ 85% | ≥ 95% |

สถานะที่เลวร้ายที่สุดจะชนะ ตัวอย่างเช่น disk 96% + CPU ปกติ จะได้ `critical`

## Deploy บน Cloudflare

```bash
npm install
npx wrangler login

# สร้าง KV namespace แล้ว copy id ไปใส่ใน wrangler.toml
npx wrangler kv namespace create HEALTH_KV

# ตั้ง token ที่ใช้ยืนยันตัวตน agent (อย่า commit ค่านี้)
npx wrangler secret put HEALTH_TOKEN

# ทดสอบ bundle ก่อน deploy
npm run check

# deploy
npm run deploy
```

Wrangler จะพิมพ์ URL แบบ `https://pc-health-dashboard.<your-subdomain>.workers.dev` ให้หลัง deploy ให้ copy ไปใส่ใน `windows/send-health.bat` ดังนี้:

```bat
set "HEALTH_ENDPOINT=https://pc-health-dashboard.<your-subdomain>.workers.dev/api/health"
set "HEALTH_TOKEN=<token ที่ตั้งด้วย wrangler secret>"
```

หรือจะ set environment variable ก็ได้ เช่น

```bat
set HEALTH_ENDPOINT=https://...
set HEALTH_TOKEN=...
send-health.bat
```

## รันบน Windows

1. copy โฟลเดอร์ `windows/` ไปยังเครื่อง เช่น `C:\HealthCheck\`
2. แก้ `send-health.bat` ตามหัวข้อก่อนหน้า
3. ทดสอบด้วยการ double-click `send-health.bat` ต้องเห็นข้อความ `OK id=... status=...`
4. เปิด dashboard ดูสถานะ

ให้รันทุก 5 นาทีด้วย Task Scheduler:

```bat
schtasks /Create /TN "PC Health Check" /TR "\"C:\HealthCheck\send-health.bat\"" /SC MINUTE /MO 5 /F
```

หรือเปิด Task Scheduler แล้วสร้าง Basic Task ชี้ไปที่ `send-health.bat` เองก็ได้

### เปลี่ยนชื่อที่แสดง / device id

```bat
send-health.bat -DisplayName "PC-ACCOUNTING-01" -DeviceId "pc-acct-01"
```

ถ้าไม่ระบุ ระบบจะใช้ UUID ของ主板 (หรือ `MachineGuid`) เป็น id และ `$env:COMPUTERNAME` เป็นชื่อ

## พัฒนาในเครื่อง

```bash
cp .dev.vars.example .dev.vars   # แก้ token ตามใจชอบ
npm run dev
```

เปิด `http://localhost:8787` จะเห็น dashboard ส่วน endpoint รับข้อมูลคือ `http://localhost:8787/api/health` (สคริปต์ Windows อนุญาต http เฉพาะ localhost สำหรับโหมด dev)

รันเทสต์:

```bash
npm test
```

## API

### `POST /api/health`

Header:

```
Authorization: Bearer <HEALTH_TOKEN>
Content-Type: application/json
```

ตัวอย่าง body:

```json
{
  "id": "abc-123",
  "hostname": "PC-01",
  "displayName": "PC-การบัญชี",
  "os": "Windows 11 Pro",
  "user": "OFFICE\\alice",
  "ip": "192.168.1.20",
  "status": "ok",
  "message": "",
  "timestamp": "2026-01-01T00:00:00.000Z",
  "metrics": {
    "cpuPct": 42.4,
    "memUsedPct": 70,
    "uptimeHours": 12.5,
    "disks": [
      { "name": "C:", "usedPct": 72, "freeGb": 56, "totalGb": 200 }
    ]
  }
}
```

Response สำเร็จ:

```json
{ "ok": true, "id": "abc-123", "status": "ok", "receivedAt": "2026-01-01T00:00:00.000Z" }
```

`hostname` จำเป็นต้องเป็นตัวอักษร ตัวเลข `.` `_` `-` เท่านั้น ส่วน `status` ไม่บังคับ (ถ้าไม่ส่ง server จะคำนวณจาก metrics) และจะถูกยกระดับถ้า metrics แย่กว่าที่ส่งมา

### `GET /api/devices`

ไม่ต้องใช้ token ใช้โดยหน้า Dashboard คืนค่า:

```json
{
  "ok": true,
  "generatedAt": "...",
  "staleAfterSeconds": 300,
  "summary": { "total": 2, "ok": 1, "warning": 1, "critical": 0, "offline": 0 },
  "devices": []
}
```

### `GET /api/ping`

ใช้เช็คว่า Worker ยังทำงานอยู่

## ความปลอดภัยและข้อจำกัด

- `POST /api/health` ใช้ bearer token เปรียบเทียบแบบ constant-time หลัง hash SHA-256 หมุนเวียน token ได้ด้วย `npx wrangler secret put HEALTH_TOKEN` แล้วแก้ใน bat
- `GET /api/devices` เปิดสาธารณะเพื่อให้หน้าเว็บโหลดได้ ถ้าต้องการจำกัดการดู ให้เปิด **Cloudflare Access** บน route `/api/devices` และ `/`
- KV เป็น eventual consistency ข้อมูลอาจใช้เวลาถึง ~60 วินาทีจึงปรากฏทุก region
- ข้อมูลเครื่องถูกเก็บ TTL 30 วัน (`DEVICE_TTL_SECONDS`) และประวัติล่าสุด 30 ครั้ง (`HISTORY_LIMIT`)
- ขนาด body สูงสุด 32 KB และเก็บได้ไม่เกิน ~1,000 เครื่องต่อรอบ (paginate 10 หน้า ๆ ละ 100 key)

## โครงสร้างไฟล์

```
src/lib.js                     validate / คำนวณ status / liveness
src/worker.js                  routes API + serve assets
public/index.html              dashboard
public/styles.css
public/app.js
windows/send-health.bat        entry point ที่แก้ config
windows/collect-and-send.ps1   เก็บข้อมูลเครื่องแล้ว POST
test/lib.test.js               unit tests
wrangler.toml
```
