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

# ตั้ง token ที่ใช้ยืนยันตัวตน agent (อย่า commit ค่านี้)
npx wrangler secret put HEALTH_TOKEN

# ตรวจสอบ/สร้าง KV แล้วเขียน id ลง wrangler.toml อัตโนมัติ
npm run setup:kv

# ทดสอบ bundle ก่อน deploy
npm run check

# deploy (setup:kv จะรันอีกครั้งโดยอัตโนมัติผ่าน predeploy)
npm run deploy
```

`npm run setup:kv` จะ reuse namespace `HEALTH_KV` ที่มีอยู่แล้ว ถ้าไม่มีจะสร้างใหม่แล้วอัปเดต `wrangler.toml` ให้เอง ไม่ต้อง copy id เองอีกต่อไป

### Deploy อัตโนมัติด้วย GitHub Actions

เพิ่ม repository secrets ต่อไปนี้ แล้วทุก push ไป `main` จะตรวจ/สร้าง KV และ deploy ให้เอง:

- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`
- `HEALTH_TOKEN`

 workflow อยู่ที่ `.github/workflows/deploy.yml`

Wrangler จะพิมพ์ URL ให้หลัง deploy (ในโปรเจกต์นี้คือ `https://pc-health-dashboard.apichat-p-1989.workers.dev`) agent จะอ่าน endpoint/token จาก `windows/agent.config.json` ซึ่งถูก gitignore อยู่

token ที่ใช้คือค่าที่ตั้งด้วย:

```bash
npx wrangler secret put HEALTH_TOKEN
```

installer จะถาม token จากคุณแล้วเขียนลง config ให้โดยไม่โชว์บนหน้าจอ และจำกัด ACL ให้เฉพาะ user คนนั้นอ่านได้

ถ้าต้องการรันแบบครั้งเดียวด้วย `send-health.bat` ให้แก้ token ในไฟล์นั้นเอง หรือ set environment variable:

```bat
set HEALTH_TOKEN=<token ที่ตั้งด้วย wrangler secret>
send-health.bat
```

## รันบน Windows แบบ real-time

### ติดตั้งจากหน้าเว็บ (แนะนำ)

### สร้าง HEALTH_TOKEN จากหน้าเว็บ

กดปุ่ม **สร้าง Token** มุมขวาบน → กด **สุ่ม Token ใหม่** แล้วกด **คัดลอก Token** token จะถูกสุ่มด้วย `crypto.getRandomValues` ใน browser และมีรูปแบบ `ph_...` จากนั้นรันคำสั่งด้านล่างบนเครื่องที่ login Wrangler ไว้ แล้ววาง token เมื่อระบบถาม:

```bash
npx wrangler secret put HEALTH_TOKEN
```

dashboard ไม่มีระบบ login จึง**ไม่มี endpoint ที่เขียน secret แทนคุณ** และไม่เก็บ token ไว้ใน KV อัตโนมัติ ถ้าสร้าง token ใหม่ทุกเครื่องที่ติดตั้งอยู่ต้องรัน installer ใหม่ด้วย `-Force` และใส่ token ใหม่ ส่วน secret เก่าจะยังใช้งานได้จนกว่าคุณจะตั้งค่า secret ใหม่ 또는ลบออก

เปิด dashboard แล้วกดปุ่ม **ติดตั้ง Agent** มุมขวาบน กด **คัดลอกคำสั่ง** แล้ววางใน PowerShell ที่เปิดแบบ **Run as Administrator** กด Enter:

```powershell
irm https://pc-health-dashboard.apichat-p-1989.workers.dev/agent/bootstrap.ps1 | iex
```

คำสั่งนี้โหลดไฟล์ agent จาก GitHub ไปยัง `%LOCALAPPDATA%\PCHealthAgent` แล้วเรียก installer ให้เอง (ยังถาม `HEALTH_TOKEN` เหมือนเดิม) installer จะ **ส่งข้อมูลจริง 1 ครั้งทันทีเพื่อตรวจ token** ก่อนสร้าง Windows Service ชื่อ `PCHealthAgent` หาก token ผิดหรือ network ไม่ได้จะแจ้ง error ทันที ตัว service เป็น `.exe` ที่ compile จาก `PCHealthAgent.Service.cs` ด้วย `.NET Framework 4.x` ที่มีอยู่ใน Windows ไม่ต้องติดตั้ง tool เพิ่ม จะ start อัตโนมัติตอน boot และ restart agent เองถ้า process ตาย ในหน้าเว็บยังมีปุ่มดาวน์โหลด `bootstrap.ps1` และ ZIP ของโปรเจกต์ให้ด้วย

หากเคยติดตั้งแล้วแต่ dashboard ยังไม่ขึ้นเครื่อง ให้ใช้คำสั่งติดตั้งใหม่ (force) จากหน้าเว็บ หรือรันเอง:

```powershell
$bootstrap = irm https://pc-health-dashboard.apichat-p-1989.workers.dev/agent/bootstrap.ps1; & ([scriptblock]::Create($bootstrap)) -Force
```

