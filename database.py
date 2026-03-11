# database.py — แยกข้อมูล staff / กะ / settings ไว้ใน SQLite

import json
import os
import re
import sqlite3
from pathlib import Path

# ให้แต่ละเครื่อง (แต่ละ deploy) ใช้ DB คนละไฟล์ได้
# - DATABASE_PATH = path เต็ม (เช่น /data/optimizer.db) ใช้ไฟล์นี้เลย
# - INSTANCE_ID = สตริง (เช่น staging, หน่วยงานA) ใช้ shift_optimizer_{INSTANCE_ID}.db
# - ไม่ตั้งอะไร = shift_optimizer.db เหมือนเดิม
_base = Path(__file__).resolve().parent
if os.environ.get("DATABASE_PATH"):
    DB_PATH = Path(os.environ["DATABASE_PATH"])
elif os.environ.get("INSTANCE_ID"):
    DB_PATH = _base / f"shift_optimizer_{os.environ['INSTANCE_ID'].strip()}.db"
else:
    DB_PATH = _base / "shift_optimizer.db"
ROOMS = ("donor", "xmatch")


def _migrate_shifts_to_positions(conn):
    """One-time: for shifts with no shift_position rows, create Donor/Xmatch positions from donor/xmatch."""
    for row in conn.execute("SELECT id, name, donor, xmatch FROM shift").fetchall():
        sid, _, donor, xmatch = row
        has_pos = conn.execute("SELECT 1 FROM shift_position WHERE shift_id = ? LIMIT 1", (sid,)).fetchone()
        if has_pos:
            continue
        for i in range(donor):
            conn.execute(
                "INSERT INTO shift_position (shift_id, name, sort_order, regular_only) VALUES (?, ?, ?, 0)",
                (sid, "Donor" if donor == 1 else f"Donor{i+1}", i),
            )
        for i in range(xmatch):
            conn.execute(
                "INSERT INTO shift_position (shift_id, name, sort_order, regular_only) VALUES (?, ?, ?, 0)",
                (sid, "Xmatch" if xmatch == 1 else f"Xmatch{i+1}", donor + i),
            )
    conn.commit()


def _migrate_schedule_slot_to_position_pk(conn):
    """One-time: recreate schedule_slot with PK (run_id, day, shift_name, position) when old table has room column."""
    try:
        info = conn.execute("PRAGMA table_info(schedule_slot)").fetchall()
        cols = [c[1] for c in info]
        if "room" not in cols:
            return
    except Exception:
        return
    conn.execute("""
        CREATE TABLE schedule_slot_new (
            run_id INTEGER NOT NULL REFERENCES schedule_run(id) ON DELETE CASCADE,
            day INTEGER NOT NULL,
            shift_name TEXT NOT NULL,
            position TEXT NOT NULL,
            staff_name TEXT NOT NULL,
            time_window TEXT,
            PRIMARY KEY (run_id, day, shift_name, position)
        )
    """)
    conn.execute("""
        INSERT OR REPLACE INTO schedule_slot_new (run_id, day, shift_name, position, staff_name, time_window)
        SELECT run_id, day, shift_name, COALESCE(position, room), staff_name, time_window FROM schedule_slot
    """)
    conn.execute("DROP TABLE schedule_slot")
    conn.execute("ALTER TABLE schedule_slot_new RENAME TO schedule_slot")
    conn.commit()


def get_connection():
    return sqlite3.connect(DB_PATH)


def init_db(conn=None):
    """สร้างตารางถ้ายังไม่มี"""
    close = conn is None
    conn = conn or get_connection()
    try:
        conn.executescript("""
            CREATE TABLE IF NOT EXISTS settings (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS staff (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL UNIQUE,
                type TEXT NOT NULL CHECK (type IN ('fulltime', 'parttime'))
            );
            CREATE TABLE IF NOT EXISTS staff_skill (
                staff_id INTEGER NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
                skill TEXT NOT NULL CHECK (skill IN ('donor', 'xmatch')),
                PRIMARY KEY (staff_id, skill)
            );
            CREATE TABLE IF NOT EXISTS staff_off_day (
                staff_id INTEGER NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
                day INTEGER NOT NULL CHECK (day >= 0 AND day <= 6),
                PRIMARY KEY (staff_id, day)
            );
            CREATE TABLE IF NOT EXISTS shift (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL UNIQUE,
                donor INTEGER NOT NULL DEFAULT 1,
                xmatch INTEGER NOT NULL DEFAULT 1
            );
            CREATE TABLE IF NOT EXISTS schedule_run (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                created_at TEXT NOT NULL DEFAULT (datetime('now')),
                num_days INTEGER NOT NULL,
                start_date TEXT
            );
            CREATE TABLE IF NOT EXISTS schedule_slot (
                run_id INTEGER NOT NULL REFERENCES schedule_run(id) ON DELETE CASCADE,
                day INTEGER NOT NULL,
                shift_name TEXT NOT NULL,
                position TEXT NOT NULL,
                staff_name TEXT NOT NULL,
                time_window TEXT,
                PRIMARY KEY (run_id, day, shift_name, position)
            );
            CREATE TABLE IF NOT EXISTS shift_position (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                shift_id INTEGER NOT NULL REFERENCES shift(id) ON DELETE CASCADE,
                name TEXT NOT NULL,
                sort_order INTEGER NOT NULL DEFAULT 0,
                constraint_note TEXT,
                regular_only INTEGER NOT NULL DEFAULT 0
            );
            CREATE TABLE IF NOT EXISTS shift_time_window (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                shift_id INTEGER NOT NULL REFERENCES shift(id) ON DELETE CASCADE,
                name TEXT NOT NULL,
                start_time TEXT,
                end_time TEXT,
                min_count_per_day INTEGER
            );
            CREATE TABLE IF NOT EXISTS staff_availability (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                staff_id INTEGER NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
                time_window_name TEXT,
                day_of_week_mask TEXT,
                dates_list TEXT,
                can_evening INTEGER NOT NULL DEFAULT 0,
                can_friday INTEGER NOT NULL DEFAULT 0
            );
        """)
        conn.commit()
        try:
            conn.execute("ALTER TABLE schedule_run ADD COLUMN start_date TEXT")
            conn.commit()
        except sqlite3.OperationalError:
            pass
        try:
            conn.execute("ALTER TABLE schedule_slot ADD COLUMN position TEXT")
            conn.commit()
        except sqlite3.OperationalError:
            pass
        try:
            conn.execute("ALTER TABLE schedule_slot ADD COLUMN time_window TEXT")
            conn.commit()
        except sqlite3.OperationalError:
            pass
        try:
            conn.execute("ALTER TABLE shift ADD COLUMN active_days TEXT")
            conn.commit()
        except sqlite3.OperationalError:
            pass
        _migrate_shifts_to_positions(conn)
        _migrate_schedule_slot_to_position_pk(conn)
        _migrate_skill_catalog_and_staff_skill(conn)
        _migrate_staff_add_title(conn)
        _migrate_title_catalog(conn)
        _migrate_staff_off_day_of_month(conn)
        _migrate_shift_position_slot_count(conn)
        _migrate_schedule_slot_slot_index(conn)
        _migrate_time_window_catalog(conn)
        _migrate_position_and_staff_time_windows(conn)
        _migrate_skill_catalog_level(conn)
        _migrate_shift_position_required_skill(conn)
        _migrate_staff_skill_level(conn)
        _migrate_shift_position_allowed_titles(conn)
        _migrate_shift_position_max_per_week(conn)
        _migrate_skill_level_table(conn)
        _migrate_staff_min_max_shifts(conn)
        _migrate_staff_min_gap_days(conn)
        _migrate_shift_include_holidays(conn)
        _migrate_staff_pair(conn)
    finally:
        if close:
            conn.close()


def _migrate_staff_min_max_shifts(conn):
    """เพิ่มคอลัมน์ min/max shifts per month ให้ตาราง staff"""
    for col in ("min_shifts_per_month", "max_shifts_per_month"):
        try:
            conn.execute(f"ALTER TABLE staff ADD COLUMN {col} INTEGER")
            conn.commit()
        except sqlite3.OperationalError:
            pass


def _migrate_staff_min_gap_days(conn):
    """เพิ่มคอลัมน์ min_gap_days ให้ตาราง staff — ห่างกันอย่างน้อยกี่วัน"""
    try:
        conn.execute("ALTER TABLE staff ADD COLUMN min_gap_days INTEGER")
        conn.commit()
    except sqlite3.OperationalError:
        pass


def _migrate_shift_include_holidays(conn):
    """เพิ่มคอลัมน์ include_holidays ให้ตาราง shift"""
    try:
        conn.execute("ALTER TABLE shift ADD COLUMN include_holidays INTEGER NOT NULL DEFAULT 0")
        conn.commit()
    except sqlite3.OperationalError:
        pass


