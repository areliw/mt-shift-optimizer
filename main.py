# main.py — FastAPI entry for MT Shift Optimizer

import io
import csv
import sqlite3
from pathlib import Path

from fastapi import Body, FastAPI, HTTPException, Query
from fastapi.responses import HTMLResponse, FileResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from database import (
    init_db,
    get_mt_list,
    get_shift_list,
    get_num_days,
    set_num_days,
    get_schedule_start_date,
    set_schedule_start_date,
    get_holiday_dates,
    set_holiday_dates,
    get_latest_schedule,
    get_schedule,
    save_schedule,
    update_slot_staff,
    list_staff,
    get_staff,
    list_shifts,
    create_staff,
    update_staff,
    delete_staff,
    list_skill_catalog,
    add_skill_catalog,
    remove_skill_catalog,
    rename_skill_catalog,
    get_skill_levels,
    set_skill_levels,
    list_title_catalog,
    add_title_catalog,
    remove_title_catalog,
    list_time_window_catalog,
    add_time_window_catalog,
    remove_time_window_catalog,
    create_shift,
    update_shift,
    delete_shift,
    create_shift_from_template,
    apply_template,
    clear_all,
    list_staff_pairs,
    add_staff_pair,
    remove_staff_pair,
    export_all_data,
    import_all_data,
)
from scheduler import generate_schedule, diagnose_infeasible, DUMMY_WORKER
from ortools.sat.python import cp_model

init_db()
clear_all()

app = FastAPI(title="MT Shift Optimizer")

BASE_DIR = Path(__file__).resolve().parent
STATIC_DIR = BASE_DIR / "static"
if STATIC_DIR.exists():
    app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")


# --- Pydantic models ---
class StaffCreate(BaseModel):
    name: str
    title: str = ""
    off_days: list[int] = []
    off_days_of_month: list[int] = []
    skills: list[str] = []
    time_windows: list[str] = []
    min_shifts_per_month: int | None = None
    max_shifts_per_month: int | None = None
    min_gap_days: int | None = None


class StaffUpdate(BaseModel):
    name: str
    title: str = ""
    off_days: list[int] = []
    off_days_of_month: list[int] = []
    skills: list[str] = []
    time_windows: list[str] = []
    skill_levels: dict[str, int] = {}
    min_shifts_per_month: int | None = None
    max_shifts_per_month: int | None = None
    min_gap_days: int | None = None


class PositionItem(BaseModel):
    name: str
    constraint_note: str | None = None
    regular_only: bool | None = None
    slot_count: int = 1  # จำนวนคน (เช่น ช่อง 1-10 = 10 คน)
    time_window_name: str | None = None  # ช่วงเวลาที่ช่องต้องการ เช่น 06:30-12:00
    required_skill: str | None = None  # ทักษะที่ต้องการ เช่น "เจาะเลือด"
    min_skill_level: int = 0  # ระดับ skill ขั้นต่ำ (0=ไม่กำหนด, 1=ต่ำ, 2=กลาง, 3=สูง)
    allowed_titles: list[str] = []  # ฉายาที่อนุญาต (ว่าง = ทุกฉายา)
    max_per_week: int = 0  # สูงสุดกี่ครั้ง/สัปดาห์ (0 = ไม่จำกัด)


class TimeWindowCreate(BaseModel):
    name: str  # เช่น 06:30-12:00 (หรือให้ระบบสร้างจาก start_time-end_time)
    start_time: str = ""  # HH:MM
    end_time: str = ""    # HH:MM


class SkillCreate(BaseModel):
    name: str


class TitleCreate(BaseModel):
    name: str
    type: str = "fulltime"  # fulltime | parttime


class ShiftCreate(BaseModel):
    name: str
    donor: int = 0
    xmatch: int = 0
    positions: list[PositionItem] | None = None
    active_days: str | None = None
    include_holidays: bool = False


class ShiftUpdate(BaseModel):
    name: str
    donor: int = 0
    xmatch: int = 0
    positions: list[PositionItem] | None = None
    active_days: str | None = None
    include_holidays: bool = False


class NumDaysUpdate(BaseModel):
    value: int


class SettingsUpdate(BaseModel):
    num_days: int | None = None
    schedule_start_date: str | None = None  # YYYY-MM-DD or "" to clear
    holiday_dates: str | None = None  # comma-separated YYYY-MM-DD


class StaffPairCreate(BaseModel):
    staff_id_1: int
    staff_id_2: int
    pair_type: str  # "together" or "apart"


