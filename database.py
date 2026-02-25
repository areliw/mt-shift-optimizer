# database.py — แยกข้อมูล staff / กะ / settings ไว้ใน SQLite

import sqlite3
from pathlib import Path

DB_PATH = Path(__file__).resolve().parent / "shift_optimizer.db"
ROOMS = ("donor", "xmatch")


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
                staff_name TEXT NOT NULL,
                day INTEGER NOT NULL,
                shift_name TEXT NOT NULL,
                room TEXT NOT NULL CHECK (room IN ('donor', 'xmatch')),
                PRIMARY KEY (run_id, staff_name, day, shift_name, room)
            );
        """)
        conn.commit()
        try:
            conn.execute("ALTER TABLE schedule_run ADD COLUMN start_date TEXT")
            conn.commit()
        except sqlite3.OperationalError:
            pass
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
    """โหลดกะพร้อม id สำหรับ API"""
    close = conn is None
    conn = conn or get_connection()
    try:
        rows = conn.execute("SELECT id, name, donor, xmatch FROM shift ORDER BY id").fetchall()
        return [{"id": r[0], "name": r[1], "donor": r[2], "xmatch": r[3]} for r in rows]
    finally:
        if close:
            conn.close()


def create_shift(name, donor=1, xmatch=1, conn=None):
    close = conn is None
    conn = conn or get_connection()
    try:
        cur = conn.execute("INSERT INTO shift (name, donor, xmatch) VALUES (?, ?, ?)", (name, donor, xmatch))
        conn.commit()
        return cur.lastrowid
    finally:
        if close:
            conn.close()


def update_shift(sid, name, donor=1, xmatch=1, conn=None):
    close = conn is None
    conn = conn or get_connection()
    try:
        conn.execute("UPDATE shift SET name = ?, donor = ?, xmatch = ? WHERE id = ?", (name, donor, xmatch, sid))
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


def get_shift_list(conn=None):
    """โหลดรายการกะในรูปแบบเดียวกับ config"""
    close = conn is None
    conn = conn or get_connection()
    try:
        rows = conn.execute(
            "SELECT name, donor, xmatch FROM shift ORDER BY id"
        ).fetchall()
        return [
            {"name": name, "donor": donor, "xmatch": xmatch}
            for name, donor, xmatch in rows
        ]
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
    slots: list of dicts [{"staff_name": str, "day": int, "shift_name": str, "room": str}, ...]
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
            conn.execute(
                "INSERT INTO schedule_slot (run_id, staff_name, day, shift_name, room) VALUES (?, ?, ?, ?, ?)",
                (run_id, s["staff_name"], s["day"], s["shift_name"], s["room"])
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
        slots = [
            {"staff_name": r[0], "day": r[1], "shift_name": r[2], "room": r[3]}
            for r in conn.execute(
                "SELECT staff_name, day, shift_name, room FROM schedule_slot WHERE run_id = ? ORDER BY day, shift_name, room",
                (run_id,)
            ).fetchall()
        ]
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
            (run_id,)
        ).fetchone()
        if not row:
            return None
        rid, created_at, num_days = row[0], row[1], row[2]
        start_date = row[3] if len(row) > 3 else None
        slots = [
            {"staff_name": r[0], "day": r[1], "shift_name": r[2], "room": r[3]}
            for r in conn.execute(
                "SELECT staff_name, day, shift_name, room FROM schedule_slot WHERE run_id = ? ORDER BY day, shift_name, room",
                (run_id,)
            ).fetchall()
        ]
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