def _migrate_staff_pair(conn):
    """สร้างตาราง staff_pair สำหรับจับคู่/ห้ามคู่/ผูกกับ"""
    exists = conn.execute("SELECT count(*) FROM sqlite_master WHERE type='table' AND name='staff_pair'").fetchone()[0]
    if exists:
        try:
            conn.execute("INSERT INTO staff_pair (staff_id_1, staff_id_2, pair_type) VALUES (-1, -1, 'depends_on')")
            conn.execute("DELETE FROM staff_pair WHERE staff_id_1 = -1")
            conn.commit()
        except Exception:
            conn.rollback()
            rows = conn.execute("SELECT staff_id_1, staff_id_2, pair_type FROM staff_pair").fetchall()
            conn.execute("DROP TABLE staff_pair")
            conn.execute("""
                CREATE TABLE staff_pair (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    staff_id_1 INTEGER NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
                    staff_id_2 INTEGER NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
                    pair_type TEXT NOT NULL CHECK (pair_type IN ('together', 'apart', 'depends_on'))
                )
            """)
            for r in rows:
                if r[2] in ('together', 'apart', 'depends_on'):
                    conn.execute("INSERT INTO staff_pair (staff_id_1, staff_id_2, pair_type) VALUES (?, ?, ?)", r)
            conn.commit()
    else:
        conn.execute("""
            CREATE TABLE staff_pair (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                staff_id_1 INTEGER NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
                staff_id_2 INTEGER NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
                pair_type TEXT NOT NULL CHECK (pair_type IN ('together', 'apart', 'depends_on'))
            )
        """)
        conn.commit()


def _migrate_skill_catalog_and_staff_skill(conn):
    """สร้าง skill_catalog และให้ staff_skill รับ skill อะไรก็ได้ (ไม่จำกัด donor,xmatch)"""
    conn.execute("CREATE TABLE IF NOT EXISTS skill_catalog (name TEXT PRIMARY KEY)")
    try:
        # SQLite ไม่สามารถเอา CHECK ออกจากคอลัมน์ได้ จึงสร้างตารางใหม่แล้วย้ายข้อมูล
        conn.execute("""
            CREATE TABLE staff_skill_new (
                staff_id INTEGER NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
                skill TEXT NOT NULL,
                PRIMARY KEY (staff_id, skill)
            )
        """)
        conn.execute("INSERT INTO staff_skill_new (staff_id, skill) SELECT staff_id, skill FROM staff_skill")
        conn.execute("DROP TABLE staff_skill")
        conn.execute("ALTER TABLE staff_skill_new RENAME TO staff_skill")
    except sqlite3.OperationalError:
        pass  # อาจมีแล้วหรือตารางเดิมไม่มี CHECK
    conn.commit()


def _migrate_skill_catalog_level(conn):
    """เพิ่ม level (rank) ให้ skill_catalog: 1=ต่ำ, 2=กลาง, 3=สูง"""
    try:
        conn.execute("ALTER TABLE skill_catalog ADD COLUMN level INTEGER NOT NULL DEFAULT 1")
        conn.commit()
    except sqlite3.OperationalError:
        pass


def _migrate_shift_position_required_skill(conn):
    """เพิ่ม required_skill และ min_skill_level ให้ shift_position"""
    try:
        conn.execute("ALTER TABLE shift_position ADD COLUMN required_skill TEXT")
        conn.commit()
    except sqlite3.OperationalError:
        pass
    try:
        conn.execute("ALTER TABLE shift_position ADD COLUMN min_skill_level INTEGER NOT NULL DEFAULT 0")
        conn.commit()
    except sqlite3.OperationalError:
        pass


def _migrate_shift_position_max_per_week(conn):
    """เพิ่ม max_per_week ให้ shift_position: จำนวนสูงสุดต่อสัปดาห์ที่คนๆ นึงทำตำแหน่งนี้ได้ (0 = ไม่จำกัด)"""
    try:
        conn.execute("ALTER TABLE shift_position ADD COLUMN max_per_week INTEGER NOT NULL DEFAULT 0")
        conn.commit()
    except sqlite3.OperationalError:
        pass


def _migrate_staff_skill_level(conn):
    """เพิ่ม level ให้ staff_skill (ระดับทักษะของแต่ละคน)"""
    try:
        conn.execute("ALTER TABLE staff_skill ADD COLUMN level INTEGER NOT NULL DEFAULT 1")
        conn.commit()
    except sqlite3.OperationalError:
        pass


def _migrate_shift_position_allowed_titles(conn):
    """เพิ่ม allowed_titles (JSON text) ให้ shift_position — ระบุฉายาที่อนุญาตให้อยู่ช่องนี้ได้"""
    try:
        conn.execute("ALTER TABLE shift_position ADD COLUMN allowed_titles TEXT")
        conn.commit()
    except sqlite3.OperationalError:
        pass


def _migrate_skill_level_table(conn):
    """สร้างตาราง skill_level สำหรับระดับทักษะกำหนดเองต่อทักษะ"""
    conn.execute("""
        CREATE TABLE IF NOT EXISTS skill_level (
            skill_name TEXT NOT NULL,
            level INTEGER NOT NULL,
            label TEXT NOT NULL,
            PRIMARY KEY (skill_name, level)
        )
    """)
    conn.commit()


def get_skill_levels(skill_name: str, conn=None):
    """คืน list ของ {level, label} เรียงตาม level สำหรับทักษะที่ระบุ"""
    close = conn is None
    conn = conn or get_connection()
    try:
        rows = conn.execute(
            "SELECT level, label FROM skill_level WHERE skill_name = ? ORDER BY level",
            (skill_name,),
        ).fetchall()
        return [{"level": r[0], "label": r[1]} for r in rows]
    finally:
        if close:
            conn.close()


def set_skill_levels(skill_name: str, labels: list[str], conn=None):
    """ตั้งระดับทักษะใหม่ทั้งหมด — labels เป็น list ชื่อระดับเรียงจากต่ำไปสูง"""
    close = conn is None
    conn = conn or get_connection()
    try:
        conn.execute("DELETE FROM skill_level WHERE skill_name = ?", (skill_name,))
        for i, label in enumerate(labels, start=1):
            conn.execute(
                "INSERT INTO skill_level (skill_name, level, label) VALUES (?, ?, ?)",
                (skill_name, i, label.strip()),
            )
        conn.commit()
    finally:
        if close:
            conn.close()


def rename_skill_catalog(old_name: str, new_name: str, conn=None):
    """เปลี่ยนชื่อทักษะใน catalog และใน staff_skill"""
    old_name = (old_name or "").strip()
    new_name = (new_name or "").strip()
    if not old_name or not new_name or old_name == new_name:
        return
    close = conn is None
    conn = conn or get_connection()
    try:
        conn.execute("BEGIN")
        conn.execute("UPDATE skill_catalog SET name = ? WHERE name = ?", (new_name, old_name))
        conn.execute("UPDATE staff_skill SET skill = ? WHERE skill = ?", (new_name, old_name))
        conn.execute("UPDATE skill_level SET skill_name = ? WHERE skill_name = ?", (new_name, old_name))
        conn.commit()
    except sqlite3.IntegrityError:
        conn.rollback()
        raise
    finally:
        if close:
            conn.close()


def _migrate_staff_add_title(conn):
    """เพิ่มคอลัมน์ ฉายา/ตำแหน่ง ใน staff"""
    try:
        conn.execute("ALTER TABLE staff ADD COLUMN title TEXT")
        conn.commit()
    except sqlite3.OperationalError:
        pass


def _migrate_title_catalog(conn):
    """ตารางรายการฉายา/ตำแหน่ง (เลือกให้บุคลากร แทน type แยก)"""
    conn.execute(
        "CREATE TABLE IF NOT EXISTS title_catalog (name TEXT PRIMARY KEY, type TEXT NOT NULL DEFAULT 'fulltime' CHECK (type IN ('fulltime', 'parttime')))"
    )
    conn.execute("INSERT OR IGNORE INTO title_catalog (name, type) VALUES ('เต็มเวลา', 'fulltime'), ('พาร์ทไทม์', 'parttime')")
    conn.commit()


def _migrate_staff_off_day_of_month(conn):
    """วันหยุดรายเดือน: วันที่ของเดือน (1-31) ที่บุคลากรหยุดทุกเดือน"""
    conn.execute("""
        CREATE TABLE IF NOT EXISTS staff_off_day_of_month (
            staff_id INTEGER NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
            day INTEGER NOT NULL CHECK (day >= 1 AND day <= 31),
            PRIMARY KEY (staff_id, day)
        )
    """)
    conn.commit()


def _migrate_shift_position_slot_count(conn):
    """จำนวนคนต่อตำแหน่ง (default 1)"""
    try:
        conn.execute("ALTER TABLE shift_position ADD COLUMN slot_count INTEGER NOT NULL DEFAULT 1")
        conn.commit()
    except sqlite3.OperationalError:
        pass


