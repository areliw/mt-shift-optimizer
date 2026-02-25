# database.py — แยกข้อมูล staff / กะ / settings ไว้ใน SQLite

import sqlite3
from pathlib import Path

DB_PATH = Path(__file__).resolve().parent / "shift_optimizer.db"
ROOMS = ("donor", "xmatch")


def _migrate_shifts_to_positions(conn):
    """One-time: for shifts with no shift_position rows, create Donor/Xmatch positions from donor/xmatch."""
    for row in conn.execute("SELECT id, name, donor, xmatch FROM shift").fetchall():
        sid, name, donor, xmatch = row
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
    finally:
        if close:
            conn.close()


def get_mt_list(conn=None):
    """โหลดรายชื่อ MT ในรูปแบบเดียวกับ config (สำหรับ scheduler)"""
    close = conn is None
    conn = conn or get_connection()
    try:
        rows = conn.execute(
            "SELECT id, name, type FROM staff ORDER BY id"
        ).fetchall()
        mt_list = []
        for sid, name, stype in rows:
            off_days = [
                r[0] for r in conn.execute(
                    "SELECT day FROM staff_off_day WHERE staff_id = ? ORDER BY day",
                    (sid,)
                ).fetchall()
            ]
            skills = [
                r[0] for r in conn.execute(
                    "SELECT skill FROM staff_skill WHERE staff_id = ? ORDER BY skill",
                    (sid,)
                ).fetchall()
            ]
            mt_list.append({
                "name": name,
                "type": stype,
                "off_days": off_days,
                "skills": skills,
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
        rows = conn.execute("SELECT id, name, type FROM staff ORDER BY id").fetchall()
        result = []
        for sid, name, stype in rows:
            off_days = [r[0] for r in conn.execute("SELECT day FROM staff_off_day WHERE staff_id = ? ORDER BY day", (sid,)).fetchall()]
            skills = [r[0] for r in conn.execute("SELECT skill FROM staff_skill WHERE staff_id = ? ORDER BY skill", (sid,)).fetchall()]
            result.append({"id": sid, "name": name, "type": stype, "off_days": off_days, "skills": skills})
        return result
    finally:
        if close:
            conn.close()


def get_staff(staff_id: int, conn=None):
    """โหลดบุคลากรหนึ่งคนตาม id คืน None ถ้าไม่พบ"""
    close = conn is None
    conn = conn or get_connection()
    try:
        row = conn.execute("SELECT id, name, type FROM staff WHERE id = ?", (staff_id,)).fetchone()
        if not row:
            return None
        sid, name, stype = row
        off_days = [r[0] for r in conn.execute("SELECT day FROM staff_off_day WHERE staff_id = ? ORDER BY day", (sid,)).fetchall()]
        skills = [r[0] for r in conn.execute("SELECT skill FROM staff_skill WHERE staff_id = ? ORDER BY skill", (sid,)).fetchall()]
        return {"id": sid, "name": name, "type": stype, "off_days": off_days, "skills": skills}
    finally:
        if close:
            conn.close()


def create_staff(name, stype, off_days=None, skills=None, conn=None):
    off_days = off_days or []
    skills = skills or []
    close = conn is None
    conn = conn or get_connection()
    try:
        cur = conn.execute("INSERT INTO staff (name, type) VALUES (?, ?)", (name, stype))
        sid = cur.lastrowid
        for d in off_days:
            conn.execute("INSERT INTO staff_off_day (staff_id, day) VALUES (?, ?)", (sid, d))
        for s in skills:
            conn.execute("INSERT INTO staff_skill (staff_id, skill) VALUES (?, ?)", (sid, s))
        conn.commit()
        return sid
    finally:
        if close:
            conn.close()


def update_staff(sid, name, stype, off_days=None, skills=None, conn=None):
    off_days = off_days or []
    skills = skills or []
    close = conn is None
    conn = conn or get_connection()
    try:
        conn.execute("UPDATE staff SET name = ?, type = ? WHERE id = ?", (name, stype, sid))
        conn.execute("DELETE FROM staff_off_day WHERE staff_id = ?", (sid,))
        conn.execute("DELETE FROM staff_skill WHERE staff_id = ?", (sid,))
        for d in off_days:
            conn.execute("INSERT INTO staff_off_day (staff_id, day) VALUES (?, ?)", (sid, d))
        for s in skills:
            conn.execute("INSERT INTO staff_skill (staff_id, skill) VALUES (?, ?)", (sid, s))
        conn.commit()
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
        rows = conn.execute("SELECT id, name, donor, xmatch, active_days FROM shift ORDER BY id").fetchall()
        result = []
        for r in rows:
            sid, name, donor, xmatch = r[0], r[1], r[2], r[3]
            active_days = r[4] if len(r) > 4 else None
            pos_rows = conn.execute(
                "SELECT name, constraint_note, regular_only FROM shift_position WHERE shift_id = ? ORDER BY sort_order",
                (sid,),
            ).fetchall()
            if pos_rows:
                positions = [
                    {"name": p[0], "constraint_note": p[1] or "", "regular_only": bool(p[2])}
                    for p in pos_rows
                ]
                result.append({"id": sid, "name": name, "positions": positions, "active_days": active_days})
            else:
                result.append({
                    "id": sid,
                    "name": name,
                    "donor": donor,
                    "xmatch": xmatch,
                    "positions": [{"name": "Donor", "constraint_note": "", "regular_only": False}] * donor
                    + [{"name": "Xmatch", "constraint_note": "", "regular_only": False}] * xmatch,
                    "active_days": active_days,
                })
        return result
    finally:
        if close:
            conn.close()


def create_shift(name, donor=1, xmatch=1, positions=None, active_days=None, conn=None):
    close = conn is None
    conn = conn or get_connection()
    try:
        cur = conn.execute("INSERT INTO shift (name, donor, xmatch, active_days) VALUES (?, ?, ?, ?)", (name, donor, xmatch, active_days or None))
        sid = cur.lastrowid
        if positions:
            for i, p in enumerate(positions):
                nm = p.get("name", "")
                note = p.get("constraint_note") or ""
                reg = 1 if p.get("regular_only") else 0
                conn.execute(
                    "INSERT INTO shift_position (shift_id, name, sort_order, constraint_note, regular_only) VALUES (?, ?, ?, ?, ?)",
                    (sid, nm, i, note, reg),
                )
        conn.commit()
        return sid
    finally:
        if close:
            conn.close()


def update_shift(sid, name, donor=1, xmatch=1, positions=None, active_days=None, conn=None):
    close = conn is None
    conn = conn or get_connection()
    try:
        conn.execute("UPDATE shift SET name = ?, donor = ?, xmatch = ?, active_days = ? WHERE id = ?", (name, donor, xmatch, active_days or None, sid))
        conn.execute("DELETE FROM shift_position WHERE shift_id = ?", (sid,))
        if positions:
            for i, p in enumerate(positions):
                nm = p.get("name", "")
                note = p.get("constraint_note") or ""
                reg = 1 if p.get("regular_only") else 0
                conn.execute(
                    "INSERT INTO shift_position (shift_id, name, sort_order, constraint_note, regular_only) VALUES (?, ?, ?, ?, ?)",
                    (sid, nm, i, note, reg),
                )
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


def create_shift_from_template(template_id: int, name_override: str | None = None, conn=None):
    """Create a shift from template 1, 2, or 3. Returns new shift id."""
    close = conn is None
    conn = conn or get_connection()
    try:
        if template_id == 1:
            name = name_override or "เวรเจาะเลือด"
            positions = [{"name": "รถเข็น", "constraint_note": "", "regular_only": False}]
            for i in range(1, 11):
                positions.append({"name": f"ช่อง {i}", "constraint_note": "", "regular_only": False})
            sid = create_shift(name, donor=0, xmatch=0, positions=positions, conn=conn)
            return sid
        if template_id in (2, 3):
            name = name_override or f"กะเทมเพลต {template_id}"
            positions = [{"name": "ช่อง 1", "constraint_note": "", "regular_only": False}, {"name": "ช่อง 2", "constraint_note": "", "regular_only": False}]
            sid = create_shift(name, donor=0, xmatch=0, positions=positions, conn=conn)
            return sid
        raise ValueError("template_id must be 1, 2, or 3")
    finally:
        if close:
            conn.close()


def get_shift_list(conn=None):
    """โหลดรายการกะสำหรับ scheduler: มี positions หรือ donor/xmatch"""
    close = conn is None
    conn = conn or get_connection()
    try:
        rows = conn.execute("SELECT id, name, donor, xmatch FROM shift ORDER BY id").fetchall()
        result = []
        for r in rows:
            sid, name, donor, xmatch = r[0], r[1], r[2], r[3]
            pos_rows = conn.execute(
                "SELECT name, regular_only FROM shift_position WHERE shift_id = ? ORDER BY sort_order",
                (sid,),
            ).fetchall()
            if pos_rows:
                result.append({
                    "name": name,
                    "positions": [{"name": p[0], "regular_only": bool(p[1])} for p in pos_rows],
                })
            else:
                result.append({
                    "name": name,
                    "donor": donor,
                    "xmatch": xmatch,
                    "positions": [{"name": "Donor", "regular_only": False}] * donor + [{"name": "Xmatch", "regular_only": False}] * xmatch,
                })
        return result
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
            conn.execute(
                "INSERT INTO schedule_slot (run_id, day, shift_name, position, staff_name, time_window) VALUES (?, ?, ?, ?, ?, ?)",
                (run_id, s["day"], s["shift_name"], pos, s["staff_name"], tw),
            )
        conn.commit()
        return run_id
    finally:
        if close:
            conn.close()


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
            "SELECT staff_name, day, shift_name, position, time_window FROM schedule_slot WHERE run_id = ? ORDER BY day, shift_name, position",
            (run_id,),
        ).fetchall()
        slots = []
        for r in rows:
            s = {"staff_name": r[0], "day": r[1], "shift_name": r[2], "position": r[3], "room": r[3]}
            if len(r) > 4 and r[4] is not None:
                s["time_window"] = r[4]
            slots.append(s)
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
            "SELECT staff_name, day, shift_name, position, time_window FROM schedule_slot WHERE run_id = ? ORDER BY day, shift_name, position",
            (rid,),
        ).fetchall()
        slots = []
        for r in rows:
            s = {"staff_name": r[0], "day": r[1], "shift_name": r[2], "position": r[3], "room": r[3]}
            if len(r) > 4 and r[4] is not None:
                s["time_window"] = r[4]
            slots.append(s)
        return {"run_id": rid, "created_at": created_at, "num_days": num_days, "start_date": start_date, "slots": slots}
    finally:
        if close:
            conn.close()


