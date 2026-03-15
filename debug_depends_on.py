"""
debug_depends_on.py — ตรวจ depends_on rules + ทดสอบ _validate_depends_on_for_shift
usage: python debug_depends_on.py
"""
import json
import sqlite3
import sys
import os

# ใช้ DB เดียวกับ app
_base = os.path.dirname(__file__)
_data_dir = os.environ.get("DATA_DIR", _base)

# หา workspace DB ล่าสุด (หรือ fallback ไป shift_optimizer.db)
ws_dir = os.path.join(_data_dir, "workspaces")
db_path = None
if os.path.isdir(ws_dir):
    dbs = sorted(
        [os.path.join(ws_dir, f, "data.db") for f in os.listdir(ws_dir)
         if os.path.isfile(os.path.join(ws_dir, f, "data.db"))],
        key=os.path.getmtime, reverse=True
    )
    if dbs:
        db_path = dbs[0]
if not db_path:
    db_path = os.path.join(_data_dir, "shift_optimizer.db")

if not os.path.isfile(db_path):
    print(f"❌ ไม่พบ DB: {db_path}")
    sys.exit(1)

print(f"✓ ใช้ DB: {db_path}\n")
conn = sqlite3.connect(db_path)

# ===== 1. แสดง depends_on rules ทั้งหมด =====
print("=" * 60)
print("DEPENDS_ON RULES ทั้งหมด:")
print("=" * 60)
rows = conn.execute("""
    SELECT s1.name, s2.name, COALESCE(sp.shift_names, '[]')
    FROM staff_pair sp
    JOIN staff s1 ON s1.id = sp.staff_id_1
    JOIN staff s2 ON s2.id = sp.staff_id_2
    WHERE sp.pair_type = 'depends_on'
    ORDER BY s2.name, s1.name
""").fetchall()

if not rows:
    print("  (ไม่มี depends_on rules)")
else:
    for provider, dependent, shift_raw in rows:
        try:
            shifts = json.loads(shift_raw) if shift_raw else []
        except Exception:
            shifts = []
        shift_label = f"  [เฉพาะกะ: {', '.join(shifts)}]" if shifts else "  [ทุกกะ]"
        print(f"  {dependent} → ต้องอยู่กับ {provider}{shift_label}")

# ===== 2. OR-grouped ต่อ dependent ต่อ shift filter =====
print("\n" + "=" * 60)
print("OR-GROUP ที่ solver ใช้ (grouped by dependent + shift_filter):")
print("=" * 60)
from collections import defaultdict
groups = defaultdict(list)
for provider, dependent, shift_raw in rows:
    try:
        shifts = json.loads(shift_raw) if shift_raw else []
    except Exception:
        shifts = []
    shifts_key = frozenset(str(s).strip() for s in shifts if str(s).strip())
    groups[(dependent, shifts_key)].append(provider)

for (dependent, shifts_key), providers in sorted(groups.items()):
    shift_label = f"[{', '.join(sorted(shifts_key))}]" if shifts_key else "[ทุกกะ]"
    print(f"  {dependent} ต้องอยู่กับ ({' หรือ '.join(providers)}) {shift_label}")

# ===== 3. ดู schedule ล่าสุด =====
print("\n" + "=" * 60)
print("SCHEDULE ล่าสุด — จำนวนเวรดึก X-match ต่อคน:")
print("=" * 60)
night_shift = "ห้อง X-match ดึก"
run_row = conn.execute("SELECT run_id FROM schedule_slot ORDER BY run_id DESC LIMIT 1").fetchone()
if run_row:
    run_id = run_row[0]
    night_counts = conn.execute("""
        SELECT staff_name, COUNT(*) as cnt
        FROM schedule_slot
        WHERE run_id = ? AND shift_name = ?
        GROUP BY staff_name
        ORDER BY cnt DESC
    """, (run_id, night_shift)).fetchall()
    if night_counts:
        for name, cnt in night_counts:
            print(f"  {name}: {cnt} เวร")
    else:
        print(f"  ไม่มีข้อมูลสำหรับกะ '{night_shift}'")
    # หา distinct shift names ใน schedule
    shift_names = conn.execute(
        "SELECT DISTINCT shift_name FROM schedule_slot WHERE run_id = ? ORDER BY shift_name",
        (run_id,)
    ).fetchall()
    print(f"\n  กะที่มีใน schedule (run_id={run_id}): {[r[0] for r in shift_names]}")