def _migrate_time_window_catalog(conn):
    """รายการช่วงเวลา (สำหรับเช็คว่าคนอยู่ได้ครบช่วงที่ช่องต้องการหรือไม่)"""
    conn.execute("""
        CREATE TABLE IF NOT EXISTS time_window_catalog (
            name TEXT PRIMARY KEY,
            start_time TEXT NOT NULL,
            end_time TEXT NOT NULL
        )
    """)
    conn.execute(
        "INSERT OR IGNORE INTO time_window_catalog (name, start_time, end_time) VALUES (?, ?, ?)",
        ("06:30-08:30", "06:30", "08:30"),
    )
    conn.execute(
        "INSERT OR IGNORE INTO time_window_catalog (name, start_time, end_time) VALUES (?, ?, ?)",
        ("06:30-10:00", "06:30", "10:00"),
    )
    conn.execute(
        "INSERT OR IGNORE INTO time_window_catalog (name, start_time, end_time) VALUES (?, ?, ?)",
        ("06:30-12:00", "06:30", "12:00"),
    )
    conn.commit()


def _migrate_position_and_staff_time_windows(conn):
    """ช่องระบุช่วงเวลาที่ต้องการ; บุคลากรระบุช่วงที่อยู่ได้"""
    try:
        conn.execute("ALTER TABLE shift_position ADD COLUMN time_window_name TEXT")
        conn.commit()
    except sqlite3.OperationalError:
        pass
    conn.execute("""
        CREATE TABLE IF NOT EXISTS staff_time_window (
            staff_id INTEGER NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
            time_window_name TEXT NOT NULL,
            PRIMARY KEY (staff_id, time_window_name)
        )
    """)
    conn.commit()


def _migrate_schedule_slot_slot_index(conn):
    """เพิ่ม slot_index ใน schedule_slot เพื่อรองรับตำแหน่งเดียวกันหลายคน (PK เปลี่ยน)"""
    info = conn.execute("PRAGMA table_info(schedule_slot)").fetchall()
    if any(c[1] == "slot_index" for c in info):
        return
    try:
        conn.execute("""
            CREATE TABLE schedule_slot_new (
                run_id INTEGER NOT NULL REFERENCES schedule_run(id) ON DELETE CASCADE,
                day INTEGER NOT NULL,
                shift_name TEXT NOT NULL,
                position TEXT NOT NULL,
                slot_index INTEGER NOT NULL DEFAULT 0,
                staff_name TEXT NOT NULL,
                time_window TEXT,
                PRIMARY KEY (run_id, day, shift_name, position, slot_index)
            )
        """)
        conn.execute("""
            INSERT INTO schedule_slot_new (run_id, day, shift_name, position, slot_index, staff_name, time_window)
            SELECT run_id, day, shift_name, position, 0, staff_name, time_window FROM schedule_slot
        """)
        conn.execute("DROP TABLE schedule_slot")
        conn.execute("ALTER TABLE schedule_slot_new RENAME TO schedule_slot")
        conn.commit()
    except sqlite3.OperationalError:
        pass


def list_time_window_catalog(conn=None):
    """รายการช่วงเวลา (สำหรับเลือกให้ช่อง/บุคลากร)"""
    close = conn is None
    conn = conn or get_connection()
    try:
        rows = conn.execute(
            "SELECT name, start_time, end_time FROM time_window_catalog ORDER BY start_time, end_time"
        ).fetchall()
        return [{"name": r[0], "start_time": r[1], "end_time": r[2]} for r in rows]
    finally:
        if close:
            conn.close()


def get_time_window_catalog_dict(conn=None):
    """คืน dict name -> {start_time, end_time} สำหรับ scheduler เช็ค contains"""
    close = conn is None
    conn = conn or get_connection()
    try:
        rows = conn.execute(
            "SELECT name, start_time, end_time FROM time_window_catalog"
        ).fetchall()
        return {r[0]: {"start_time": r[1], "end_time": r[2]} for r in rows}
    finally:
        if close:
            conn.close()


_TIME_RE = re.compile(r"^\d{2}:\d{2}$")


def add_time_window_catalog(name: str, start_time: str, end_time: str, conn=None):
    """เพิ่มช่วงเวลาใน catalog (name เช่น 06:30-12:00)"""
    close = conn is None
    conn = conn or get_connection()
    try:
        n = (name or "").strip()
        st = (start_time or "").strip()
        en = (end_time or "").strip()
        if not n or not st or not en:
            raise ValueError("name, start_time, end_time ต้องไม่ว่าง")
        if not _TIME_RE.match(st) or not _TIME_RE.match(en):
            raise ValueError(f"start_time/end_time ต้องอยู่ในรูปแบบ HH:MM (เช่น 06:30) — ได้รับ: '{st}', '{en}'")
        conn.execute(
            "INSERT OR REPLACE INTO time_window_catalog (name, start_time, end_time) VALUES (?, ?, ?)",
            (n, st, en),
        )
        conn.commit()
    finally:
        if close:
            conn.close()


def remove_time_window_catalog(name: str, conn=None):
    """ลบช่วงเวลาออกจาก catalog (ไม่ลบการเลือกที่ใส่ให้ staff/ช่องแล้ว แค่เอาออกจากตัวเลือก)"""
    close = conn is None
    conn = conn or get_connection()
    try:
        conn.execute("DELETE FROM time_window_catalog WHERE name = ?", (name,))
        conn.commit()
    finally:
        if close:
            conn.close()


def list_title_catalog(conn=None):
    """รายการฉายา/ตำแหน่ง ทั้งหมด"""
    close = conn is None
    conn = conn or get_connection()
    try:
        rows = conn.execute("SELECT name, type FROM title_catalog ORDER BY name").fetchall()
        return [{"name": r[0], "type": r[1]} for r in rows]
    finally:
        if close:
            conn.close()


def add_title_catalog(name: str, stype: str = "fulltime", conn=None):
    close = conn is None
    conn = conn or get_connection()
    try:
        conn.execute("INSERT OR IGNORE INTO title_catalog (name, type) VALUES (?, ?)", (name.strip(), stype))
        conn.commit()
    finally:
        if close:
            conn.close()


def remove_title_catalog(name: str, conn=None):
    close = conn is None
    conn = conn or get_connection()
    try:
        conn.execute("DELETE FROM title_catalog WHERE name = ?", (name,))
        conn.commit()
    finally:
        if close:
            conn.close()


def get_title_type(name: str, conn=None):
    """คืน type (fulltime/parttime) ของฉายา ถ้าไม่มีใน catalog คืน fulltime"""
    if not (name or "").strip():
        return "fulltime"
    close = conn is None
    conn = conn or get_connection()
    try:
        row = conn.execute("SELECT type FROM title_catalog WHERE name = ?", (name.strip(),)).fetchone()
        return row[0] if row else "fulltime"
    finally:
        if close:
            conn.close()


def list_skill_catalog(conn=None):
    """รายการทักษะทั้งหมด พร้อมระดับ — คืน list ของ {name, levels: [{level, label}]}"""
    close = conn is None
    conn = conn or get_connection()
    try:
        skills = conn.execute("SELECT name FROM skill_catalog ORDER BY name").fetchall()
        result = []
        for (sname,) in skills:
            lvl_rows = conn.execute(
                "SELECT level, label FROM skill_level WHERE skill_name = ? ORDER BY level",
                (sname,),
            ).fetchall()
            result.append({
                "name": sname,
                "levels": [{"level": r[0], "label": r[1]} for r in lvl_rows],
            })
        return result
    finally:
        if close:
            conn.close()


def add_skill_catalog(name: str, conn=None):
    """เพิ่มทักษะใน catalog"""
    close = conn is None
    conn = conn or get_connection()
    try:
        conn.execute("INSERT OR IGNORE INTO skill_catalog (name) VALUES (?)", (name.strip(),))
        conn.commit()
    finally:
        if close:
            conn.close()


def update_skill_level(name: str, level: int, conn=None):
    """อัปเดต level ของทักษะใน catalog"""
    close = conn is None
    conn = conn or get_connection()
    try:
        level = max(1, min(3, int(level or 1)))
        conn.execute("UPDATE skill_catalog SET level = ? WHERE name = ?", (level, name))
        conn.commit()
    finally:
        if close:
            conn.close()


def remove_skill_catalog(name: str, conn=None):
    """ลบทักษะออกจาก catalog + ระดับทักษะที่เกี่ยวข้อง"""
    close = conn is None
    conn = conn or get_connection()
    try:
        conn.execute("DELETE FROM skill_level WHERE skill_name = ?", (name,))
        conn.execute("DELETE FROM skill_catalog WHERE name = ?", (name,))
        conn.commit()
    finally:
        if close:
            conn.close()