def seed_from_config():
    """ย้ายข้อมูลจาก config.py เข้า DB (รันครั้งเดียวหลังแยก DB)"""
    import config
    conn = get_connection()
    try:
        init_db(conn)
        conn.execute("INSERT OR REPLACE INTO settings (key, value) VALUES ('num_days', ?)", (str(config.num_days),))
        conn.execute("DELETE FROM shift")
        for s in config.shift_list:
            conn.execute("INSERT INTO shift (name, donor, xmatch) VALUES (?, ?, ?)", (s["name"], s["donor"], s["xmatch"]))
        conn.execute("DELETE FROM staff_off_day")
        conn.execute("DELETE FROM staff_skill")
        conn.execute("DELETE FROM staff")
        for mt in config.mt_list:
            cur = conn.execute("INSERT INTO staff (name, type) VALUES (?, ?)", (mt["name"], mt["type"]))
            sid = cur.lastrowid
            for day in mt["off_days"]:
                conn.execute("INSERT INTO staff_off_day (staff_id, day) VALUES (?, ?)", (sid, day))
            for skill in mt["skills"]:
                conn.execute("INSERT INTO staff_skill (staff_id, skill) VALUES (?, ?)", (sid, skill))
        conn.commit()
    finally:
        conn.close()


def _default_shift_name_for_template(template_id: int) -> str:
    if template_id == 1:
        return "เวรเจาะเลือด"
    if template_id in (2, 3):
        return f"กะเทมเพลต {template_id}"
    return ""


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
        default_name = _default_shift_name_for_template(template_id)
        if default_name:
            conn.execute("DELETE FROM shift_position WHERE shift_id IN (SELECT id FROM shift WHERE name = ?)", (default_name,))
            conn.execute("DELETE FROM shift WHERE name = ?", (default_name,))
            conn.commit()
        sid = create_shift_from_template(template_id, conn=conn)
        shift_ids.append(sid)
        if template_id == 1:
            import config
            conn.execute("DELETE FROM staff_off_day")
            conn.execute("DELETE FROM staff_skill")
            conn.execute("DELETE FROM staff")
            for mt in config.mt_list:
                cur = conn.execute("INSERT INTO staff (name, type) VALUES (?, ?)", (mt["name"], mt["type"]))
                sid = cur.lastrowid
                for day in mt["off_days"]:
                    conn.execute("INSERT INTO staff_off_day (staff_id, day) VALUES (?, ?)", (sid, day))
                for skill in mt["skills"]:
                    conn.execute("INSERT INTO staff_skill (staff_id, skill) VALUES (?, ?)", (sid, skill))
            conn.commit()
        return shift_ids
    finally:
        if close:
            conn.close()
