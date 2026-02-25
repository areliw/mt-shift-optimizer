# app.py

import sys
import io

# ให้พิมพ์ภาษาไทยบน Windows ได้
if sys.stdout.encoding and "cp1252" in sys.stdout.encoding.lower():
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

from database import init_db, get_mt_list, get_shift_list, get_num_days, seed_from_config
from scheduler import generate_schedule
from ortools.sat.python import cp_model

# สร้าง DB และ seed จาก config ถ้ายังไม่มีข้อมูล
init_db()
if not get_shift_list():
    seed_from_config()

mt_list = get_mt_list()
shift_list = get_shift_list()
num_days = get_num_days()

shifts, rooms, solver, status = generate_schedule()

if status in (cp_model.OPTIMAL, cp_model.FEASIBLE):
    for day in range(num_days):
        print(f"\n--- วันที่ {day + 1} ---")
        for shift in shift_list:
            donor_workers  = [mt["name"] for mt in mt_list if solver.value(rooms[(mt["name"], day, shift["name"], "donor")]) == 1]
            xmatch_workers = [mt["name"] for mt in mt_list if solver.value(rooms[(mt["name"], day, shift["name"], "xmatch")]) == 1]
            print(f"  {shift['name']}:")
            print(f"    Donor  : {donor_workers}")
            print(f"    Xmatch : {xmatch_workers}")
else:
    print("ไม่พบตาราง")