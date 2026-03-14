# main.py —- FastAPI entry for MT Shift Optimizer

import collections
import base64
import io
import csv
import hashlib
import hmac
import json
import logging
import os
import re as _re
import secrets
import sqlite3
import time
from pathlib import Path

from fastapi import Body, Depends, FastAPI, Header, HTTPException, Query, APIRouter, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse, FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, field_validator

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s %(message)s",
)
logger = logging.getLogger("mt_shift_optimizer")

from database import (
    init_master_db,
    create_workspace,
    delete_workspace,
    get_workspace,
    list_workspaces,
    set_workspace_context,
    update_workspace_access_mode,
    verify_workspace_token,
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
    swap_slots,
)
from scheduler import generate_schedule, diagnose_infeasible, DUMMY_WORKER
from ortools.sat.python import cp_model
from datetime import datetime, timedelta


def _check_staff_off_day_warnings(staff_name: str, day: int) -> list[str]:
    """เช็คว่าคนนี้หยุดวันนี้ไหม คืน list ของ warning (ว่าง = ไม่มีปัญหา)"""
    warnings = []
    # หา staff จาก mt_list by name
    mt_list = get_mt_list()
    mt = next((m for m in mt_list if m["name"] == staff_name), None)
    if not mt:
        return warnings
    start_str = get_schedule_start_date()
    if not start_str:
        return warnings
    try:
        start_date = datetime.strptime(start_str.strip()[:10], "%Y-%m-%d").date()
    except (ValueError, TypeError):
        return warnings
    cal_date = start_date + timedelta(days=day)
    # เช็ค off_days (weekday)
    off_weekdays = set(mt.get("off_days") or [])
    if cal_date.weekday() in off_weekdays:
        day_names = ["จันทร์", "อังคาร", "พุธ", "พฤหัสบดี", "ศุกร์", "เสาร์", "อาทิตย์"]
        warnings.append(f"'{staff_name}' ตั้งหยุดทุกวัน{day_names[cal_date.weekday()]} แต่วันที่ {cal_date.isoformat()} เป็นวัน{day_names[cal_date.weekday()]}")
    # เช็ค off_days_of_month
    off_month = mt.get("off_days_of_month") or []
    if cal_date.day in off_month:
        warnings.append(f"'{staff_name}' ตั้งหยุดวันที่ {cal_date.day} ของเดือน แต่ถูกจัดลงวันที่ {cal_date.isoformat()}")
    return warnings

# Initialize master DB (workspace registry) + migrate old data
init_master_db()

app = FastAPI(title="MT Shift Optimizer")


def _is_truthy(val: str | None) -> bool:
    return (val or "").strip().lower() in ("1", "true", "yes", "on")


def _is_production_env() -> bool:
    """Best-effort production detection with explicit override support."""
    app_env = (os.environ.get("APP_ENV") or os.environ.get("ENV") or "").strip().lower()
    if app_env in ("prod", "production"):
        return True
    if app_env in ("dev", "development", "local", "test", "testing"):
        return False
    if _is_truthy(os.environ.get("FORCE_PRODUCTION")):
        return True
    # Heuristics for hosted environments
    return bool(
        os.environ.get("RAILWAY_ENVIRONMENT")
        or os.environ.get("RAILWAY_PROJECT_ID")
        or os.environ.get("RENDER")
        or os.environ.get("FLY_APP_NAME")
    )


_IS_PRODUCTION = _is_production_env()


# ---------------------------------------------------------------------------
# API Key authentication
# Set API_KEY env var to enable.  All /api/* and /w/* routes require the key.
# In production, API_KEY is mandatory (fail fast).
# Clients must send:  X-API-Key: <key>
# ---------------------------------------------------------------------------
_API_KEY = os.environ.get("API_KEY", "").strip()
if _IS_PRODUCTION and not _API_KEY:
    raise RuntimeError("API_KEY is required in production environment")
if not _API_KEY:
    logger.warning(
        "API_KEY env var is not set — all endpoints are publicly accessible. "
        "Set API_KEY before deploying to production."
    )

# ---------------------------------------------------------------------------
# CORS — configure allowed origins via ALLOWED_ORIGINS env var
# (comma-separated, e.g. "https://app.example.com,https://admin.example.com")
# Defaults to localhost origins in dev; must be explicit in production.
# ---------------------------------------------------------------------------
_raw_origins = os.environ.get("ALLOWED_ORIGINS", "").strip()
if _raw_origins:
    _ALLOWED_ORIGINS = [o.strip() for o in _raw_origins.split(",") if o.strip()]
else:
    if _IS_PRODUCTION:
        raise RuntimeError("ALLOWED_ORIGINS is required in production environment")
    _ALLOWED_ORIGINS = [
        "http://localhost",
        "http://127.0.0.1",
        "http://localhost:3000",
        "http://127.0.0.1:3000",
        "http://localhost:5173",
        "http://127.0.0.1:5173",
        "http://localhost:8000",
        "http://127.0.0.1:8000",
    ]
    logger.info("ALLOWED_ORIGINS not set; using local development defaults")

if "*" in _ALLOWED_ORIGINS:
    if _IS_PRODUCTION:
        raise RuntimeError("Wildcard ALLOWED_ORIGINS is not allowed in production")
    logger.warning("CORS is open to all origins. Avoid '*' outside local testing.")