class ScheduleRunBody(BaseModel):
    """Optional: use form values for this run and sync to DB."""
    num_days: int | None = None
    schedule_start_date: str | None = None


class SlotAssign(BaseModel):
    """Manual assignment: แทนที่ dummy slot ด้วย staff จริง"""
    day: int
    shift_name: str
    position: str
    slot_index: int = 0
    staff_name: str


# --- API: Staff ---
@app.get("/api/staff")
def api_list_staff():
    return list_staff()


@app.get("/api/staff/{staff_id:int}")
def api_get_staff(staff_id: int):
    staff = get_staff(staff_id)
    if staff is None:
        raise HTTPException(status_code=404, detail="Staff not found.")
    return staff


@app.get("/api/time-windows")
def api_list_time_windows():
    return list_time_window_catalog()


@app.post("/api/time-windows")
def api_add_time_window(body: TimeWindowCreate):
    name = (body.name or "").strip()
    start_time = (body.start_time or "").strip()
    end_time = (body.end_time or "").strip()
    if not name:
        raise HTTPException(status_code=400, detail="ชื่อช่วงเวลาต้องไม่ว่าง")
    if not start_time or not end_time:
        if "-" in name:
            parts = name.split("-", 1)
            start_time = start_time or (parts[0].strip() if parts else "")
            end_time = end_time or (parts[1].strip() if len(parts) > 1 else "")
        if not start_time or not end_time:
            raise HTTPException(status_code=400, detail="ระบุ start_time และ end_time (เช่น 06:30, 12:00) หรือใช้รูปแบบ 06:30-12:00 ใน name")
    add_time_window_catalog(name, start_time, end_time)
    return {"name": name, "start_time": start_time, "end_time": end_time}


@app.delete("/api/time-windows/{name:path}")
def api_remove_time_window(name: str):
    remove_time_window_catalog(name)
    return {"ok": True}


@app.post("/api/staff")
def api_create_staff(body: StaffCreate):
    try:
        sid = create_staff(body.name, body.off_days, body.skills, body.title, body.off_days_of_month, body.time_windows, min_shifts_per_month=body.min_shifts_per_month, max_shifts_per_month=body.max_shifts_per_month, min_gap_days=body.min_gap_days)
    except sqlite3.IntegrityError:
        raise HTTPException(status_code=409, detail=f"ชื่อ '{body.name}' มีอยู่แล้ว กรุณาใช้ชื่ออื่น")
    from database import get_title_type
    stype = get_title_type(body.title or "")
    return {"id": sid, "name": body.name, "type": stype, "title": body.title or "", "off_days": body.off_days, "skills": body.skills}


@app.put("/api/staff/{staff_id:int}")
def api_update_staff(staff_id: int, body: StaffUpdate):
    try:
        update_staff(staff_id, body.name, body.off_days, body.skills, body.title, body.off_days_of_month, body.time_windows, skill_levels=body.skill_levels, min_shifts_per_month=body.min_shifts_per_month, max_shifts_per_month=body.max_shifts_per_month, min_gap_days=body.min_gap_days)
    except sqlite3.IntegrityError:
        raise HTTPException(status_code=409, detail=f"ชื่อ '{body.name}' มีอยู่แล้ว กรุณาใช้ชื่ออื่น")
    from database import get_title_type
    stype = get_title_type(body.title or "")
    return {"id": staff_id, "name": body.name, "type": stype, "title": body.title or "", "off_days": body.off_days, "skills": body.skills}


@app.delete("/api/staff/{staff_id:int}")
def api_delete_staff(staff_id: int):
    delete_staff(staff_id)
    return {"ok": True}


# --- API: Skills (รายการทักษะสำหรับใส่ให้บุคลากร) ---
@app.get("/api/skills")
def api_list_skills():
    return list_skill_catalog()


@app.post("/api/skills")
def api_add_skill(body: SkillCreate):
    name = (body.name or "").strip()
    if not name:
        raise HTTPException(status_code=400, detail="ชื่อทักษะต้องไม่ว่าง")
    add_skill_catalog(name)
    return {"name": name}


@app.put("/api/skills/{old_name:path}")
def api_rename_skill(old_name: str, body: SkillCreate):
    old = (old_name or "").strip()
    new = (body.name or "").strip()
    if not new:
        raise HTTPException(status_code=400, detail="ชื่อทักษะต้องไม่ว่าง")
    if not old or old == new:
        return {"name": new}
    try:
        rename_skill_catalog(old, new)
    except Exception as exc:  # sqlite3.IntegrityError หรืออื่นๆ
        raise HTTPException(status_code=400, detail="ไม่สามารถเปลี่ยนชื่อทักษะได้ (อาจมีชื่อซ้ำ)") from exc
    return {"name": new}