def _batch_load_staff_data(conn, staff_ids):
    """โหลดข้อมูล off_days, skills, time_windows สำหรับ staff หลายคนในครั้งเดียว (5 queries แทน N*5)"""
    if not staff_ids:
        return {}, {}, {}, {}, {}
    ph = ",".join("?" * len(staff_ids))
    off_days_map: dict = {}
    for r in conn.execute(f"SELECT staff_id, day FROM staff_off_day WHERE staff_id IN ({ph}) ORDER BY staff_id, day", staff_ids).fetchall():
        off_days_map.setdefault(r[0], []).append(r[1])
    off_month_map: dict = {}
    for r in conn.execute(f"SELECT staff_id, day FROM staff_off_day_of_month WHERE staff_id IN ({ph}) ORDER BY staff_id, day", staff_ids).fetchall():
        off_month_map.setdefault(r[0], []).append(r[1])
    skills_map: dict = {}
    skill_levels_map: dict = {}
    for r in conn.execute(f"SELECT staff_id, skill, COALESCE(level, 1) FROM staff_skill WHERE staff_id IN ({ph}) ORDER BY staff_id, skill", staff_ids).fetchall():
        skills_map.setdefault(r[0], []).append(r[1])
        skill_levels_map.setdefault(r[0], {})[r[1]] = int(r[2])
    tw_map: dict = {}
    for r in conn.execute(f"SELECT staff_id, time_window_name FROM staff_time_window WHERE staff_id IN ({ph}) ORDER BY staff_id, time_window_name", staff_ids).fetchall():
        tw_map.setdefault(r[0], []).append(r[1])
    return off_days_map, off_month_map, skills_map, skill_levels_map, tw_map


def get_mt_list(conn=None):
    """โหลดรายชื่อ MT ในรูปแบบเดียวกับ config (สำหรับ scheduler)"""
    close = conn is None
    conn = conn or get_connection()
    try:
        rows = conn.execute(
            "SELECT id, name, type, COALESCE(title, ''), min_shifts_per_month, max_shifts_per_month, min_gap_days FROM staff ORDER BY id"
        ).fetchall()
        if not rows:
            return []
        staff_ids = [r[0] for r in rows]
        off_days_map, off_month_map, skills_map, skill_levels_map, tw_map = _batch_load_staff_data(conn, staff_ids)
        mt_list = []
        for sid, name, stype, title, mn, mx, gap in rows:
            mt_list.append({
                "name": name,
                "type": stype,
                "title": title or "",
                "off_days": off_days_map.get(sid, []),
                "off_days_of_month": off_month_map.get(sid, []),
                "skills": skills_map.get(sid, []),
                "skill_levels": skill_levels_map.get(sid, {}),
                "time_windows": tw_map.get(sid, []),
                "min_shifts_per_month": mn,
                "max_shifts_per_month": mx,
                "min_gap_days": gap,
            })
        return mt_list
    finally:
        if close:
            conn.close()


def list_staff(conn=None):
    """โหลด staff พร้อม id สำหรับ API"""
    close = conn is None
    conn = conn or get_connection()
    try:
        rows = conn.execute("SELECT id, name, type, COALESCE(title, ''), min_shifts_per_month, max_shifts_per_month, min_gap_days FROM staff ORDER BY id").fetchall()
        if not rows:
            return []
        staff_ids = [r[0] for r in rows]
        off_days_map, off_month_map, skills_map, skill_levels_map, tw_map = _batch_load_staff_data(conn, staff_ids)
        return [
            {
                "id": sid,
                "name": name,
                "type": stype,
                "title": title or "",
                "off_days": off_days_map.get(sid, []),
                "off_days_of_month": off_month_map.get(sid, []),
                "skills": skills_map.get(sid, []),
                "skill_levels": skill_levels_map.get(sid, {}),
                "time_windows": tw_map.get(sid, []),
                "min_shifts_per_month": mn,
                "max_shifts_per_month": mx,
                "min_gap_days": gap,
            }
            for sid, name, stype, title, mn, mx, gap in rows
        ]
    finally:
        if close:
            conn.close()


def get_staff(staff_id: int, conn=None):
    """โหลดบุคลากรหนึ่งคนตาม id คืน None ถ้าไม่พบ"""
    close = conn is None
    conn = conn or get_connection()
    try:
        row = conn.execute("SELECT id, name, type, COALESCE(title, ''), min_shifts_per_month, max_shifts_per_month, min_gap_days FROM staff WHERE id = ?", (staff_id,)).fetchone()
        if not row:
            return None
        sid, name, stype, title, mn, mx, gap = row
        off_days = [r[0] for r in conn.execute("SELECT day FROM staff_off_day WHERE staff_id = ? ORDER BY day", (sid,)).fetchall()]
        off_days_of_month = [r[0] for r in conn.execute("SELECT day FROM staff_off_day_of_month WHERE staff_id = ? ORDER BY day", (sid,)).fetchall()]
        skills = [r[0] for r in conn.execute("SELECT skill FROM staff_skill WHERE staff_id = ? ORDER BY skill", (sid,)).fetchall()]
        skill_levels = {r[0]: int(r[1] or 1) for r in conn.execute("SELECT skill, COALESCE(level, 1) FROM staff_skill WHERE staff_id = ?", (sid,)).fetchall()}
        time_windows = [r[0] for r in conn.execute("SELECT time_window_name FROM staff_time_window WHERE staff_id = ? ORDER BY time_window_name", (sid,)).fetchall()]
        return {"id": sid, "name": name, "type": stype, "title": title or "", "off_days": off_days, "off_days_of_month": off_days_of_month, "skills": skills, "skill_levels": skill_levels, "time_windows": time_windows, "min_shifts_per_month": mn, "max_shifts_per_month": mx, "min_gap_days": gap}
    finally:
        if close:
            conn.close()


def create_staff(name, off_days=None, skills=None, title=None, off_days_of_month=None, time_windows=None, min_shifts_per_month=None, max_shifts_per_month=None, min_gap_days=None, conn=None):
    off_days = off_days or []
    skills = skills or []
    off_days_of_month = off_days_of_month or []
    time_windows = time_windows or []
    title = (title or "").strip() or None
    close = conn is None
    conn = conn or get_connection()
    try:
        stype = get_title_type(title or "", conn)
        cur = conn.execute(
            "INSERT INTO staff (name, type, title, min_shifts_per_month, max_shifts_per_month, min_gap_days) VALUES (?, ?, ?, ?, ?, ?)",
            (name, stype, title, min_shifts_per_month, max_shifts_per_month, min_gap_days),
        )
        sid = cur.lastrowid
        for d in off_days:
            conn.execute("INSERT INTO staff_off_day (staff_id, day) VALUES (?, ?)", (sid, d))
        for d in off_days_of_month:
            if 1 <= d <= 31:
                conn.execute("INSERT INTO staff_off_day_of_month (staff_id, day) VALUES (?, ?)", (sid, d))
        for s in skills:
            conn.execute("INSERT INTO staff_skill (staff_id, skill) VALUES (?, ?)", (sid, s))
        for tw in time_windows:
            if tw and str(tw).strip():
                conn.execute("INSERT INTO staff_time_window (staff_id, time_window_name) VALUES (?, ?)", (sid, str(tw).strip()))
        conn.commit()
        return sid
    except Exception:
        conn.rollback()
        raise
    finally:
        if close:
            conn.close()


def update_staff(sid, name, off_days=None, skills=None, title=None, off_days_of_month=None, time_windows=None, skill_levels=None, min_shifts_per_month=None, max_shifts_per_month=None, min_gap_days=None, conn=None):
    off_days = off_days or []
    skills = skills or []
    off_days_of_month = off_days_of_month or []
    time_windows = time_windows or []
    skill_levels = skill_levels or {}
    title = (title or "").strip() or None
    close = conn is None
    conn = conn or get_connection()
    try:
        stype = get_title_type(title or "", conn)
        conn.execute(
            "UPDATE staff SET name = ?, type = ?, title = ?, min_shifts_per_month = ?, max_shifts_per_month = ?, min_gap_days = ? WHERE id = ?",
            (name, stype, title, min_shifts_per_month, max_shifts_per_month, min_gap_days, sid),
        )
        conn.execute("DELETE FROM staff_off_day WHERE staff_id = ?", (sid,))
        conn.execute("DELETE FROM staff_off_day_of_month WHERE staff_id = ?", (sid,))
        conn.execute("DELETE FROM staff_skill WHERE staff_id = ?", (sid,))
        conn.execute("DELETE FROM staff_time_window WHERE staff_id = ?", (sid,))
        for d in off_days:
            conn.execute("INSERT INTO staff_off_day (staff_id, day) VALUES (?, ?)", (sid, d))
        for d in off_days_of_month:
            if 1 <= d <= 31:
                conn.execute("INSERT INTO staff_off_day_of_month (staff_id, day) VALUES (?, ?)", (sid, d))
        for s in skills:
            lvl = max(1, min(3, int(skill_levels.get(s, 1) or 1)))
            conn.execute("INSERT INTO staff_skill (staff_id, skill, level) VALUES (?, ?, ?)", (sid, s, lvl))
        for tw in time_windows:
            if tw and str(tw).strip():
                conn.execute("INSERT INTO staff_time_window (staff_id, time_window_name) VALUES (?, ?)", (sid, str(tw).strip()))
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        if close:
            conn.close()