else:
    print("  ไม่มี schedule")

# ===== 4. ทดสอบ _validate_depends_on_for_shift logic =====
print("\n" + "=" * 60)
print("TEST: _validate_depends_on_for_shift logic (OR-grouped by shift_filter)")
print("=" * 60)

def _validate_or_grouped(assigned_set, shift_name, all_pair_rows):
    """OR-grouped ถูกต้อง — group by (dependent, frozenset(shift_filter))"""
    dep_groups = defaultdict(list)
    for provider, dependent, shift_raw in all_pair_rows:
        try:
            shifts = json.loads(shift_raw) if shift_raw else []
        except Exception:
            shifts = []
        shifts_clean = [str(s).strip() for s in shifts if str(s).strip()]
        if shifts_clean and shift_name not in shifts_clean:
            continue
        sf_key = frozenset(shifts_clean)
        dep_groups[(dependent, sf_key)].append(provider)

    errors = []
    for (dependent, sf_key), providers in dep_groups.items():
        if dependent not in assigned_set:
            continue
        if not any(p in assigned_set for p in providers):
            shift_label = f"[{', '.join(sorted(sf_key))}]" if sf_key else "[ทุกกะ]"
            errors.append(f"'{dependent}' ต้องอยู่กับ {' หรือ '.join(providers)} {shift_label}")
    return errors

tests = [
    ("สุธิษา + สาสนีย์", {"สุธิษา", "สาสนีย์"}),
    ("สุธิษา + วุฒิชัย", {"สุธิษา", "วุฒิชัย"}),
    ("สุธิษา คนเดียว", {"สุธิษา"}),
    ("สาสนีย์ คนเดียว", {"สาสนีย์"}),
    ("วุฒิชัย คนเดียว", {"วุฒิชัย"}),
]

for label, assigned in tests:
    errs = _validate_or_grouped(assigned, night_shift, rows)
    status = "✓ PASS" if not errs else f"✗ FAIL: {'; '.join(errs)}"
    print(f"  {label}: {status}")

# ===== 5. เช็คว่า DB validation ปัจจุบัน (code ที่ deploy แล้ว) ทำงานยังไง =====
print("\n" + "=" * 60)
print("TEST: current DB _validate_depends_on_for_shift code behavior")
print("=" * 60)
# Simulate what the current code does
def current_code_simulate(assigned_set, shift_name, all_pair_rows):
    """Simulate current code AFTER fix (OR-grouped by dependent only)"""
    dep_groups = {}
    for provider, dependent, shift_raw in all_pair_rows:
        try:
            shifts = json.loads(shift_raw) if shift_raw else []
        except Exception:
            shifts = []
        shifts_clean = [str(s).strip() for s in shifts if str(s).strip()]
        if shifts_clean and shift_name not in shifts_clean:
            continue
        dep_groups.setdefault(dependent, []).append(provider)

    errors = []
    for dependent, providers in dep_groups.items():
        if dependent not in assigned_set:
            continue
        if not any(p in assigned_set for p in providers):
            errors.append(f"'{dependent}' ต้องอยู่กับ {' หรือ '.join(providers)}")
    return errors

for label, assigned in tests:
    errs = current_code_simulate(assigned, night_shift, rows)
    status = "✓ PASS" if not errs else f"✗ FAIL: {'; '.join(errs)}"
    print(f"  {label}: {status}")

print("\n✓ Done.")
conn.close()