@app.delete("/api/skills/{name:path}")
def api_remove_skill(name: str):
    remove_skill_catalog(name)
    return {"ok": True}


class SkillLevelsUpdate(BaseModel):
    levels: list[str]


@app.get("/api/skills/{name:path}/levels")
def api_get_skill_levels(name: str):
    return get_skill_levels(name)


@app.put("/api/skills/{name:path}/levels")
def api_set_skill_levels(name: str, body: SkillLevelsUpdate):
    labels = [l.strip() for l in body.levels if l.strip()]
    if not labels:
        raise HTTPException(status_code=400, detail="ต้องมีอย่างน้อย 1 ระดับ")
    set_skill_levels(name, labels)
    return get_skill_levels(name)


# --- API: Titles (ฉายา/ตำแหน่ง รวมประเภท) ---
@app.get("/api/titles")
def api_list_titles():
    return list_title_catalog()


@app.post("/api/titles")
def api_add_title(body: TitleCreate):
    name = (body.name or "").strip()
    if not name:
        raise HTTPException(status_code=400, detail="ชื่อฉายาต้องไม่ว่าง")
    stype = (body.type or "fulltime").lower()
    if stype not in ("fulltime", "parttime"):
        stype = "fulltime"
    add_title_catalog(name, stype)
    return {"name": name, "type": stype}


@app.delete("/api/titles/{name:path}")
def api_remove_title(name: str):
    remove_title_catalog(name)
    return {"ok": True}


# --- API: Shifts ---
@app.get("/api/shifts")
def api_list_shifts():
    return list_shifts()


@app.post("/api/shifts")
def api_create_shift(body: ShiftCreate):
    positions = None
    if body.positions is not None:
        positions = [{"name": p.name, "constraint_note": p.constraint_note or "", "regular_only": p.regular_only or False, "slot_count": max(1, p.slot_count or 1), "time_window_name": (p.time_window_name or "").strip() or None, "required_skill": (p.required_skill or "").strip() or None, "min_skill_level": max(0, int(p.min_skill_level or 0)), "allowed_titles": list(p.allowed_titles or []), "max_per_week": max(0, int(p.max_per_week or 0))} for p in body.positions]
    sid = create_shift(body.name, body.donor, body.xmatch, positions=positions, active_days=body.active_days, include_holidays=body.include_holidays)
    out = {"id": sid, "name": body.name}
    if positions is not None:
        out["positions"] = [{"name": p["name"], "constraint_note": p["constraint_note"], "regular_only": p["regular_only"], "slot_count": p.get("slot_count", 1)} for p in positions]
    else:
        out["donor"] = body.donor
        out["xmatch"] = body.xmatch
    return out


@app.post("/api/shifts/from-template")
def api_create_shift_from_template(template: int = Query(..., ge=1, le=4), name: str | None = Query(None)):
    sid = create_shift_from_template(template, name_override=name)
    shifts = list_shifts()
    created = next((s for s in shifts if s["id"] == sid), None)
    return {"id": sid, "shift": created}


@app.post("/api/apply-template")
def api_apply_template(template: int = Query(..., ge=1, le=4)):
    """Apply template: creates shift(s) and staff (for templates that seed staff)."""
    apply_template(template)
    staff = list_staff()
    all_shifts = list_shifts()
    return {
        "shift_ids": [s["id"] for s in all_shifts],
        "staff_loaded": len(staff) > 0,
        "staff_count": len(staff),
        "shift_count": len(all_shifts),
    }


@app.post("/api/clear-all")
def api_clear_all():
    """ล้างทั้งหมด: บุคลากร, กะ, ตาราง — กลับเป็นหน้าว่าง"""
    clear_all()
    return {"ok": True}