def delete_staff(sid, conn=None):
    close = conn is None
    conn = conn or get_connection()
    try:
        conn.execute("DELETE FROM staff WHERE id = ?", (sid,))
        conn.commit()
    finally:
        if close:
            conn.close()


def list_shifts(conn=None):
    """โหลดกะพร้อม id และ positions สำหรับ API"""
    close = conn is None
    conn = conn or get_connection()
    try:
        rows = conn.execute("SELECT id, name, donor, xmatch, active_days, COALESCE(include_holidays,0) FROM shift ORDER BY id").fetchall()
        result = []
        for r in rows:
            sid, name, donor, xmatch = r[0], r[1], r[2], r[3]
            active_days = r[4] if len(r) > 4 else None
            include_holidays = bool(r[5]) if len(r) > 5 else False
            pos_rows = conn.execute(
                "SELECT name, constraint_note, regular_only, COALESCE(slot_count, 1), time_window_name, COALESCE(allowed_titles,'[]'), COALESCE(max_per_week, 0) FROM shift_position WHERE shift_id = ? ORDER BY sort_order",
                (sid,),
            ).fetchall()
            if pos_rows:
                positions = [
                    {"name": p[0], "constraint_note": p[1] or "", "regular_only": bool(p[2]), "slot_count": int(p[3]), "time_window_name": (p[4] if len(p) > 4 and p[4] else None) or "", "allowed_titles": json.loads(p[5] or "[]"), "max_per_week": int(p[6] or 0)}
                    for p in pos_rows
                ]
                result.append({"id": sid, "name": name, "positions": positions, "active_days": active_days, "include_holidays": include_holidays})
            else:
                result.append({
                    "id": sid,
                    "name": name,
                    "donor": donor,
                    "xmatch": xmatch,
                    "positions": [{"name": "Donor", "constraint_note": "", "regular_only": False}] * donor
                    + [{"name": "Xmatch", "constraint_note": "", "regular_only": False}] * xmatch,
                    "active_days": active_days,
                    "include_holidays": include_holidays,
                })
        return result
    finally:
        if close:
            conn.close()


def _insert_position(conn, shift_id, index, p):
    nm = p.get("name", "")
    note = p.get("constraint_note") or ""
    reg = 1 if p.get("regular_only") else 0
    cnt = max(1, int(p.get("slot_count", 1)))
    tw = (p.get("time_window_name") or "").strip() or None
    req_skill = (p.get("required_skill") or "").strip() or None
    min_lvl = max(0, int(p.get("min_skill_level") or 0))
    allowed = p.get("allowed_titles") or []
    allowed_json = json.dumps(allowed, ensure_ascii=False) if allowed else None
    mpw = max(0, int(p.get("max_per_week") or 0))
    conn.execute(
        "INSERT INTO shift_position (shift_id, name, sort_order, constraint_note, regular_only, slot_count, time_window_name, required_skill, min_skill_level, allowed_titles, max_per_week) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (shift_id, nm, index, note, reg, cnt, tw, req_skill, min_lvl, allowed_json, mpw),
    )


def create_shift(name, donor=1, xmatch=1, positions=None, active_days=None, include_holidays=False, conn=None):
    close = conn is None
    conn = conn or get_connection()
    try:
        cur = conn.execute("INSERT INTO shift (name, donor, xmatch, active_days, include_holidays) VALUES (?, ?, ?, ?, ?)", (name, donor, xmatch, active_days or None, 1 if include_holidays else 0))
        sid = cur.lastrowid
        if positions:
            for i, p in enumerate(positions):
                _insert_position(conn, sid, i, p)
        conn.commit()
        return sid
    finally:
        if close:
            conn.close()


def update_shift(sid, name, donor=1, xmatch=1, positions=None, active_days=None, include_holidays=False, conn=None):
    close = conn is None
    conn = conn or get_connection()
    try:
        conn.execute("UPDATE shift SET name = ?, donor = ?, xmatch = ?, active_days = ?, include_holidays = ? WHERE id = ?", (name, donor, xmatch, active_days or None, 1 if include_holidays else 0, sid))
        conn.execute("DELETE FROM shift_position WHERE shift_id = ?", (sid,))
        if positions:
            for i, p in enumerate(positions):
                _insert_position(conn, sid, i, p)
        conn.commit()
    finally:
        if close:
            conn.close()


def delete_shift(sid, conn=None):
    close = conn is None
    conn = conn or get_connection()
    try:
        conn.execute("DELETE FROM shift WHERE id = ?", (sid,))
        conn.commit()
    finally:
        if close:
            conn.close()


# Template 1 (เวรเจาะเลือด): บุคลากร 11 คนเพิ่มจาก config (รวมกับคนเก่า 10 = 21 คน)
# ช่วงเวลาเริ่มต้นที่ใช้กับกะและบุคลากร (ต้องมีใน time_window_catalog)
TEMPLATE_1_DEFAULT_TIME_WINDOW = "06:30-12:00"

# ชื่อทักษะเจาะเลือดใน template 1 (ใช้ในช่อง รถเข็น + catalog)
TEMPLATE_1_PHLEBOTOMY_SKILL = "เจาะเลือด"

TEMPLATE_1_STAFF_NAMES = [
    "สมชาย", "วิชัย", "มานะ", "สมหญิง", "กัลยา", "ประเสริฐ", "วรรณา", "สมศักดิ์", "นภา", "อนุชา", "เรณู",
]

# สัดส่วน time window ที่ต้องการใน template 1 (กำหนดว่า staff แต่ละช่วงมีกี่คน)
TEMPLATE_1_TW_DISTRIBUTION = [
    # (time_window_name, จำนวน staff ที่จะ seed ด้วย time window นี้)
    ("06:30-12:00", 4),   # อยู่เต็ม — รวม หัวหน้า + รถเข็น + ช่อง 1-2
    ("06:30-10:00", 3),   # อยู่ถึง 10 โมง
    ("06:30-08:30", 14),  # อยู่ถึง 8.30 — ที่เหลือ
]


