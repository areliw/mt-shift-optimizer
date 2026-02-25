# main.py — FastAPI entry for MT Shift Optimizer

import io
import csv
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
    get_latest_schedule,
    get_schedule,
    save_schedule,
    list_staff,
    list_shifts,
    create_staff,
    update_staff,
    delete_staff,
    create_shift,
    update_shift,
    delete_shift,
)
from scheduler import generate_schedule
from ortools.sat.python import cp_model

# Ensure DB and seed if empty
init_db()
if not get_shift_list():
    try:
        from database import seed_from_config
        seed_from_config()
    except Exception:
        pass

app = FastAPI(title="MT Shift Optimizer")

BASE_DIR = Path(__file__).resolve().parent
STATIC_DIR = BASE_DIR / "static"
if STATIC_DIR.exists():
    app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")


# --- Pydantic models ---
class StaffCreate(BaseModel):
    name: str
    type: str  # fulltime | parttime
    off_days: list[int] = []
    skills: list[str] = []  # donor, xmatch


class StaffUpdate(BaseModel):
    name: str
    type: str
    off_days: list[int] = []
    skills: list[str] = []


class ShiftCreate(BaseModel):
    name: str
    donor: int = 1
    xmatch: int = 1


class ShiftUpdate(BaseModel):
    name: str
    donor: int = 1
    xmatch: int = 1


class NumDaysUpdate(BaseModel):
    value: int


class SettingsUpdate(BaseModel):
    num_days: int | None = None
    schedule_start_date: str | None = None  # YYYY-MM-DD or "" to clear


class ScheduleRunBody(BaseModel):
    """Optional: use form values for this run and sync to DB."""
    num_days: int | None = None
    schedule_start_date: str | None = None


# --- API: Staff ---
@app.get("/api/staff")
def api_list_staff():
    return list_staff()


@app.post("/api/staff")
def api_create_staff(body: StaffCreate):
    sid = create_staff(body.name, body.type, body.off_days, body.skills)
    return {"id": sid, "name": body.name, "type": body.type, "off_days": body.off_days, "skills": body.skills}


@app.put("/api/staff/{staff_id:int}")
def api_update_staff(staff_id: int, body: StaffUpdate):
    update_staff(staff_id, body.name, body.type, body.off_days, body.skills)
    return {"id": staff_id, "name": body.name, "type": body.type, "off_days": body.off_days, "skills": body.skills}


@app.delete("/api/staff/{staff_id:int}")
def api_delete_staff(staff_id: int):
    delete_staff(staff_id)
    return {"ok": True}


# --- API: Shifts ---
@app.get("/api/shifts")
def api_list_shifts():
    return list_shifts()


@app.post("/api/shifts")
def api_create_shift(body: ShiftCreate):
    sid = create_shift(body.name, body.donor, body.xmatch)
    return {"id": sid, "name": body.name, "donor": body.donor, "xmatch": body.xmatch}


@app.put("/api/shifts/{shift_id:int}")
def api_update_shift(shift_id: int, body: ShiftUpdate):
    update_shift(shift_id, body.name, body.donor, body.xmatch)
    return {"id": shift_id, "name": body.name, "donor": body.donor, "xmatch": body.xmatch}


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
    shifts, rooms, solver, status = generate_schedule(num_days=num_days)
    if status not in (cp_model.OPTIMAL, cp_model.FEASIBLE):
        raise HTTPException(status_code=422, detail="No feasible schedule found.")
    slots = []
    for day in range(num_days):
        for shift in shift_list:
            for room in ("donor", "xmatch"):
                for mt in mt_list:
                    if solver.value(rooms[(mt["name"], day, shift["name"], room)]) == 1:
                        slots.append({
                            "staff_name": mt["name"],
                            "day": day,
                            "shift_name": shift["name"],
                            "room": room,
                        })
    start_date = get_schedule_start_date()
    run_id = save_schedule(num_days, slots, start_date=start_date)
    data = get_schedule(run_id)
    return {"run_id": run_id, "schedule": data}


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
    if start_date:
        w.writerow(["date", "day", "shift", "room", "staff_name"])
        try:
            base = datetime.strptime(start_date, "%Y-%m-%d").date()
            for s in data["slots"]:
                d = base + timedelta(days=s["day"])
                w.writerow([d.isoformat(), s["day"] + 1, s["shift_name"], s["room"], s["staff_name"]])
        except ValueError:
            w.writerow(["day", "shift", "room", "staff_name"])
            for s in data["slots"]:
                w.writerow([s["day"] + 1, s["shift_name"], s["room"], s["staff_name"]])
    else:
        w.writerow(["day", "shift", "room", "staff_name"])
        for s in data["slots"]:
            w.writerow([s["day"] + 1, s["shift_name"], s["room"], s["staff_name"]])
    content = buf.getvalue().encode("utf-8-sig")
    return Response(
        content=content,
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": "attachment; filename=schedule.csv"},
    )


# --- Frontend: serve index ---
@app.get("/", response_class=HTMLResponse)
def index():
    index_html = STATIC_DIR / "index.html"
    if index_html.exists():
        return FileResponse(index_html)
    return HTMLResponse("<h1>MT Shift Optimizer</h1><p>Add static/index.html for the UI.</p>")


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