@app.put("/api/shifts/{shift_id:int}")
def api_update_shift(shift_id: int, body: ShiftUpdate):
    positions = None
    if body.positions is not None:
        positions = [{"name": p.name, "constraint_note": p.constraint_note or "", "regular_only": p.regular_only or False, "slot_count": max(1, p.slot_count or 1), "time_window_name": (p.time_window_name or "").strip() or None, "required_skill": (p.required_skill or "").strip() or None, "min_skill_level": max(0, int(p.min_skill_level or 0)), "allowed_titles": list(p.allowed_titles or []), "max_per_week": max(0, int(p.max_per_week or 0))} for p in body.positions]
    update_shift(shift_id, body.name, body.donor, body.xmatch, positions=positions, active_days=body.active_days, include_holidays=body.include_holidays)
    out = {"id": shift_id, "name": body.name}
    if positions is not None:
        out["positions"] = [{"name": p["name"], "constraint_note": p["constraint_note"], "regular_only": p["regular_only"], "slot_count": p.get("slot_count", 1)} for p in positions]
    else:
        out["donor"] = body.donor
        out["xmatch"] = body.xmatch
    return out


@app.delete("/api/shifts/{shift_id:int}")
def api_delete_shift(shift_id: int):
    delete_shift(shift_id)
    return {"ok": True}


# --- API: Settings ---
@app.get("/api/settings")
def api_get_settings():
    return {
        "num_days": get_num_days(),
        "schedule_start_date": get_schedule_start_date() or "",
        "holiday_dates": get_holiday_dates(),
    }


@app.get("/api/settings/num_days")
def api_get_num_days():
    return {"value": get_num_days()}


@app.put("/api/settings/num_days")
def api_set_num_days(body: NumDaysUpdate):
    set_num_days(body.value)
    return {"value": body.value}


@app.put("/api/settings")
def api_set_settings(body: SettingsUpdate):
    if body.num_days is not None:
        set_num_days(body.num_days)
    if body.schedule_start_date is not None:
        set_schedule_start_date(body.schedule_start_date.strip() or "")
    if body.holiday_dates is not None:
        set_holiday_dates(body.holiday_dates.strip())
    return api_get_settings()


# --- API: Schedule (run + get) ---
@app.post("/api/schedule/run")
def api_run_schedule(
    body: ScheduleRunBody | None = Body(None),
    num_days_q: int | None = Query(None, alias="num_days"),
    schedule_start_date_q: str | None = Query(None, alias="schedule_start_date"),
):
    num_days_val = (body.num_days if body is not None and body.num_days is not None else None) or num_days_q
    start_val = (body.schedule_start_date.strip() if body and body.schedule_start_date and body.schedule_start_date.strip() else None) or (schedule_start_date_q.strip() if schedule_start_date_q and schedule_start_date_q.strip() else None)
    if num_days_val is not None:
        set_num_days(num_days_val)
    if start_val is not None:
        set_schedule_start_date(start_val)
    num_days = num_days_val or get_num_days()
    mt_list = get_mt_list()
    shift_list = get_shift_list()
    if not mt_list:
        raise HTTPException(status_code=400, detail="No staff. Add at least one staff.")
    if not shift_list:
        raise HTTPException(status_code=400, detail="No shifts. Add at least one shift.")
    start_date_str = get_schedule_start_date()
    slots, solver, status = generate_schedule(num_days=num_days, start_date_str=start_date_str or None)

    # กรณี solver fail จริงๆ (MODEL_INVALID ฯลฯ) — ไม่ใช่แค่ infeasible
    if status not in (cp_model.OPTIMAL, cp_model.FEASIBLE):
        reasons = diagnose_infeasible(mt_list, shift_list, num_days, start_date_str)
        raise HTTPException(
            status_code=422,
            detail={"message": "Solver could not find any solution.", "reasons": reasons},
        )

    start_date = get_schedule_start_date()
    run_id = save_schedule(num_days, slots, start_date=start_date)
    data = get_schedule(run_id)

    # ถ้ามี dummy slots → แจ้งเตือน + วิเคราะห์สาเหตุ
    dummy_slots = [s for s in slots if s.get("is_dummy")]
    result = {"run_id": run_id, "schedule": data}
    if dummy_slots:
        hints = diagnose_infeasible(mt_list, shift_list, num_days, start_date_str)
        result["has_dummy"] = True
        result["dummy_count"] = len(dummy_slots)
        result["infeasibility_hints"] = hints
    else:
        result["has_dummy"] = False
        result["dummy_count"] = 0
    return result


@app.get("/api/schedule/latest")
def api_get_latest_schedule():
    data = get_latest_schedule()
    if data is None:
        raise HTTPException(status_code=404, detail="No schedule yet. Run the scheduler first.")
    return data


@app.get("/api/schedule/{run_id:int}")
def api_get_schedule(run_id: int):
    data = get_schedule(run_id)
    if data is None:
        raise HTTPException(status_code=404, detail="Schedule not found.")
    return data