def create_shift_from_template(template_id: int, name_override: str | None = None, conn=None):
    """Create a shift from template 1, 2, 3, or 4. Returns new shift id."""
    close = conn is None
    conn = conn or get_connection()
    try:
        if template_id == 1:
            name = name_override or "เวรเจาะเลือด"
            # เพิ่ม skill เจาะเลือด (level 1,2,3) ใน catalog ถ้ายังไม่มี
            conn.execute("INSERT OR IGNORE INTO skill_catalog (name, level) VALUES (?, ?)", (TEMPLATE_1_PHLEBOTOMY_SKILL, 1))
            set_skill_levels(TEMPLATE_1_PHLEBOTOMY_SKILL, ["เบื้องต้น", "พอใช้", "ชำนาญ"], conn=conn)
            conn.commit()
            # --- positions ---
            # ช่อง 10 = หัวหน้าเวร: regular_only, อยู่เต็มเวลา 06:30-12:00
            # รถเข็น: ต้องเจาะเลือดระดับกลาง (min_skill_level=2), 06:30-12:00
            # ช่อง 1-2: 06:30-12:00 (full)
            # ช่อง 3-5: 06:30-10:00
            # ช่อง 6-9: 06:30-8:30
            TW_FULL = "06:30-12:00"
            positions = [
                {"name": "ช่อง 10 (หัวหน้า)", "constraint_note": "หัวหน้าเวร ต้องประจำเต็มเวลา", "regular_only": True,  "slot_count": 1, "time_window_name": TW_FULL,  "required_skill": TEMPLATE_1_PHLEBOTOMY_SKILL, "min_skill_level": 3},
                {"name": "รถเข็น",             "constraint_note": "เจาะเลือดรถเข็น ต้องมีทักษะระดับกลางขึ้นไป",          "regular_only": False, "slot_count": 1, "time_window_name": TW_FULL,  "required_skill": TEMPLATE_1_PHLEBOTOMY_SKILL, "min_skill_level": 2},
                {"name": "ช่อง 1",             "constraint_note": "", "regular_only": False, "slot_count": 1},
                {"name": "ช่อง 2",             "constraint_note": "", "regular_only": False, "slot_count": 1},
                {"name": "ช่อง 3",             "constraint_note": "", "regular_only": False, "slot_count": 1},
                {"name": "ช่อง 4",             "constraint_note": "", "regular_only": False, "slot_count": 1},
                {"name": "ช่อง 5",             "constraint_note": "", "regular_only": False, "slot_count": 1},
                {"name": "ช่อง 6",             "constraint_note": "", "regular_only": False, "slot_count": 1},
                {"name": "ช่อง 7",             "constraint_note": "", "regular_only": False, "slot_count": 1},
                {"name": "ช่อง 8",             "constraint_note": "", "regular_only": False, "slot_count": 1},
                {"name": "ช่อง 9",             "constraint_note": "", "regular_only": False, "slot_count": 1},
            ]
            sid = create_shift(name, donor=0, xmatch=0, positions=positions, conn=conn)
            return sid
        if template_id == 2:
            TW_DAY  = "08:00-16:00"
            TW_AFT  = "16:00-20:00"
            TW_EVE  = "16:00-24:00"
            TW_NITE = "00:00-08:00"
            for tw_name, t_start, t_end in [
                (TW_DAY,  "08:00", "16:00"),
                (TW_AFT,  "16:00", "20:00"),
                (TW_EVE,  "16:00", "24:00"),
                (TW_NITE, "00:00", "08:00"),
            ]:
                conn.execute(
                    "INSERT OR IGNORE INTO time_window_catalog (name, start_time, end_time) VALUES (?, ?, ?)",
                    (tw_name, t_start, t_end),
                )
            conn.commit()

            TITLE_FT = "MT เต็มเวลา"
            # เวรเช้า Micro (เสาร์-อาทิตย์ + วันหยุด): 3 คน, ฉายา MT เต็มเวลา เท่านั้น
            s1 = create_shift(
                name_override or "เวรเช้า Micro", donor=0, xmatch=0,
                active_days="5,6", include_holidays=True,
                positions=[
                    {"name": "เช้า 1", "constraint_note": "เต็มเวลาเท่านั้น", "slot_count": 1, "time_window_name": TW_DAY, "allowed_titles": [TITLE_FT]},
                    {"name": "เช้า 2", "constraint_note": "เต็มเวลาเท่านั้น", "slot_count": 1, "time_window_name": TW_DAY, "allowed_titles": [TITLE_FT]},
                    {"name": "เช้า 3", "constraint_note": "เต็มเวลาเท่านั้น", "slot_count": 1, "time_window_name": TW_DAY, "allowed_titles": [TITLE_FT]},
                ],
                conn=conn,
            )
            # เวรบ่าย Micro (ทุกวัน): 2 ตำแหน่ง — ฉายา MT เต็มเวลา เท่านั้น
            s2 = create_shift(
                "เวรบ่าย Micro", donor=0, xmatch=0, active_days=None,
                positions=[
                    {"name": "บ่าย 16-20", "constraint_note": "16:00-20:00 เต็มเวลา", "slot_count": 1, "time_window_name": TW_AFT, "allowed_titles": [TITLE_FT]},
                    {"name": "บ่าย 16-24", "constraint_note": "16:00-24:00 เต็มเวลา", "slot_count": 1, "time_window_name": TW_EVE, "allowed_titles": [TITLE_FT]},
                ],
                conn=conn,
            )
            TITLE_PT = "MT พาร์ทไทม์"
            # เวรดึก Micro (ทุกวัน): 1 คน 00-08 ฉายา MT พาร์ทไทม์ เท่านั้น
            s3 = create_shift(
                "เวรดึก Micro", donor=0, xmatch=0, active_days=None,
                positions=[
                    {"name": "ดึก", "constraint_note": "00:00-08:00 พาร์ทไทม์", "slot_count": 1, "time_window_name": TW_NITE, "allowed_titles": [TITLE_PT]},
                ],
                conn=conn,
            )
            return s1

        if template_id == 3:
            name = name_override or f"กะเทมเพลต {template_id} (ยังไม่เสร็จ)"
            positions = [{"name": "ช่อง 1", "constraint_note": "", "regular_only": False}, {"name": "ช่อง 2", "constraint_note": "", "regular_only": False}]
            sid = create_shift(name, donor=0, xmatch=0, positions=positions, conn=conn)
            return sid
        if template_id == 4:
            # ตัวอย่าง infeasible: ต้องการ 2 คน/วัน แต่มีแค่ 1 คน → จัดเวรไม่ได้
            name = name_override or "กะตัวอย่าง (จัดไม่ได้)"
            positions = [
                {"name": "ช่อง A", "constraint_note": "", "regular_only": False, "slot_count": 1},
                {"name": "ช่อง B", "constraint_note": "", "regular_only": False, "slot_count": 1},
            ]
            sid = create_shift(name, donor=0, xmatch=0, positions=positions, conn=conn)
            return sid
        raise ValueError("template_id must be 1, 2, 3, or 4")
    finally:
        if close:
            conn.close()


def get_shift_list(conn=None):
    """โหลดรายการกะสำหรับ scheduler: มี positions หรือ donor/xmatch
    รวม active_days เพื่อให้ scheduler ใช้กรองวันที่กะนี้ทำงาน"""
    close = conn is None
    conn = conn or get_connection()
    try:
        rows = conn.execute("SELECT id, name, donor, xmatch, active_days, COALESCE(include_holidays,0) FROM shift ORDER BY id").fetchall()
        result = []
        for r in rows:
            sid, name, donor, xmatch = r[0], r[1], r[2], r[3]
            active_days = r[4] if len(r) > 4 else None
            include_holidays = bool(r[5]) if len(r) > 5 else False
            pos_rows = conn.execute(
                "SELECT name, regular_only, COALESCE(slot_count, 1), time_window_name, COALESCE(required_skill,''), COALESCE(min_skill_level,0), COALESCE(allowed_titles,'[]'), COALESCE(max_per_week,0) FROM shift_position WHERE shift_id = ? ORDER BY sort_order",
                (sid,),
            ).fetchall()
            if pos_rows:
                result.append({
                    "name": name,
                    "active_days": active_days,
                    "include_holidays": include_holidays,
                    "positions": [{"name": p[0], "regular_only": bool(p[1]), "slot_count": int(p[2]), "time_window_name": (p[3] if len(p) > 3 and p[3] else None) or "", "required_skill": p[4] or "", "min_skill_level": int(p[5] or 0), "allowed_titles": json.loads(p[6] or "[]"), "max_per_week": int(p[7] or 0)} for p in pos_rows],
                })
            else:
                result.append({
                    "name": name,
                    "active_days": active_days,
                    "include_holidays": include_holidays,
                    "donor": donor,
                    "xmatch": xmatch,
                    "positions": [{"name": "Donor", "regular_only": False}] * donor + [{"name": "Xmatch", "regular_only": False}] * xmatch,
                })
        return result
    finally:
        if close:
            conn.close()


def get_holiday_dates(conn=None):
    """วันหยุดราชการ (comma-separated YYYY-MM-DD) จาก settings"""
    close = conn is None
    conn = conn or get_connection()
    try:
        row = conn.execute("SELECT value FROM settings WHERE key = 'holiday_dates'").fetchone()
        return row[0] if row and row[0] else ""
    finally:
        if close:
            conn.close()


def set_holiday_dates(val, conn=None):
    close = conn is None
    conn = conn or get_connection()
    try:
        conn.execute("INSERT OR REPLACE INTO settings (key, value) VALUES ('holiday_dates', ?)", (str(val or ""),))
        conn.commit()
    finally:
        if close:
            conn.close()


def get_num_days(conn=None):
    """โหลดจำนวนวันจาก settings (ค่าเริ่มต้น 10)"""
    close = conn is None
    conn = conn or get_connection()
    try:
        row = conn.execute(
            "SELECT value FROM settings WHERE key = 'num_days'"
        ).fetchone()
        return int(row[0]) if row else 10
    finally:
        if close:
            conn.close()


def set_num_days(n, conn=None):
    """ตั้งจำนวนวัน (เช่น 7 หรือ 10)"""
    close = conn is None
    conn = conn or get_connection()
    try:
        conn.execute("INSERT OR REPLACE INTO settings (key, value) VALUES ('num_days', ?)", (str(n),))
        conn.commit()
    finally:
        if close:
            conn.close()


def get_schedule_start_date(conn=None):
    """วันเริ่มต้นตาราง (YYYY-MM-DD) หรือ None ถ้าไม่ตั้ง"""
    close = conn is None
    conn = conn or get_connection()
    try:
        row = conn.execute(
            "SELECT value FROM settings WHERE key = 'schedule_start_date'"
        ).fetchone()
        if not row or not row[0]:
            return None
        return row[0]
    finally:
        if close:
            conn.close()


def set_schedule_start_date(value, conn=None):
    """ตั้งวันเริ่มต้นตาราง (YYYY-MM-DD หรือ '' เพื่อล้าง)"""
    close = conn is None
    conn = conn or get_connection()
    try:
        conn.execute(
            "INSERT OR REPLACE INTO settings (key, value) VALUES ('schedule_start_date', ?)",
            (value or "",),
        )
        conn.commit()
    finally:
        if close:
            conn.close()


def save_schedule(num_days, slots, start_date=None, conn=None):
    """
    บันทึกผลตารางที่สร้างแล้ว
    slots: list of dicts [{"staff_name", "day", "shift_name", "room"} or {"staff_name", "day", "shift_name", "position", "time_window?"}, ...]
    start_date: YYYY-MM-DD หรือ None
    Returns: run_id (int)
    """
    close = conn is None
    conn = conn or get_connection()
    try:
        cur = conn.execute(
            "INSERT INTO schedule_run (num_days, start_date) VALUES (?, ?)",
            (num_days, start_date or None),
        )
        run_id = cur.lastrowid
        for s in slots:
            pos = s.get("position") or s.get("room") or "Donor"
            tw = s.get("time_window")
            slot_idx = s.get("slot_index", 0)
            conn.execute(
                "INSERT INTO schedule_slot (run_id, day, shift_name, position, slot_index, staff_name, time_window) VALUES (?, ?, ?, ?, ?, ?, ?)",
                (run_id, s["day"], s["shift_name"], pos, slot_idx, s["staff_name"], tw),
            )
        conn.commit()
        return run_id
    finally:
        if close:
            conn.close()


