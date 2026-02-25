# เปิด DB ด้วย Python (ไม่ต้องติดตั้งโปรแกรมอื่น)
# รัน: python open_db.py

import sqlite3
from pathlib import Path

DB = Path(__file__).parent / "shift_optimizer.db"
if not DB.exists():
    print("ยังไม่มีไฟล์ shift_optimizer.db รัน app.py ก่อน")
    exit(1)

conn = sqlite3.connect(DB)
conn.row_factory = sqlite3.Row  # ให้ column เป็นชื่อได้
cur = conn.cursor()

print("=== ตารางใน DB ===")
for row in cur.execute("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"):
    print(" ", row[0])

print("\n--- settings ---")
for row in cur.execute("SELECT * FROM settings"):
    print(dict(row))

print("\n--- staff ---")
for row in cur.execute("SELECT * FROM staff"):
    print(dict(row))

print("\n--- staff_skill ---")
for row in cur.execute("SELECT s.name, sk.skill FROM staff s JOIN staff_skill sk ON s.id = sk.staff_id ORDER BY s.name"):
    print(dict(row))

print("\n--- staff_off_day ---")
for row in cur.execute("SELECT s.name, o.day FROM staff s JOIN staff_off_day o ON s.id = o.staff_id ORDER BY s.name, o.day"):
    print(dict(row))

print("\n--- shift ---")
for row in cur.execute("SELECT * FROM shift"):
    print(dict(row))

conn.close()
print("\n(จบ) ถ้าอยากแก้ข้อมูลใน DB ใช้ DB Browser for SQLite หรือ extension SQLite ใน Cursor)")