app.add_middleware(
    CORSMiddleware,
    allow_origins=_ALLOWED_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ---------------------------------------------------------------------------
# Rate limiting — simple in-memory sliding-window per client IP
# ---------------------------------------------------------------------------
_RATE_LIMIT_WINDOW = int(os.environ.get("RATE_LIMIT_WINDOW", "60"))   # seconds
_RATE_LIMIT_MAX = int(os.environ.get("RATE_LIMIT_MAX", "120"))         # requests / window
_rate_counters: dict[str, list[float]] = collections.defaultdict(list)


@app.middleware("http")
async def rate_limit_middleware(request: Request, call_next):
    client_ip = (request.client.host if request.client else "unknown")
    now = time.monotonic()
    window_start = now - _RATE_LIMIT_WINDOW
    timestamps = _rate_counters[client_ip]
    # evict stale entries
    while timestamps and timestamps[0] < window_start:
        timestamps.pop(0)
    if len(timestamps) >= _RATE_LIMIT_MAX:
        logger.warning("Rate limit exceeded for %s", client_ip)
        return JSONResponse(
            status_code=429,
            content={"detail": "Rate limit exceeded. Please slow down."},
        )
    timestamps.append(now)
    return await call_next(request)


async def verify_api_key(x_api_key: str | None = Header(default=None)):
    """FastAPI dependency: validate X-API-Key header when API_KEY is configured."""
    if not _API_KEY:
        return  # dev mode — skip auth
    if not x_api_key or not secrets.compare_digest(x_api_key, _API_KEY):
        logger.warning("Rejected request: invalid or missing X-API-Key")
        raise HTTPException(status_code=401, detail="Invalid or missing API key")


# ---------------------------------------------------------------------------
# Session token helpers (HMAC-signed + expiration)
# ---------------------------------------------------------------------------
_SESSION_SECRET = os.environ.get("SESSION_SECRET", "").strip() or _API_KEY
if not _SESSION_SECRET:
    if _IS_PRODUCTION:
        raise RuntimeError("SESSION_SECRET is required in production environment")
    _SESSION_SECRET = secrets.token_hex(32)
    logger.warning("SESSION_SECRET is not set. Using ephemeral dev secret for this process.")

_WORKSPACE_SESSION_TTL = int(os.environ.get("WORKSPACE_SESSION_TTL", "43200"))  # 12h
_ADMIN_SESSION_TTL = int(os.environ.get("ADMIN_SESSION_TTL", "28800"))  # 8h


def _b64url_encode(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")


def _b64url_decode(text: str) -> bytes:
    pad = "=" * (-len(text) % 4)
    return base64.urlsafe_b64decode((text + pad).encode("ascii"))


def _sign_payload(payload: dict) -> str:
    data = json.dumps(payload, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    body = _b64url_encode(data)
    sig = hmac.new(_SESSION_SECRET.encode("utf-8"), body.encode("ascii"), hashlib.sha256).digest()
    return f"{body}.{_b64url_encode(sig)}"


def _verify_signed_token(token: str, expected_type: str) -> dict | None:
    if not token or "." not in token:
        return None
    body, sig = token.split(".", 1)
    expected_sig = _b64url_encode(
        hmac.new(_SESSION_SECRET.encode("utf-8"), body.encode("ascii"), hashlib.sha256).digest()
    )
    if not secrets.compare_digest(sig, expected_sig):
        return None
    try:
        payload = json.loads(_b64url_decode(body).decode("utf-8"))
    except Exception:
        return None
    if payload.get("typ") != expected_type:
        return None
    exp = int(payload.get("exp") or 0)
    if exp <= int(time.time()):
        return None
    return payload


def _issue_workspace_session_token(workspace_id: str) -> str:
    return _sign_payload(
        {"typ": "ws", "wid": workspace_id, "exp": int(time.time()) + _WORKSPACE_SESSION_TTL}
    )


def _verify_workspace_session_token(workspace_id: str, token: str) -> bool:
    payload = _verify_signed_token(token, expected_type="ws")
    return bool(payload and payload.get("wid") == workspace_id)


def _has_workspace_access_token(workspace_id: str, token: str) -> bool:
    """Accept either owner token/password or a short-lived signed workspace session token."""
    return verify_workspace_token(workspace_id, token) or _verify_workspace_session_token(workspace_id, token)


def _issue_admin_session_token(admin_id: str) -> str:
    return _sign_payload(
        {"typ": "admin", "sub": admin_id, "exp": int(time.time()) + _ADMIN_SESSION_TTL}
    )


def _is_valid_admin_session(token: str | None) -> bool:
    payload = _verify_signed_token(token or "", expected_type="admin")
    return bool(payload and payload.get("sub") == _ADMIN_ID)


# ---------------------------------------------------------------------------
# Admin credentials (set via env vars)
# ---------------------------------------------------------------------------
_ADMIN_ID = os.environ.get("ADMIN_ID", "")
_ADMIN_PASSWORD = os.environ.get("ADMIN_PASSWORD", "")
if _ADMIN_ID:
    logger.info("Admin account configured (id=%s)", _ADMIN_ID)


# ---------------------------------------------------------------------------
# Input validation helpers
# ---------------------------------------------------------------------------
_HTML_CHARS_RE = _re.compile(r"[<>]")
_MAX_NAME_LEN = 100


def _validate_display_name(value: str, field: str = "name") -> str:
    """Strip whitespace, reject HTML chars, enforce length limit."""
    v = (value or "").strip()
    if not v:
        raise ValueError(f"{field} ต้องไม่ว่าง")
    if len(v) > _MAX_NAME_LEN:
        raise ValueError(f"{field} ยาวเกินไป (สูงสุด {_MAX_NAME_LEN} ตัวอักษร)")
    if _HTML_CHARS_RE.search(v):
        raise ValueError(f"{field} ต้องไม่มีอักขระ < หรือ >")
    return v

BASE_DIR = Path(__file__).resolve().parent
STATIC_DIR = BASE_DIR / "static"
if STATIC_DIR.exists():
    app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")


# --- Workspace dependency (async so contextvar propagates to sync endpoint threads) ---
# โหมด dev: ไม่ตั้ง API_KEY = ข้าม workspace token (ใช้ได้เลย)
# โหมด production: ตั้ง API_KEY = ต้องมี workspace token
_ws_auth_env = os.environ.get("DISABLE_WORKSPACE_AUTH", "").lower()
_DISABLE_WORKSPACE_AUTH = (
    _ws_auth_env in ("1", "true", "yes")
    or (not _API_KEY and _ws_auth_env != "0" and _ws_auth_env != "false")
)
if _DISABLE_WORKSPACE_AUTH:
    logger.info("Workspace token check OFF (dev mode). Set API_KEY + DISABLE_WORKSPACE_AUTH=0 for production.")


async def workspace_dep(workspace_id: str, x_workspace_token: str | None = Header(default=None)):
    """FastAPI dependency: validate workspace exists + check access based on access_mode.
    - open: ทุกคนเข้าได้ (read+write)
    - readonly: ทุกคนอ่านได้ แต่ write ต้องมี token (checked by workspace_write_dep)
    - private: ต้องมี token ถึงจะเข้าได้เลย
    """
    ws = get_workspace(workspace_id)
    if ws is None:
        raise HTTPException(status_code=404, detail="Workspace not found")
    mode = ws.get("access_mode", "open")
    has_token = _has_workspace_access_token(workspace_id, x_workspace_token or "")
    # dev mode: bypass เฉพาะ open mode (access_mode ต้อง enforce เสมอ)
    if _DISABLE_WORKSPACE_AUTH and mode == "open":
        has_token = True
    ws["has_token"] = has_token

    if mode == "private" and not has_token:
        raise HTTPException(status_code=403, detail="Workspace นี้เป็น private — ต้องใส่รหัสเพื่อเข้าถึง")

    set_workspace_context(workspace_id)
    return ws


@app.middleware("http")
async def check_workspace_write_access(request: Request, call_next):
    """Middleware: สำหรับ write requests (POST/PUT/PATCH/DELETE) บน workspace
    ถ้า mode=readonly หรือ private → ต้องมี token ถึงจะแก้ได้"""
    path = request.url.path
    method = request.method.upper()
    # เฉพาะ workspace-scoped write requests
    if path.startswith("/w/") and method in ("POST", "PUT", "PATCH", "DELETE"):
        parts = path.split("/")
        if len(parts) >= 3:
            wid = parts[2]
            ws = get_workspace(wid)
            if ws:
                mode = ws.get("access_mode", "open")
                if mode in ("readonly", "private"):
                    token = request.headers.get("x-workspace-token", "")
                    if not _has_workspace_access_token(wid, token):
                        return JSONResponse(
                            status_code=403,
                            content={"detail": "ต้องใส่รหัสเพื่อแก้ไข workspace นี้"},
                        )
    return await call_next(request)


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
    min_gap_shifts: list[str] = []
    min_gap_rules: list[dict] = []
    day_shift_overrides: dict = {}
    min_shifts_by_shift: dict[str, int] = {}

    @field_validator("name")
    @classmethod
    def validate_name(cls, v: str) -> str:
        return _validate_display_name(v, "ชื่อบุคลากร")

    @field_validator("off_days", mode="before")
    @classmethod
    def validate_off_days(cls, v: list) -> list:
        return [int(d) for d in v if 0 <= int(d) <= 6]

    @field_validator("off_days_of_month", mode="before")
    @classmethod
    def validate_off_days_of_month(cls, v: list) -> list:
        return [int(d) for d in v if 1 <= int(d) <= 31]


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
    min_gap_shifts: list[str] = []
    min_gap_rules: list[dict] = []
    day_shift_overrides: dict = {}
    min_shifts_by_shift: dict[str, int] = {}

    @field_validator("name")
    @classmethod
    def validate_name(cls, v: str) -> str:
        return _validate_display_name(v, "ชื่อบุคลากร")

    @field_validator("off_days", mode="before")
    @classmethod
    def validate_off_days(cls, v: list) -> list:
        return [int(d) for d in v if 0 <= int(d) <= 6]

    @field_validator("off_days_of_month", mode="before")
    @classmethod
    def validate_off_days_of_month(cls, v: list) -> list:
        return [int(d) for d in v if 1 <= int(d) <= 31]


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
    active_weekdays: str | None = None  # เปิดเฉพาะวัน (0=จ … 6=อา) เช่น "6" = อาทิตย์เท่านั้น ว่าง = ทุกวันที่กะเปิด
    active_dates: str | None = None  # เปิดเฉพาะวันที่ (1-31) เช่น "12,13,18" ว่าง = ทุกวันที่กะเปิด

    @field_validator("name")
    @classmethod
    def validate_name(cls, v: str) -> str:
        return _validate_display_name(v, "ชื่อตำแหน่ง")


class TimeWindowCreate(BaseModel):
    name: str  # เช่น 06:30-12:00 (หรือให้ระบบสร้างจาก start_time-end_time)
    start_time: str = ""  # HH:MM
    end_time: str = ""    # HH:MM

    @field_validator("name")
    @classmethod
    def validate_name(cls, v: str) -> str:
        return _validate_display_name(v, "ชื่อช่วงเวลา")


class SkillCreate(BaseModel):
    name: str

    @field_validator("name")
    @classmethod
    def validate_name(cls, v: str) -> str:
        return _validate_display_name(v, "ชื่อทักษะ")


class TitleCreate(BaseModel):
    name: str
    type: str = "fulltime"  # fulltime | parttime

    @field_validator("name")
    @classmethod
    def validate_name(cls, v: str) -> str:
        return _validate_display_name(v, "ชื่อฉายา")


class ShiftCreate(BaseModel):
    name: str
    donor: int = 0
    xmatch: int = 0
    positions: list[PositionItem] | None = None
    active_days: str | None = None
    include_holidays: bool = False
    min_fulltime: int = 0
    min_required_title: str | None = None
    min_required_count: int = 0

    @field_validator("name")
    @classmethod
    def validate_name(cls, v: str) -> str:
        return _validate_display_name(v, "ชื่อกะ")


class ShiftUpdate(BaseModel):
    name: str
    donor: int = 0
    xmatch: int = 0
    positions: list[PositionItem] | None = None
    active_days: str | None = None
    include_holidays: bool = False
    min_fulltime: int = 0
    min_required_title: str | None = None
    min_required_count: int = 0

    @field_validator("name")
    @classmethod
    def validate_name(cls, v: str) -> str:
        return _validate_display_name(v, "ชื่อกะ")


class NumDaysUpdate(BaseModel):
    value: int


class SettingsUpdate(BaseModel):
    num_days: int | None = None
    schedule_start_date: str | None = None  # YYYY-MM-DD or "" to clear
    holiday_dates: str | None = None  # comma-separated YYYY-MM-DD


class StaffPairCreate(BaseModel):
    staff_id_1: int
    staff_id_2: int
    pair_type: str  # "together", "apart", or "depends_on"
    shift_names: list[str] | None = None  # ว่าง = ทุกกะ, มีค่า = เฉพาะกะนั้น


class StaffPairBatchItem(BaseModel):
    name_1: str
    name_2: str
    pair_type: str = "together"
    shift_names: list[str] | None = None


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


class SlotSwap(BaseModel):
    """Swap staff between two slots"""
    day_a: int
    shift_name_a: str
    position_a: str
    slot_index_a: int = 0
    day_b: int
    shift_name_b: str
    position_b: str
    slot_index_b: int = 0


class WorkspaceCreate(BaseModel):
    name: str = ""
    access_mode: str = "open"
    password: str = ""

    @field_validator("name", mode="before")
    @classmethod
    def validate_name(cls, v: str) -> str:
        v = (v or "").strip()
        if v and len(v) > _MAX_NAME_LEN:
            raise ValueError(f"ชื่อ workspace ยาวเกินไป (สูงสุด {_MAX_NAME_LEN} ตัวอักษร)")
        if _HTML_CHARS_RE.search(v):
            raise ValueError("ชื่อต้องไม่มีอักขระ < หรือ >")
        return v

    @field_validator("access_mode", mode="before")
    @classmethod
    def validate_access_mode(cls, v: str) -> str:
        v = (v or "open").strip().lower()
        if v not in ("open", "readonly", "private"):
            raise ValueError("access_mode ต้องเป็น open, readonly, หรือ private")
        return v


# ==========================================
# Workspace-scoped router: /w/{workspace_id}/api/...
# ==========================================
ws_router = APIRouter(dependencies=[Depends(workspace_dep), Depends(verify_api_key)])


# --- API: Workspace info ---
@ws_router.get("/api/workspace-info")
def api_workspace_info(workspace_id: str, x_workspace_token: str | None = Header(default=None)):
    """คืนข้อมูล workspace + บอกว่า client มี token ถูกต้องมั้ย"""
    ws = get_workspace(workspace_id)
    has_token = _has_workspace_access_token(workspace_id, x_workspace_token or "")
    mode = ws.get("access_mode", "open")
    # dev mode: ถือว่าเป็น owner เฉพาะ open mode
    if _DISABLE_WORKSPACE_AUTH and mode == "open":
        has_token = True
    return {
        "id": ws["id"],
        "name": ws["name"],
        "access_mode": mode,
        "is_owner": has_token,
    }


@ws_router.put("/api/workspace-mode")
def api_update_workspace_mode(
    workspace_id: str,
    body: dict = Body(...),
    x_workspace_token: str | None = Header(default=None),
):
    """เปลี่ยน access_mode — ต้องมี token (เจ้าของเท่านั้น)"""
    if not _has_workspace_access_token(workspace_id, x_workspace_token or ""):
        raise HTTPException(status_code=403, detail="ต้องเป็นเจ้าของ workspace ถึงจะเปลี่ยนโหมดได้")
    mode = body.get("access_mode", "")
    if mode not in ("open", "readonly", "private"):
        raise HTTPException(status_code=400, detail="access_mode ต้องเป็น open, readonly, หรือ private")
    update_workspace_access_mode(workspace_id, mode)
    logger.info("Workspace %s access_mode changed to %s", workspace_id, mode)
    return {"ok": True, "access_mode": mode}


# --- API: Staff ---
@ws_router.get("/api/staff")
def api_list_staff():
    return list_staff()


@ws_router.get("/api/staff/{staff_id:int}")
def api_get_staff(staff_id: int):
    staff = get_staff(staff_id)
    if staff is None:
        raise HTTPException(status_code=404, detail="Staff not found.")
    return staff


@ws_router.get("/api/time-windows")
def api_list_time_windows():
    return list_time_window_catalog()


@ws_router.post("/api/time-windows")
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


@ws_router.delete("/api/time-windows/{name:path}")
def api_remove_time_window(name: str):
    remove_time_window_catalog(name)
    return {"ok": True}


@ws_router.post("/api/staff")
def api_create_staff(body: StaffCreate):
    try:
        sid = create_staff(
            body.name,
            body.off_days,
            body.skills,
            body.title,
            body.off_days_of_month,
            body.time_windows,
            min_shifts_per_month=body.min_shifts_per_month,
            max_shifts_per_month=body.max_shifts_per_month,
            min_gap_days=body.min_gap_days,
            min_gap_shifts=body.min_gap_shifts,
            min_gap_rules=body.min_gap_rules,
            day_shift_overrides=body.day_shift_overrides,
            min_shifts_by_shift=body.min_shifts_by_shift,
        )
    except sqlite3.IntegrityError:
        raise HTTPException(status_code=409, detail=f"ชื่อ '{body.name}' มีอยู่แล้ว กรุณาใช้ชื่ออื่น")
    from database import get_title_type
    stype = get_title_type(body.title or "")
    return {"id": sid, "name": body.name, "type": stype, "title": body.title or "", "off_days": body.off_days, "skills": body.skills}


@ws_router.put("/api/staff/{staff_id:int}")
def api_update_staff(staff_id: int, body: StaffUpdate):
    try:
        update_staff(
            staff_id,
            body.name,
            body.off_days,
            body.skills,
            body.title,
            body.off_days_of_month,
            body.time_windows,
            skill_levels=body.skill_levels,
            min_shifts_per_month=body.min_shifts_per_month,
            max_shifts_per_month=body.max_shifts_per_month,
            min_gap_days=body.min_gap_days,
            min_gap_shifts=body.min_gap_shifts,
            min_gap_rules=body.min_gap_rules,
            day_shift_overrides=body.day_shift_overrides,
            min_shifts_by_shift=body.min_shifts_by_shift,
        )
    except sqlite3.IntegrityError:
        raise HTTPException(status_code=409, detail=f"ชื่อ '{body.name}' มีอยู่แล้ว กรุณาใช้ชื่ออื่น")
    from database import get_title_type
    stype = get_title_type(body.title or "")
    return {"id": staff_id, "name": body.name, "type": stype, "title": body.title or "", "off_days": body.off_days, "skills": body.skills}


@ws_router.delete("/api/staff/{staff_id:int}")
def api_delete_staff(staff_id: int):
    delete_staff(staff_id)
    return {"ok": True}


# --- API: Skills (รายการทักษะสำหรับใส่ให้บุคลากร) ---
@ws_router.get("/api/skills")
def api_list_skills():
    return list_skill_catalog()


@ws_router.post("/api/skills")
def api_add_skill(body: SkillCreate):
    name = (body.name or "").strip()
    if not name:
        raise HTTPException(status_code=400, detail="ชื่อทักษะต้องไม่ว่าง")
    add_skill_catalog(name)
    return {"name": name}


@ws_router.put("/api/skills/{old_name}")
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


@ws_router.delete("/api/skills/{name}")
def api_remove_skill(name: str):
    remove_skill_catalog(name)
    return {"ok": True}


class SkillLevelsUpdate(BaseModel):
    levels: list[str]


@ws_router.get("/api/skills/{name}/levels")
def api_get_skill_levels(name: str):
    return get_skill_levels(name)


@ws_router.put("/api/skills/{name}/levels")
def api_set_skill_levels(name: str, body: SkillLevelsUpdate):
    labels = [l.strip() for l in body.levels if l.strip()]
    if not labels:
        raise HTTPException(status_code=400, detail="ต้องมีอย่างน้อย 1 ระดับ")
    set_skill_levels(name, labels)
    return get_skill_levels(name)


# --- API: Titles (ฉายา/ตำแหน่ง รวมประเภท) ---
@ws_router.get("/api/titles")
def api_list_titles():
    return list_title_catalog()


@ws_router.post("/api/titles")
def api_add_title(body: TitleCreate):
    name = (body.name or "").strip()
    if not name:
        raise HTTPException(status_code=400, detail="ชื่อฉายาต้องไม่ว่าง")
    stype = (body.type or "fulltime").lower()
    if stype not in ("fulltime", "parttime"):
        stype = "fulltime"
    try:
        add_title_catalog(name, stype)
    except sqlite3.IntegrityError:
        raise HTTPException(status_code=409, detail="ชื่อฉายาซ้ำ มีอยู่แล้ว กรุณาใช้ชื่ออื่น")
    return {"name": name, "type": stype}


@ws_router.delete("/api/titles/{name:path}")
def api_remove_title(name: str):
    remove_title_catalog(name)
    return {"ok": True}


# --- API: Shifts ---
@ws_router.get("/api/shifts")
def api_list_shifts():
    return list_shifts()


@ws_router.post("/api/shifts")
def api_create_shift(body: ShiftCreate):
    positions = None
    if body.positions is not None:
        positions = [{"name": p.name, "constraint_note": p.constraint_note or "", "regular_only": p.regular_only or False, "slot_count": max(1, p.slot_count or 1), "time_window_name": (p.time_window_name or "").strip() or None, "required_skill": (p.required_skill or "").strip() or None, "min_skill_level": max(0, int(p.min_skill_level or 0)), "allowed_titles": list(p.allowed_titles or []), "max_per_week": max(0, int(p.max_per_week or 0)), "active_weekdays": (p.active_weekdays or "").strip() or None, "active_dates": (p.active_dates or "").strip() or None} for p in body.positions]
    min_required_title = (body.min_required_title or "").strip()
    min_required_count = max(0, int(body.min_required_count or 0))
    if min_required_count > 0 and not min_required_title:
        raise HTTPException(status_code=400, detail="ถ้าตั้งจำนวนขั้นต่ำ ต้องเลือกฉายาที่ต้องการด้วย")
    try:
        sid = create_shift(
            body.name,
            body.donor,
            body.xmatch,
            positions=positions,
            active_days=body.active_days,
            include_holidays=body.include_holidays,
            min_fulltime=body.min_fulltime,
            min_required_title=min_required_title or None,
            min_required_count=min_required_count,
        )
    except sqlite3.IntegrityError:
        raise HTTPException(status_code=409, detail="ชื่อกะซ้ำ มีอยู่แล้ว กรุณาใช้ชื่ออื่น")
    out = {"id": sid, "name": body.name}
    if positions is not None:
        out["positions"] = [{"name": p["name"], "constraint_note": p["constraint_note"], "regular_only": p["regular_only"], "slot_count": p.get("slot_count", 1)} for p in positions]
    else:
        out["donor"] = body.donor
        out["xmatch"] = body.xmatch
    return out


@ws_router.post("/api/shifts/from-template")
def api_create_shift_from_template(template: int = Query(..., ge=1, le=5), name: str | None = Query(None)):
    sid = create_shift_from_template(template, name_override=name)
    shifts = list_shifts()
    created = next((s for s in shifts if s["id"] == sid), None)
    return {"id": sid, "shift": created}


@ws_router.post("/api/apply-template")
def api_apply_template(template: int = Query(..., ge=1, le=6)):
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


@ws_router.post("/api/clear-all")
def api_clear_all():
    """ล้างทั้งหมด: บุคลากร, กะ, ตาราง — กลับเป็นหน้าว่าง"""
    clear_all()
    return {"ok": True}


@ws_router.put("/api/shifts/{shift_id:int}")
def api_update_shift(shift_id: int, body: ShiftUpdate):
    positions = None
    if body.positions is not None:
        positions = [{"name": p.name, "constraint_note": p.constraint_note or "", "regular_only": p.regular_only or False, "slot_count": max(1, p.slot_count or 1), "time_window_name": (p.time_window_name or "").strip() or None, "required_skill": (p.required_skill or "").strip() or None, "min_skill_level": max(0, int(p.min_skill_level or 0)), "allowed_titles": list(p.allowed_titles or []), "max_per_week": max(0, int(p.max_per_week or 0)), "active_weekdays": (p.active_weekdays or "").strip() or None, "active_dates": (p.active_dates or "").strip() or None} for p in body.positions]
    min_required_title = (body.min_required_title or "").strip()
    min_required_count = max(0, int(body.min_required_count or 0))
    if min_required_count > 0 and not min_required_title:
        raise HTTPException(status_code=400, detail="ถ้าตั้งจำนวนขั้นต่ำ ต้องเลือกฉายาที่ต้องการด้วย")
    try:
        update_shift(
            shift_id,
            body.name,
            body.donor,
            body.xmatch,
            positions=positions,
            active_days=body.active_days,
            include_holidays=body.include_holidays,
            min_fulltime=body.min_fulltime,
            min_required_title=min_required_title or None,
            min_required_count=min_required_count,
        )
    except sqlite3.IntegrityError:
        raise HTTPException(status_code=409, detail="ชื่อกะซ้ำ มีอยู่แล้ว กรุณาใช้ชื่ออื่น")
    out = {"id": shift_id, "name": body.name}
    if positions is not None:
        out["positions"] = [{"name": p["name"], "constraint_note": p["constraint_note"], "regular_only": p["regular_only"], "slot_count": p.get("slot_count", 1)} for p in positions]
    else:
        out["donor"] = body.donor
        out["xmatch"] = body.xmatch
    return out


@ws_router.delete("/api/shifts/{shift_id:int}")
def api_delete_shift(shift_id: int):
    delete_shift(shift_id)
    return {"ok": True}


# --- API: Settings ---
@ws_router.get("/api/settings")
def api_get_settings():
    return {
        "num_days": get_num_days(),
        "schedule_start_date": get_schedule_start_date() or "",
        "holiday_dates": get_holiday_dates(),
    }


@ws_router.get("/api/settings/num_days")
def api_get_num_days():
    return {"value": get_num_days()}


@ws_router.put("/api/settings/num_days")
def api_set_num_days(body: NumDaysUpdate):
    set_num_days(body.value)
    return {"value": body.value}


@ws_router.put("/api/settings")
def api_set_settings(body: SettingsUpdate):
    if body.num_days is not None:
        set_num_days(body.num_days)
    if body.schedule_start_date is not None:
        set_schedule_start_date(body.schedule_start_date.strip() or "")
    if body.holiday_dates is not None:
        set_holiday_dates(body.holiday_dates.strip())
    return api_get_settings()


# --- API: Schedule (run + get) ---
@ws_router.post("/api/schedule/run")
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
    logger.info("Running schedule: num_days=%d start_date=%s staff=%d shifts=%d",
                num_days, start_date_str, len(mt_list), len(shift_list))
    slots, solver, status = generate_schedule(num_days=num_days, start_date_str=start_date_str or None)

    # กรณี solver fail จริงๆ (MODEL_INVALID ฯลฯ) — ไม่ใช่แค่ infeasible
    if status not in (cp_model.OPTIMAL, cp_model.FEASIBLE):
        reasons = diagnose_infeasible(mt_list, shift_list, num_days, start_date_str)
        logger.warning("Schedule infeasible: %s", reasons)
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
        logger.warning("Schedule has %d dummy slots. Hints: %s", len(dummy_slots), hints)
        result["has_dummy"] = True
        result["dummy_count"] = len(dummy_slots)
        result["infeasibility_hints"] = hints
    else:
        result["has_dummy"] = False
        result["dummy_count"] = 0
    logger.info("Schedule run_id=%d saved (slots=%d dummy=%d)", run_id, len(slots), len(dummy_slots))
    return result


@ws_router.get("/api/schedule/latest")
def api_get_latest_schedule():
    data = get_latest_schedule()
    if data is None:
        raise HTTPException(status_code=404, detail="No schedule yet. Run the scheduler first.")
    return data


@ws_router.get("/api/schedule/{run_id:int}")
def api_get_schedule(run_id: int):
    data = get_schedule(run_id)
    if data is None:
        raise HTTPException(status_code=404, detail="Schedule not found.")
    return data


# --- Export CSV ---
@ws_router.get("/api/schedule/export/csv")
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
@ws_router.patch("/api/schedule/{run_id:int}/slot")
def api_assign_slot(run_id: int, body: SlotAssign):
    """Manual override: กำหนด staff ให้ slot ที่ระบุ (ใช้แทน dummy หรือสลับคน)"""
    data = get_schedule(run_id)
    if data is None:
        raise HTTPException(status_code=404, detail="Schedule not found.")
    name = body.staff_name.strip()
    if not name:
        raise HTTPException(status_code=400, detail="staff_name ต้องไม่ว่าง")
    warnings = _check_staff_off_day_warnings(name, body.day)
    try:
        update_slot_staff(run_id, body.day, body.shift_name, body.position, body.slot_index, name)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    updated = get_schedule(run_id)
    return {"ok": True, "run_id": run_id, "schedule": updated, "warnings": warnings}


# --- Manual Slot Swap ---
@ws_router.post("/api/schedule/{run_id:int}/swap")
def api_swap_slots(run_id: int, body: SlotSwap):
    """สลับ staff ระหว่างสอง slot (atomic, ไม่ block โดย same-day guard)"""
    data = get_schedule(run_id)
    if data is None:
        raise HTTPException(status_code=404, detail="Schedule not found.")
    # ดึงชื่อคนก่อน swap เพื่อเช็ค off-day warnings
    data_before = get_schedule(run_id)
    warnings = []
    if data_before:
        slots = data_before if isinstance(data_before, list) else data_before.get("slots", [])
        for s in slots:
            if (s.get("day") == body.day_a and s.get("shift_name") == body.shift_name_a
                    and s.get("position") == body.position_a and s.get("slot_index") == body.slot_index_a):
                # คนนี้จะไป day_b
                warnings.extend(_check_staff_off_day_warnings(s["staff_name"], body.day_b))
            if (s.get("day") == body.day_b and s.get("shift_name") == body.shift_name_b
                    and s.get("position") == body.position_b and s.get("slot_index") == body.slot_index_b):
                # คนนี้จะไป day_a
                warnings.extend(_check_staff_off_day_warnings(s["staff_name"], body.day_a))
    try:
        swap_slots(
            run_id,
            body.day_a, body.shift_name_a, body.position_a, body.slot_index_a,
            body.day_b, body.shift_name_b, body.position_b, body.slot_index_b,
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    updated = get_schedule(run_id)
    return {"ok": True, "run_id": run_id, "schedule": updated, "warnings": warnings}


# --- API: Staff Pairs ---
@ws_router.get("/api/staff-pairs")
def api_list_staff_pairs():
    return list_staff_pairs()


@ws_router.post("/api/staff-pairs")
def api_add_staff_pair(body: StaffPairCreate):
    if body.staff_id_1 == body.staff_id_2:
        raise HTTPException(status_code=400, detail="ต้องเลือกคนละคน")
    if body.pair_type not in ("together", "apart", "depends_on"):
        raise HTTPException(status_code=400, detail="pair_type ต้องเป็น 'together', 'apart' หรือ 'depends_on'")
    add_staff_pair(body.staff_id_1, body.staff_id_2, body.pair_type, shift_names=body.shift_names)
    return {"ok": True}


@ws_router.post("/api/staff-pairs/batch")
def api_add_staff_pairs_batch(body: list[StaffPairBatchItem]):
    """เพิ่มหลายคู่พร้อมกัน รองรับ name_1, name_2 (ชื่อบุคลากร)"""
    from database import list_staff

    staff_by_name = {s["name"]: s["id"] for s in list_staff()}
    errors = []
    for i, item in enumerate(body):
        if not item.name_1 or not item.name_2:
            errors.append(f"แถว {i + 1}: ต้องระบุชื่อทั้ง 2 คน")
            continue
        if item.name_1.strip() == item.name_2.strip():
            errors.append(f"แถว {i + 1}: ต้องเลือกคนละคน")
            continue
        if item.pair_type not in ("together", "apart", "depends_on"):
            errors.append(f"แถว {i + 1}: pair_type ต้องเป็น together, apart หรือ depends_on")
            continue
        if not staff_by_name.get(item.name_1.strip()):
            errors.append(f"แถว {i + 1}: ไม่พบบุคลากร '{item.name_1}'")
            continue
        if not staff_by_name.get(item.name_2.strip()):
            errors.append(f"แถว {i + 1}: ไม่พบบุคลากร '{item.name_2}'")
            continue
    if errors:
        raise HTTPException(status_code=400, detail="; ".join(errors[:10]) + (" ..." if len(errors) > 10 else ""))
    added = 0
    for item in body:
        s1 = staff_by_name[item.name_1.strip()]
        s2 = staff_by_name[item.name_2.strip()]
        add_staff_pair(s1, s2, item.pair_type, shift_names=item.shift_names)
        added += 1
    return {"ok": True, "added": added}


@ws_router.delete("/api/staff-pairs/{pair_id:int}")
def api_remove_staff_pair(pair_id: int):
    remove_staff_pair(pair_id)
    return {"ok": True}


# --- API: Import/Export ---
@ws_router.get("/api/export")
def api_export():
    return export_all_data()


@ws_router.post("/api/import")
def api_import(data: dict = Body(...)):
    import_all_data(data)
    return {"ok": True}


# --- Frontend: serve index.html inside workspace ---
@ws_router.get("/staff", response_class=HTMLResponse)
def staff_page():
    staff_html = STATIC_DIR / "staff.html"
    if staff_html.exists():
        return FileResponse(staff_html)
    return HTMLResponse("<h1>Staff</h1><p>Add static/staff.html for the staff detail page.</p>")


@ws_router.get("/", response_class=HTMLResponse)
def workspace_index():
    index_html = STATIC_DIR / "index.html"
    if index_html.exists():
        return FileResponse(index_html)
    return HTMLResponse("<h1>MT Shift Optimizer</h1><p>Add static/index.html for the UI.</p>")


# Mount workspace router
app.include_router(ws_router, prefix="/w/{workspace_id}")


# ==========================================
# Global routes (not workspace-scoped)
# ==========================================

# --- Workspace management API ---
@app.post("/api/workspaces", dependencies=[Depends(verify_api_key)])
def api_create_workspace(body: WorkspaceCreate = Body(WorkspaceCreate())):
    wid, token = create_workspace(body.name, access_mode=body.access_mode, password=body.password.strip())
    logger.info("Created workspace id=%s name=%r mode=%s", wid, body.name, body.access_mode)
    return {"id": wid, "token": token, "url": f"/w/{wid}/", "access_mode": body.access_mode}


@app.get("/api/workspaces", dependencies=[Depends(verify_api_key)])
def api_list_workspaces():
    # dev mode (no API_KEY) → ส่ง token กลับมาด้วยเพื่อให้ browser sync
    return list_workspaces(include_tokens=_DISABLE_WORKSPACE_AUTH)


@app.delete("/api/workspaces/{workspace_id}", dependencies=[Depends(verify_api_key)])
def api_delete_workspace(workspace_id: str, x_workspace_token: str | None = Header(default=None)):
    # ต้องเป็นเจ้าของ workspace เท่านั้นถึงจะลบได้
    if not _has_workspace_access_token(workspace_id, x_workspace_token or ""):
        raise HTTPException(status_code=403, detail="ต้องใส่รหัสเจ้าของ workspace ก่อนลบ")
    ok = delete_workspace(workspace_id)
    if not ok:
        raise HTTPException(status_code=404, detail="Workspace not found")
    logger.info("Deleted workspace id=%s", workspace_id)
    return {"ok": True}


@app.post("/api/workspaces/{workspace_id}/login", dependencies=[Depends(verify_api_key)])
def api_workspace_login(workspace_id: str, body: dict = Body(...)):
    """ใส่รหัส (password) เพื่อเข้าถึง workspace — คืน short-lived session token"""
    if get_workspace(workspace_id) is None:
        raise HTTPException(status_code=404, detail="Workspace not found")
    password = (body.get("password") or "").strip()
    if not password:
        raise HTTPException(status_code=400, detail="กรุณาใส่รหัส")
    if not verify_workspace_token(workspace_id, password):
        raise HTTPException(status_code=403, detail="รหัสไม่ถูกต้อง")
    token = _issue_workspace_session_token(workspace_id)
    return {"ok": True, "token": token, "expires_in": _WORKSPACE_SESSION_TTL}


# --- Admin ---
@app.post("/api/admin/login")
def api_admin_login(body: dict = Body(...)):
    """Admin login — คืน admin_token ถ้า id + password ถูก"""
    if not _ADMIN_ID or not _ADMIN_PASSWORD:
        raise HTTPException(status_code=404, detail="Admin mode is not configured")
    aid = (body.get("id") or "").strip()
    apw = (body.get("password") or "").strip()
    if not aid or not apw:
        raise HTTPException(status_code=400, detail="กรุณากรอก ID และรหัส")
    if aid != _ADMIN_ID or apw != _ADMIN_PASSWORD:
        logger.warning("Admin login failed: id=%s", aid)
        raise HTTPException(status_code=403, detail="ID หรือรหัสไม่ถูกต้อง")
    admin_token = _issue_admin_session_token(aid)
    logger.info("Admin logged in: id=%s", aid)
    return {"ok": True, "admin_token": admin_token, "expires_in": _ADMIN_SESSION_TTL}


@app.get("/api/admin/workspaces")
def api_admin_list_workspaces(x_admin_token: str | None = Header(default=None)):
    """Admin: ดู workspace ทั้งหมดพร้อม token"""
    if not _is_valid_admin_session(x_admin_token):
        raise HTTPException(status_code=403, detail="ไม่มีสิทธิ์ admin")
    return list_workspaces(include_tokens=True)


@app.delete("/api/admin/workspaces/{workspace_id}")
def api_admin_delete_workspace(workspace_id: str, x_admin_token: str | None = Header(default=None)):
    """Admin: ลบ workspace ใดก็ได้"""
    if not _is_valid_admin_session(x_admin_token):
        raise HTTPException(status_code=403, detail="ไม่มีสิทธิ์ admin")
    ok = delete_workspace(workspace_id)
    if not ok:
        raise HTTPException(status_code=404, detail="Workspace not found")
    logger.info("Admin deleted workspace id=%s", workspace_id)
    return {"ok": True}


@app.get("/admin", response_class=HTMLResponse)
def admin_page():
    admin_html = STATIC_DIR / "admin.html"
    if admin_html.exists():
        return FileResponse(admin_html)
    return HTMLResponse("<h1>Admin page not found</h1>", status_code=404)


# --- Landing page ---
@app.get("/", response_class=HTMLResponse)
def landing():
    landing_html = STATIC_DIR / "landing.html"
    if landing_html.exists():
        return FileResponse(landing_html)
    # Fallback: redirect to first workspace if exists, or show basic HTML
    workspaces = list_workspaces()
    if workspaces:
        from fastapi.responses import RedirectResponse
        return RedirectResponse(url=f"/w/{workspaces[0]['id']}/")
    return HTMLResponse("<h1>MT Shift Optimizer</h1><p>No workspaces yet.</p>")


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