_DUMMY_WORKER = "_DUMMY_"


def _build_slot(r):
    """แปลง row (staff_name, day, shift_name, position, slot_index, time_window) เป็น dict"""
    s = {
        "staff_name": r[0],
        "day": r[1],
        "shift_name": r[2],
        "position": r[3],
        "room": r[3],
        "is_dummy": r[0] == _DUMMY_WORKER,
    }
    if len(r) > 4 and r[4] is not None:
        s["slot_index"] = r[4]
    if len(r) > 5 and r[5] is not None:
        s["time_window"] = r[5]
    return s


def get_latest_schedule(conn=None):
    """
    โหลดตารางล่าสุด
    Returns: None หรือ {"run_id", "created_at", "num_days", "start_date", "slots": [...]}
    """
    close = conn is None
    conn = conn or get_connection()
    try:
        row = conn.execute(
            "SELECT id, created_at, num_days, start_date FROM schedule_run ORDER BY id DESC LIMIT 1"
        ).fetchone()
        if not row:
            return None
        run_id, created_at, num_days = row[0], row[1], row[2]
        start_date = row[3] if len(row) > 3 else None
        rows = conn.execute(
            "SELECT staff_name, day, shift_name, position, slot_index, time_window FROM schedule_slot WHERE run_id = ? ORDER BY day, shift_name, position, slot_index",
            (run_id,),
        ).fetchall()
        slots = [_build_slot(r) for r in rows]
        return {"run_id": run_id, "created_at": created_at, "num_days": num_days, "start_date": start_date, "slots": slots}
    finally:
        if close:
            conn.close()


def get_schedule(run_id, conn=None):
    """โหลดตารางตาม run_id (เหมือน get_latest_schedule แต่ระบุ run)"""
    close = conn is None
    conn = conn or get_connection()
    try:
        row = conn.execute(
            "SELECT id, created_at, num_days, start_date FROM schedule_run WHERE id = ?",
            (run_id,),
        ).fetchone()
        if not row:
            return None
        rid, created_at, num_days = row[0], row[1], row[2]
        start_date = row[3] if len(row) > 3 else None
        rows = conn.execute(
            "SELECT staff_name, day, shift_name, position, slot_index, time_window FROM schedule_slot WHERE run_id = ? ORDER BY day, shift_name, position, slot_index",
            (rid,),
        ).fetchall()
        slots = [_build_slot(r) for r in rows]
        return {"run_id": rid, "created_at": created_at, "num_days": num_days, "start_date": start_date, "slots": slots}
    finally:
        if close:
            conn.close()


def update_slot_staff(run_id, day, shift_name, position, slot_index, new_staff_name, conn=None):
    """Manual override: เปลี่ยนชื่อ staff ใน slot ที่ระบุ (เช่น แทนที่ _DUMMY_ ด้วยคนจริง)"""
    close = conn is None
    conn = conn or get_connection()
    try:
        conn.execute(
            "UPDATE schedule_slot SET staff_name = ? WHERE run_id = ? AND day = ? AND shift_name = ? AND position = ? AND slot_index = ?",
            (new_staff_name, run_id, day, shift_name, position, slot_index),
        )
        conn.commit()
    finally:
        if close:
            conn.close()


def _default_shift_name_for_template(template_id: int) -> str:
    if template_id == 1:
        return "เวรเจาะเลือด"
    if template_id == 2:
        return None
    if template_id == 3:
        return f"กะเทมเพลต {template_id} (ยังไม่เสร็จ)"
    if template_id == 4:
        return "กะตัวอย่าง (จัดไม่ได้)"
    return ""


_TEMPLATE_2_SHIFT_NAMES = ["เวรเช้า Micro", "เวรบ่าย Micro", "เวรดึก Micro"]


def apply_template(template_id: int, conn=None):
    """
    Apply template: create shift(s) from template; for template 1 also seed staff from config.mt_list.
    If a shift with the default name already exists, it is removed first so the template can be re-applied.
    Returns list of created shift ids.
    """
    close = conn is None
    conn = conn or get_connection()
    try:
        shift_ids = []
        conn.execute("DELETE FROM schedule_slot")
        conn.execute("DELETE FROM schedule_run")
        conn.execute("DELETE FROM shift_position")
        conn.execute("DELETE FROM shift")
        conn.execute("DELETE FROM staff_pair")
        conn.execute("DELETE FROM staff_time_window")
        conn.execute("DELETE FROM staff_off_day_of_month")
        conn.execute("DELETE FROM staff_off_day")
        conn.execute("DELETE FROM staff_skill")
        conn.execute("DELETE FROM staff")
        conn.execute("DELETE FROM skill_level")
        conn.execute("DELETE FROM skill_catalog")
        conn.execute("DELETE FROM title_catalog")
        conn.execute("DELETE FROM time_window_catalog")
        conn.commit()
        sid = create_shift_from_template(template_id, conn=conn)
        shift_ids.append(sid)
        if template_id == 1:
            conn.execute("INSERT OR IGNORE INTO skill_catalog (name, level) VALUES (?, 1)", (TEMPLATE_1_PHLEBOTOMY_SKILL,))
            conn.commit()

            total_staff = len(TEMPLATE_1_STAFF_NAMES)
            tw_pool = []
            for tw_name, count in TEMPLATE_1_TW_DISTRIBUTION:
                tw_pool.extend([tw_name] * count)
            while len(tw_pool) < total_staff:
                tw_pool.append("06:30-08:30")
            tw_pool = tw_pool[:total_staff]

            lvl3_assigned = False
            lvl2_assigned = False
            seed_skill_levels = []
            for i, sname in enumerate(TEMPLATE_1_STAFF_NAMES):
                tw = tw_pool[i] if i < len(tw_pool) else "06:30-08:30"
                is_full_tw = tw == "06:30-12:00"
                if not lvl3_assigned and is_full_tw:
                    seed_skill_levels.append(3)
                    lvl3_assigned = True
                elif not lvl2_assigned and is_full_tw:
                    seed_skill_levels.append(2)
                    lvl2_assigned = True
                else:
                    seed_skill_levels.append(1)

            for i, sname in enumerate(TEMPLATE_1_STAFF_NAMES):
                tw = tw_pool[i] if i < len(tw_pool) else "06:30-08:30"
                skill_lvl = seed_skill_levels[i]
                create_staff(sname, title="เต็มเวลา", off_days=[], off_days_of_month=[], skills=[], time_windows=[tw], conn=conn)
                row = conn.execute("SELECT id FROM staff WHERE name = ?", (sname,)).fetchone()
                if row:
                    conn.execute("INSERT OR IGNORE INTO staff_skill (staff_id, skill, level) VALUES (?, ?, ?)", (row[0], TEMPLATE_1_PHLEBOTOMY_SKILL, skill_lvl))
            conn.commit()
        if template_id == 2:
            conn.execute("INSERT OR IGNORE INTO title_catalog (name, type) VALUES ('MT เต็มเวลา', 'fulltime')")
            conn.execute("INSERT OR IGNORE INTO title_catalog (name, type) VALUES ('MT พาร์ทไทม์', 'parttime')")
            conn.commit()
            TW_DAY  = "08:00-16:00"
            TW_AFT  = "16:00-20:00"
            TW_EVE  = "16:00-24:00"
            TW_NITE = "00:00-08:00"
            # 18 staff = 12 fulltime + 6 parttime
            # 10 normal fulltime (MT1-MT10), 4 normal parttime (PT1-PT4)
            # 4 special: แพนเค็ก, พุดดิ้ง, อาหลิวสุดหล่อ, โคล่า
            MICRO_STAFF = []
            for i in range(1, 11):
                MICRO_STAFF.append((f"MT{i}", "fulltime", "MT เต็มเวลา", [TW_DAY, TW_AFT, TW_EVE, TW_NITE], [], []))
            for i in range(1, 5):
                MICRO_STAFF.append((f"PT{i}", "parttime", "MT พาร์ทไทม์", [TW_AFT, TW_EVE, TW_NITE], [], []))
            # แพนเค็ก (fulltime): off dates 7-9
            MICRO_STAFF.append(("แพนเค็ก", "fulltime", "MT เต็มเวลา", [TW_DAY, TW_AFT, TW_EVE], [], list(range(7, 10))))
            # พุดดิ้ง (fulltime): 16:00-24:00 only, work dates 9,12,14,30 (off all other days)
            pudding_off = [d for d in range(1, 31) if d not in (9, 12, 14, 30)]
            MICRO_STAFF.append(("พุดดิ้ง", "fulltime", "MT เต็มเวลา", [TW_EVE], [], pudding_off))
            # อาหลิวสุดหล่อ (parttime): ดึกเท่านั้น, max 1/week ≈ 4/month, off Monday(0)+Saturday(5), off dates 22,23
            MICRO_STAFF.append(("อาหลิวสุดหล่อ", "parttime", "MT พาร์ทไทม์", [TW_NITE], [0, 5], [22, 23]))
            # โคล่า (fulltime): off dates 1-6, 15, 18
            MICRO_STAFF.append(("โคล่า", "fulltime", "MT เต็มเวลา", [TW_DAY, TW_AFT, TW_EVE, TW_NITE], [], [1,2,3,4,5,6,15,18]))
            for sname, stype, title, tws, off_days, off_month in MICRO_STAFF:
                cur = conn.execute("INSERT INTO staff (name, type, title) VALUES (?, ?, ?)", (sname, stype, title))
                staff_id = cur.lastrowid
                for tw in tws:
                    conn.execute("INSERT INTO staff_time_window (staff_id, time_window_name) VALUES (?, ?)", (staff_id, tw))
                for d in off_days:
                    conn.execute("INSERT OR IGNORE INTO staff_off_day (staff_id, day) VALUES (?, ?)", (staff_id, d))
                for dm in off_month:
                    conn.execute("INSERT OR IGNORE INTO staff_off_day_of_month (staff_id, day) VALUES (?, ?)", (staff_id, dm))
            # อาหลิวสุดหล่อ: min_gap_days=6 (ห่างกันอย่างน้อย 6 วัน ≈ 1 ดึก/สัปดาห์)
            row = conn.execute("SELECT id FROM staff WHERE name = 'อาหลิวสุดหล่อ'").fetchone()
            if row:
                conn.execute("UPDATE staff SET min_gap_days = 6 WHERE id = ?", (row[0],))
            conn.commit()
            # Set April 2026 schedule settings
            set_num_days(30, conn=conn)
            set_schedule_start_date("2026-04-01", conn=conn)
            set_holiday_dates("2026-04-06,2026-04-11,2026-04-12,2026-04-13,2026-04-14,2026-04-15", conn=conn)
            # Seed pair: MT2 depends_on MT1 (MT2 ทำงานได้เฉพาะวันที่ MT1 ทำงาน)
            mt1_row = conn.execute("SELECT id FROM staff WHERE name = 'MT1'").fetchone()
            mt2_row = conn.execute("SELECT id FROM staff WHERE name = 'MT2'").fetchone()
            if mt1_row and mt2_row:
                add_staff_pair(mt1_row[0], mt2_row[0], "depends_on", conn=conn)
        if template_id == 4:
            create_staff("ตัวอย่าง 1", title="เต็มเวลา", off_days=[], off_days_of_month=[], skills=[], conn=conn)
            conn.commit()
        return shift_ids
    finally:
        if close:
            conn.close()