# --- Export CSV ---
@app.get("/api/schedule/export/csv")
def api_export_schedule_csv(run_id: int | None = None):
    from datetime import datetime, timedelta
    if run_id is not None:
        data = get_schedule(run_id)
    else:
        data = get_latest_schedule()
    if data is None:
        raise HTTPException(status_code=404, detail="No schedule to export.")
    buf = io.StringIO()
    w = csv.writer(buf)
    start_date = data.get("start_date")
    pos_key = "position" if data["slots"] and "position" in data["slots"][0] else "room"
    has_tw = data["slots"] and data["slots"][0].get("time_window")
    header = ["date", "day", "shift", "position", "staff_name"] if not has_tw else ["date", "day", "shift", "position", "time_window", "staff_name"]
    if start_date:
        w.writerow(header)
        try:
            base = datetime.strptime(start_date, "%Y-%m-%d").date()
            for s in data["slots"]:
                d = base + timedelta(days=s["day"])
                row = [d.isoformat(), s["day"] + 1, s["shift_name"], s.get(pos_key, s.get("room", "")), s["staff_name"]]
                if has_tw:
                    row.insert(4, s.get("time_window", ""))
                w.writerow(row)
        except ValueError:
            w.writerow([h for h in header if h != "date"])
            for s in data["slots"]:
                row = [s["day"] + 1, s["shift_name"], s.get(pos_key, s.get("room", "")), s["staff_name"]]
                if has_tw:
                    row.insert(3, s.get("time_window", ""))
                w.writerow(row)
    else:
        w.writerow([h for h in header if h != "date"])
        for s in data["slots"]:
            row = [s["day"] + 1, s["shift_name"], s.get(pos_key, s.get("room", "")), s["staff_name"]]
            if has_tw:
                row.insert(3, s.get("time_window", ""))
            w.writerow(row)
    content = buf.getvalue().encode("utf-8-sig")
    return Response(
        content=content,
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": "attachment; filename=schedule.csv"},
    )


# --- Manual Slot Assignment ---
@app.patch("/api/schedule/{run_id:int}/slot")
def api_assign_slot(run_id: int, body: SlotAssign):
    """Manual override: กำหนด staff ให้ slot ที่ระบุ (ใช้แทน dummy หรือสลับคน)"""
    data = get_schedule(run_id)
    if data is None:
        raise HTTPException(status_code=404, detail="Schedule not found.")
    name = body.staff_name.strip()
    if not name:
        raise HTTPException(status_code=400, detail="staff_name ต้องไม่ว่าง")
    update_slot_staff(run_id, body.day, body.shift_name, body.position, body.slot_index, name)
    updated = get_schedule(run_id)
    return {"ok": True, "run_id": run_id, "schedule": updated}


# --- API: Staff Pairs ---
@app.get("/api/staff-pairs")
def api_list_staff_pairs():
    return list_staff_pairs()


@app.post("/api/staff-pairs")
def api_add_staff_pair(body: StaffPairCreate):
    if body.staff_id_1 == body.staff_id_2:
        raise HTTPException(status_code=400, detail="ต้องเลือกคนละคน")
    if body.pair_type not in ("together", "apart", "depends_on"):
        raise HTTPException(status_code=400, detail="pair_type ต้องเป็น 'together', 'apart' หรือ 'depends_on'")
    add_staff_pair(body.staff_id_1, body.staff_id_2, body.pair_type)
    return {"ok": True}


@app.delete("/api/staff-pairs/{pair_id:int}")
def api_remove_staff_pair(pair_id: int):
    remove_staff_pair(pair_id)
    return {"ok": True}


# --- API: Import/Export ---
@app.get("/api/export")
def api_export():
    return export_all_data()


@app.post("/api/import")
def api_import(data: dict = Body(...)):
    import_all_data(data)
    return {"ok": True}


# --- Frontend: serve index ---
@app.get("/staff", response_class=HTMLResponse)
def staff_page():
    """หน้ารายละเอียดบุคลากร (ใช้ query ?id=...)"""
    staff_html = STATIC_DIR / "staff.html"
    if staff_html.exists():
        return FileResponse(staff_html)
    return HTMLResponse("<h1>Staff</h1><p>Add static/staff.html for the staff detail page.</p>")


@app.get("/", response_class=HTMLResponse)
def index():
    index_html = STATIC_DIR / "index.html"
    if index_html.exists():
        return FileResponse(index_html)
    return HTMLResponse("<h1>MT Shift Optimizer</h1><p>Add static/index.html for the UI.</p>")


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
