# MT Shift Optimizer

เว็บแอปจัดตารางเวร MT (Medical Technologist) — กำหนดบุคลากร กะ และจำนวนวัน แล้วระบบจะสร้างตารางที่กระจายเวรให้เท่ากันและตรงกับ constraint (skill, วันหยุด)

## ติดตั้ง

```bash
python -m venv .venv
.venv\Scripts\activate   # Windows
# source .venv/bin/activate  # macOS/Linux
pip install -r requirements.txt
```

## รันเว็บ

```bash
uvicorn main:app --reload --host 0.0.0.0 --port 8000
```

หรือ:

```bash
python main.py
```

จากนั้นเปิดเบราว์เซอร์ที่ **http://localhost:8000** (อย่าใช้ 0.0.0.0:8000 — บน Windows จะเปิดไม่ได้)

## Deploy บน Railway

1. **ติดตั้ง Railway CLI** (ถ้ายังไม่มี): `winget install Railway.cli` หรือดู [railway.com](https://railway.com)
2. **Login**: `railway login`
3. **สร้างโปรเจกต์**: ในโฟลเดอร์โปรเจกต์ รัน `railway init` แล้วเลือกสร้างโปรเจกต์ใหม่หรือเชื่อมกับที่มี
4. **Deploy**: `railway up` (อัปโหลดโค้ดแล้ว build/run ตาม Procfile)

หรือ **เชื่อม GitHub**: ใน [Railway Dashboard](https://railway.app/dashboard) → New Project → Deploy from GitHub repo → เลือก repo นี้ ระบบจะ build จาก `requirements.txt` และรันตาม Procfile (`web: uvicorn main:app --host 0.0.0.0 --port $PORT`)

หมายเหตุ: ข้อมูลเก็บใน SQLite ในเครื่องของ Railway — ถ้า redeploy หรือ restart ข้อมูลอาจหาย ถ้าต้องการเก็บถาวรให้เพิ่ม Volume ใน Railway หรือเปลี่ยนไปใช้ DB ภายนอก

## วิธีใช้

1. **ตั้งค่า** — กำหนดจำนวนวัน (num_days) แล้วกดบันทึก
2. **บุคลากร** — เพิ่มชื่อ ประเภท (เต็มเวลา/พาร์ทไทม์) skills (donor, xmatch) และวันหยุด (0–6)
3. **กะ** — เพิ่มกะ (เช่น Morning, Afternoon, Night) และจำนวนคนที่ต้องการต่อห้อง (donor, xmatch)
4. **สร้างตาราง** — กดปุ่ม "สร้างตารางเวร" ระบบจะคำนวณและแสดงตารางล่าสุด
5. **Export** — กด "ดาวน์โหลด CSV" เพื่อนำตารางไปใช้ต่อ

## โครงสร้างโปรเจกต์

- `main.py` — FastAPI app, API endpoints, เสิร์ฟ static
- `database.py` — SQLite schema, staff/shift/schedule CRUD
- `scheduler.py` — OR-Tools CP-SAT จัดตาราง
- `config.py` — ข้อมูลเริ่มต้น (ใช้ seed เข้า DB ครั้งแรก)
- `static/` — หน้าเว็บ (index.html, style.css, app.js)
- `shift_optimizer.db` — ฐานข้อมูล (สร้างอัตโนมัติเมื่อรัน)

## API (สรุป)

- `GET/PUT /api/settings/num_days` — จำนวนวัน
- `GET/POST /api/staff` — รายชื่อ staff
- `PUT/DELETE /api/staff/{id}` — แก้/ลบ staff
- `GET/POST /api/shifts` — รายการกะ
- `PUT/DELETE /api/shifts/{id}` — แก้/ลบกะ
- `POST /api/schedule/run` — สร้างตารางใหม่
- `GET /api/schedule/latest` — ตารางล่าสุด
- `GET /api/schedule/export/csv` — ดาวน์โหลด CSV

## รันแบบสคริปต์ (ไม่ใช้เว็บ)

```bash
python app.py
```

จะพิมพ์ตารางลงคอนโซล (โหลดข้อมูลจาก DB เหมือนกัน)