def list_staff_pairs(conn=None):
    close = conn is None
    conn = conn or get_connection()
    try:
        rows = conn.execute("""
            SELECT sp.id, sp.staff_id_1, s1.name, sp.staff_id_2, s2.name, sp.pair_type
            FROM staff_pair sp
            JOIN staff s1 ON sp.staff_id_1 = s1.id
            JOIN staff s2 ON sp.staff_id_2 = s2.id
            ORDER BY sp.id
        """).fetchall()
        return [{"id": r[0], "staff_id_1": r[1], "name_1": r[2], "staff_id_2": r[3], "name_2": r[4], "pair_type": r[5]} for r in rows]
    finally:
        if close:
            conn.close()


def add_staff_pair(staff_id_1, staff_id_2, pair_type, conn=None):
    close = conn is None
    conn = conn or get_connection()
    try:
        conn.execute("INSERT INTO staff_pair (staff_id_1, staff_id_2, pair_type) VALUES (?, ?, ?)", (staff_id_1, staff_id_2, pair_type))
        conn.commit()
    finally:
        if close:
            conn.close()


def remove_staff_pair(pair_id, conn=None):
    close = conn is None
    conn = conn or get_connection()
    try:
        conn.execute("DELETE FROM staff_pair WHERE id = ?", (pair_id,))
        conn.commit()
    finally:
        if close:
            conn.close()


def export_all_data(conn=None):
    """Export ข้อมูลทั้งหมดเป็น dict สำหรับ JSON"""
    close = conn is None
    conn = conn or get_connection()
    try:
        settings = {}
        for r in conn.execute("SELECT key, value FROM settings").fetchall():
            settings[r[0]] = r[1]
        skills = list_skill_catalog(conn=conn)
        titles = [{"name": r[0], "type": r[1]} for r in conn.execute("SELECT name, type FROM title_catalog ORDER BY name").fetchall()]
        time_windows = [{"name": r[0], "start_time": r[1], "end_time": r[2]} for r in conn.execute("SELECT name, start_time, end_time FROM time_window_catalog ORDER BY start_time").fetchall()]
        staff = list_staff(conn=conn)
        shifts = list_shifts(conn=conn)
        pairs = list_staff_pairs(conn=conn)
        return {
            "settings": settings,
            "skills": skills,
            "titles": titles,
            "time_windows": time_windows,
            "staff": staff,
            "shifts": shifts,
            "pairs": pairs,
        }
    finally:
        if close:
            conn.close()


def import_all_data(data, conn=None):
    """Import ข้อมูลจาก dict (JSON) — ล้างข้อมูลเก่าทั้งหมดก่อน"""
    close = conn is None
    conn = conn or get_connection()
    try:
        clear_all(conn=conn)
        for k, v in (data.get("settings") or {}).items():
            conn.execute("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)", (k, str(v)))
        for s in (data.get("skills") or []):
            sname = s["name"] if isinstance(s, dict) else s
            conn.execute("INSERT OR IGNORE INTO skill_catalog (name) VALUES (?)", (sname,))
            if isinstance(s, dict) and s.get("levels"):
                set_skill_levels(sname, [l["label"] for l in s["levels"]], conn=conn)
        for t in (data.get("titles") or []):
            conn.execute("INSERT OR IGNORE INTO title_catalog (name, type) VALUES (?, ?)", (t["name"], t.get("type", "fulltime")))
        for tw in (data.get("time_windows") or []):
            conn.execute("INSERT OR IGNORE INTO time_window_catalog (name, start_time, end_time) VALUES (?, ?, ?)", (tw["name"], tw.get("start_time", ""), tw.get("end_time", "")))
        conn.commit()
        for st in (data.get("staff") or []):
            sid = create_staff(
                st["name"],
                off_days=st.get("off_days", []),
                skills=st.get("skills", []),
                title=st.get("title", ""),
                off_days_of_month=st.get("off_days_of_month", []),
                time_windows=st.get("time_windows", []),
                min_shifts_per_month=st.get("min_shifts_per_month"),
                max_shifts_per_month=st.get("max_shifts_per_month"),
                min_gap_days=st.get("min_gap_days"),
                conn=conn,
            )
            skill_levels = st.get("skill_levels") or {}
            for skill_name, lvl in skill_levels.items():
                conn.execute("UPDATE staff_skill SET level = ? WHERE staff_id = ? AND skill = ?", (lvl, sid, skill_name))
        conn.commit()
        for sh in (data.get("shifts") or []):
            create_shift(
                sh["name"],
                positions=sh.get("positions"),
                active_days=sh.get("active_days"),
                include_holidays=sh.get("include_holidays", False),
                conn=conn,
            )
        for p in (data.get("pairs") or []):
            s1 = conn.execute("SELECT id FROM staff WHERE name = ?", (p.get("name_1", ""),)).fetchone()
            s2 = conn.execute("SELECT id FROM staff WHERE name = ?", (p.get("name_2", ""),)).fetchone()
            if s1 and s2:
                add_staff_pair(s1[0], s2[0], p.get("pair_type", "together"), conn=conn)
        conn.commit()
    finally:
        if close:
            conn.close()


def clear_all(conn=None):
    """ล้างทั้งหมด: บุคลากร, กะ, ตารางที่รันไว้ — กลับเป็นหน้าว่าง"""
    close = conn is None
    conn = conn or get_connection()
    try:
        conn.execute("DELETE FROM schedule_slot")
        conn.execute("DELETE FROM schedule_run")
        conn.execute("DELETE FROM shift_position")
        conn.execute("DELETE FROM shift")
        conn.execute("DELETE FROM staff_pair")
        conn.execute("DELETE FROM staff_time_window")
        conn.execute("DELETE FROM staff_off_day_of_month")
        conn.execute("DELETE FROM staff_off_day")
        conn.execute("DELETE FROM staff_skill")
        conn.execute("DELETE FROM staff")
        conn.execute("DELETE FROM skill_level")
        conn.execute("DELETE FROM skill_catalog")
        conn.execute("DELETE FROM title_catalog")
        conn.execute("DELETE FROM time_window_catalog")
        conn.commit()
    finally:
        if close:
            conn.close()