แล้วตรวจสอบด้วย:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$env:LOCALAPPDATA\PCHealthAgent\diagnose.ps1"
```

คำสั่ง `diagnose.ps1` จะแสดงสถานะ Windows Service, legacy Scheduled Task, ค่าที่ตั้งไว้ (ปิดบัง token), `agent.log`, `service.log` และทดสอบส่งข้อมูล 1 ครั้งโดยไม่เปิดเผย token

### ถอนการติดตั้ง

จากหน้าเว็บกด **ติดตั้ง Agent** แล้วกด **คัดลอกคำสั่งถอนการติดตั้ง** หรือรันเองใน PowerShell ที่เปิดแบบ **Run as Administrator**:

```powershell
$bootstrap = irm https://pc-health-dashboard.apichat-p-1989.workers.dev/agent/bootstrap.ps1; & ([scriptblock]::Create($bootstrap)) -Uninstall -RemoveFiles
```

คำสั่งนี้จะหยุดและลบ service `PCHealthAgent`, ลบ legacy Scheduled Task `PC Health Dashboard Agent` ถ้ายังมีอยู่ และลบไฟล์ทั้งหมดใน `%LOCALAPPDATA%\PCHealthAgent` ถ้าต้องการเก็บ config/log ไว้ ให้去掉 `-RemoveFiles`:

```powershell
$bootstrap = irm https://pc-health-dashboard.apichat-p-1989.workers.dev/agent/bootstrap.ps1; & ([scriptblock]::Create($bootstrap)) -Uninstall
```

ตรวจผลด้วย:

```powershell
Get-Service PCHealthAgent
```

ควรขึ้น error ว่าไม่พบ service ฝั่ง dashboard เครื่องจะเปลี่ยนเป็น `offline` ภายใน ~5 นาที

### ติดตั้งแบบ copy โฟลเดอร์เอง

1. copy โฟลเดอร์ `windows/` ไปยังเครื่อง เช่น `C:\HealthCheck\`
2. เปิด PowerShell แบบ **Run as Administrator** แล้วรัน installer:

```powershell
cd C:\HealthCheck
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\install-agent.ps1
```

installer จะถาม `HEALTH_TOKEN` จาก Cloudflare secret, เขียน `agent.config.json`, compile `PCHealthAgent.Service.exe` แล้วสร้าง Windows Service ชื่อ `PCHealthAgent` (display name `PC Health Dashboard Agent`) start ทันที, start อัตโนมัติตอน boot และ restart agent เองถ้า process ตาย legacy Scheduled Task ชื่อเดิมจะถูกลบออกให้ด้วย

3. ดู log แบบ real-time:

```powershell
Get-Content C:\HealthCheck\agent.log -Wait
```

4. เปิด dashboard `https://pc-health-dashboard.apichat-p-1989.workers.dev` จะเห็นเครื่องปรากฏภายใน ~10 วินาที

### รัน foreground / ทดสอบครั้งเดียว

```bat
run-agent.bat
send-health.bat
```

`run-agent.bat` รัน loop ในหน้าต่างปัจจุบัน (กด Ctrl+C เพื่อหยุด)  
`send-health.bat` ส่งครั้งเดียว เหมาะสำหรับทดสอบหลังแก้ token

### ปรับแต่ง

```powershell
# เปลี่ยนชื่อที่แสดง / device id ตอนติดตั้ง
.\install-agent.ps1 -Force -DisplayName "PC-ACCOUNTING-01" -DeviceId "pc-acct-01"

# เปลี่ยนความถี่เป็น 5 วินาที
.\install-agent.ps1 -Force -IntervalSeconds 5

# หยุดและลบ service ออก แต่เก็บ config/log ไว้
.\install-agent.ps1 -Uninstall

# หยุด ลบ service และลบไฟล์ทั้งหมดในโฟลเดอร์ agent
.\install-agent.ps1 -Uninstall -RemoveFiles
```

ค่าเริ่มต้นคือทุก 10 วินาที (ต่ำสุด 2 วินาที) ถ้าไม่ระบุ `deviceId` ระบบจะใช้ UUID ของเมนบอร์ด (หรือ `MachineGuid`) เป็น id และ `$env:COMPUTERNAME` เป็นชื่อ

### ไฟล์ในโฟลเดอร์ `windows/`

| ไฟล์ | หน้าที่ |
| --- | --- |
| `install-agent.ps1` | ตั้งค่า, compile service, ติดตั้ง/ถอนการติดตั้ง Windows Service |
| `PCHealthAgent.Service.cs` | โค้ด C# สำหรับ Windows Service wrapper |
| `agent.ps1` | loop ส่งข้อมูลต่อเนื่อง |
| `health-lib.ps1` | ฟังก์ชันเก็บ metrics / ส่งข้อมูล |
| `diagnose.ps1` | ตรวจ service/config/log และทดสอบส่ง 1 ครั้ง |
| `run-agent.bat` | รัน agent แบบ foreground |
| `send-health.bat` | ส่งครั้งเดียว |
| `collect-and-send.ps1` | ตัวเก็บข้อมูลครั้งเดียวที่ `send-health.bat` เรียก |
| `agent.config.example.json` | ตัวอย่าง config |
| `agent.config.json` | config จริง (gitignored, มี token) |
| `agent.log` | log การทำงานของ agent (gitignored) |
| `service.log` | log การ start/stop/restart ของ service (gitignored) |
| `PCHealthAgent.Service.exe` | service ที่ compile แล้ว (gitignored) |

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
