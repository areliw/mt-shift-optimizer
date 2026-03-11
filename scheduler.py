# scheduler.py

from datetime import datetime, timedelta, date as date_type
from ortools.sat.python import cp_model
from database import get_mt_list, get_shift_list, get_num_days, get_time_window_catalog_dict, get_holiday_dates, list_staff_pairs

DUMMY_WORKER = "_DUMMY_"  # ชื่อพิเศษสำหรับ slot ที่จัดไม่ได้ด้วย staff จริง


def _window_contains(catalog, staff_window_name, position_window_name):
    """เช็คว่าช่วงที่คนอยู่ได้ (staff) ครอบคลุมช่วงที่ช่องต้องการ (position) หรือไม่"""
    if not catalog or not position_window_name or not staff_window_name:
        return True
    pos = catalog.get(position_window_name)
    staff = catalog.get(staff_window_name)
    if not pos or not staff:
        return False
    # staff ครอบ position ได้ถ้า staff เริ่มไม่หลังกว่า และจบไม่ก่อนกว่า
    return staff["start_time"] <= pos["start_time"] and staff["end_time"] >= pos["end_time"]


def _staff_can_work_position(mt, pos, catalog):
    """บุคลากรคนนี้อยู่ได้ครบช่วงที่ช่องต้องการ AND มี skill ถึง level ที่กำหนดหรือไม่"""
    pos_tw = isinstance(pos, dict) and (pos.get("time_window_name") or "").strip() or None
    if pos_tw:
        staff_windows = mt.get("time_windows") or []
        if not staff_windows:
            return False
        if not any(_window_contains(catalog, sw, pos_tw) for sw in staff_windows):
            return False

    # ตรวจ skill level requirement
    if isinstance(pos, dict):
        req_skill = (pos.get("required_skill") or "").strip()
        min_lvl = int(pos.get("min_skill_level") or 0)
        if req_skill and min_lvl > 0:
            skill_levels = mt.get("skill_levels") or {}
            staff_lvl = int(skill_levels.get(req_skill) or 0)
            if staff_lvl < min_lvl:
                return False

    # ตรวจ allowed_titles: ถ้ากำหนด ต้องฉายาตรงเท่านั้น
    if isinstance(pos, dict):
        allowed = pos.get("allowed_titles") or []
        if allowed:
            staff_title = (mt.get("title") or "").strip()
            if staff_title not in allowed:
                return False

    return True


def _parse_active_days(active_days_str):
    """
    แปลง active_days string → set ของ weekday int (0=จันทร์ … 6=อาทิตย์)
    รูปแบบ: ตัวเลขคั่นด้วยจุลภาค เช่น "0,1,2,3,4" = จันทร์-ศุกร์
    คืน None = ไม่มีข้อจำกัด (active ทุกวัน)
    """
    if not active_days_str or not str(active_days_str).strip():
        return None
    days = set()
    for part in str(active_days_str).split(","):
        part = part.strip()
        if part.isdigit():
            d = int(part)
            if 0 <= d <= 6:
                days.add(d)
    return days if days else None


def _parse_holiday_dates(holiday_str):
    """แปลง holiday_dates string → set ของ date objects"""
    if not holiday_str:
        return set()
    dates = set()
    for part in str(holiday_str).split(","):
        part = part.strip()
        if not part:
            continue
        try:
            dates.add(datetime.strptime(part, "%Y-%m-%d").date())
        except ValueError:
            pass
    return dates


def _is_shift_active_on_day(shift, day_index, start_date, holiday_set=None):
    """
    เช็คว่า shift นี้ active ในวันที่ day_index (0-based จากวันเริ่ม) หรือไม่
    ถ้าไม่มี active_days หรือไม่รู้วันที่เริ่ม → active ทุกวัน
    ถ้ามี include_holidays=True และวันนั้นเป็นวันหยุด → active ด้วย
    """
    active_days_set = _parse_active_days(shift.get("active_days"))
    if active_days_set is None or start_date is None:
        return True
    cal_date = start_date + timedelta(days=day_index)
    if cal_date.weekday() in active_days_set:
        return True
    if shift.get("include_holidays") and holiday_set and cal_date in holiday_set:
        return True
    return False


def _expand_positions(shift_list):
    """Yield (shift, pos, pos_name, slot_index) for every slot (position × slot_count)."""
    for shift in shift_list:
        for pos in shift["positions"]:
            pos_name = pos["name"] if isinstance(pos, dict) else pos
            slot_count = max(1, int(pos.get("slot_count", 1)) if isinstance(pos, dict) else 1)
            for slot_i in range(slot_count):
                yield shift, pos, pos_name, slot_i


def diagnose_infeasible(mt_list, shift_list, num_days, start_date_str=None):
    """
    วิเคราะห์ว่าทำไมถึง feasible ไม่ได้ คืนรายการข้อความสั้นๆ (constraint ไหนทำให้จัดไม่ได้)
    """
    if not mt_list or not shift_list or num_days <= 0:
        return ["ไม่มีบุคลากรหรือกะ หรือจำนวนวันเป็น 0"]

    expanded = list(_expand_positions(shift_list))
    start_date = None
    if start_date_str:
        try:
            start_date = datetime.strptime(start_date_str.strip()[:10], "%Y-%m-%d").date()
        except (ValueError, TypeError):
            pass
    holiday_set = _parse_holiday_dates(get_holiday_dates())

    def available_on_day(mt, day):
        off_weekdays = set(mt.get("off_days") or [])
        if off_weekdays:
            if start_date:
                cal = start_date + timedelta(days=day)
                if cal.weekday() in off_weekdays:
                    return False
            elif day % 7 in off_weekdays:
                return False
        if start_date and (mt.get("off_days_of_month") or []):
            cal = start_date + timedelta(days=day)
            if cal.day in mt["off_days_of_month"]:
                return False
        return True

    def active_slots_on_day(day):
        """จำนวน slot ที่ต้องการจริงในวันนั้น (หักกะที่ inactive ออก)"""
        return sum(
            1 for shift, pos, pos_name, slot_i in expanded
            if _is_shift_active_on_day(shift, day, start_date, holiday_set)
        )

    reasons = []

    # 1) จำนวนคนรวมพอไหม (คำนึงถึง active_days)
    total_slots = sum(active_slots_on_day(day) for day in range(num_days))
    total_capacity = sum(
        1 for mt in mt_list for d in range(num_days) if available_on_day(mt, d)
    )
    if total_capacity < total_slots:
        reasons.append(
            f"รวมต้องการ {total_slots} ครั้ง (วัน×ช่อง) แต่คนว่างรวมได้แค่ {total_capacity} ครั้ง — ลดจำนวนวัน หรือเพิ่มคน/ลดวันหยุด"
        )

    # 2) แต่ละวันมีคนว่างพอไหม
    for day in range(num_days):
        slots_today = active_slots_on_day(day)
        if slots_today == 0:
            continue  # วันนี้ไม่มีกะ active → ข้ามได้
        available = sum(1 for mt in mt_list if available_on_day(mt, day))
        if available < slots_today:
            date_str = ""
            if start_date:
                cal = start_date + timedelta(days=day)
                date_str = f" ({cal.isoformat()})"
            reasons.append(
                f"วันที่ {day + 1}{date_str}: ต้องการ {slots_today} คน แต่มีคนว่างแค่ {available} คน (ขาด {slots_today - available} คน)"
            )

    # 3) ตำแหน่ง regular_only ต้องใช้ fulltime เท่านั้น — ตรวจว่า fulltime พอไหม
    for shift in shift_list:
        for pos in shift.get("positions", []):
            if isinstance(pos, dict) and pos.get("regular_only"):
                pos_name = pos.get("name", "")
                n_fulltime = sum(1 for mt in mt_list if mt.get("type") == "fulltime")
                slot_count = max(1, int(pos.get("slot_count", 1)))
                if n_fulltime < slot_count:
                    reasons.append(
                        f"ตำแหน่ง '{pos_name}' กำหนดเต็มเวลาเท่านั้น แต่มีคนเต็มเวลาแค่ {n_fulltime} คน (ต้องการ {slot_count} คน/วัน)"
                    )

    if not reasons:
        reasons.append("ตัวแก้ไม่พบสาเหตุชัดเจน — ลองลดจำนวนวัน หรือตรวจวันหยุด/วันหยุดรายเดือน")
    return reasons


def generate_schedule(num_days=None, start_date_str=None, timeout_seconds=30):
    mt_list = get_mt_list()
    shift_list = get_shift_list()
    if num_days is None:
        num_days = get_num_days()
    catalog = get_time_window_catalog_dict()
    model = cp_model.CpModel()

    start_date = None
    if start_date_str:
        try:
            start_date = datetime.strptime(start_date_str.strip()[:10], "%Y-%m-%d").date()
        except (ValueError, TypeError):
            pass
    holiday_set = _parse_holiday_dates(get_holiday_dates())
    pairs = list_staff_pairs()
    name_to_mt = {mt["name"]: mt for mt in mt_list}

    dummy = {
        "name": DUMMY_WORKER,
        "off_days": [],
        "off_days_of_month": [],
        "time_windows": [],
        "skill_levels": {},
        "type": "fulltime",
        "title": "",
    }
    all_mt = mt_list + [dummy]

    assign = {}
    expanded = list(_expand_positions(shift_list))
    for mt in all_mt:
        for day in range(num_days):
            for shift, pos, pos_name, slot_i in expanded:
                key = (mt["name"], day, shift["name"], pos_name, slot_i)
                safe_name = mt["name"].replace(" ", "_")
                assign[key] = model.new_bool_var(
                    f"{safe_name}_d{day}_{shift['name']}_{pos_name}_{slot_i}"
                )

    for day in range(num_days):
        for shift, pos, pos_name, slot_i in expanded:
            if not _is_shift_active_on_day(shift, day, start_date, holiday_set):
                for mt in all_mt:
                    model.add(assign[(mt["name"], day, shift["name"], pos_name, slot_i)] == 0)
            else:
                model.add(
                    sum(assign[(mt["name"], day, shift["name"], pos_name, slot_i)] for mt in all_mt)
                    == 1
                )

    # has_work[mt_name, day] = 1 iff staff works any slot that day
    has_work = {}
    for mt in mt_list:
        for day in range(num_days):
            h = model.new_bool_var(f"hw_{mt['name'].replace(' ','_')}_d{day}")
            day_vars = [
                assign[(mt["name"], day, shift["name"], pos_name, slot_i)]
                for shift, pos, pos_name, slot_i in expanded
            ]
            model.add(sum(day_vars) >= 1).only_enforce_if(h)
            model.add(sum(day_vars) == 0).only_enforce_if(h.negated())
            has_work[(mt["name"], day)] = h

    for mt in mt_list:
        for day in range(num_days):
            model.add(
                sum(
                    assign[(mt["name"], day, shift["name"], pos_name, slot_i)]
                    for shift, pos, pos_name, slot_i in expanded
                )
                <= 1
            )

    # off_days = วันหยุดประจำสัปดาห์ (0=จันทร์ … 6=อาทิตย์) — ห้ามจัดทุกวันที่มี weekday นี้
    for mt in mt_list:
        off_weekdays = set(mt.get("off_days") or [])
        if not off_weekdays:
            continue
        for day in range(num_days):
            if start_date:
                cal_date = start_date + timedelta(days=day)
                weekday = cal_date.weekday()
            else:
                weekday = day % 7
            if weekday in off_weekdays:
                for shift, pos, pos_name, slot_i in expanded:
                    model.add(assign[(mt["name"], day, shift["name"], pos_name, slot_i)] == 0)

    if start_date:
        for mt in mt_list:
            off_month = mt.get("off_days_of_month") or []
            for day in range(num_days):
                cal_date = start_date + timedelta(days=day)
                if cal_date.day in off_month:
                    for shift, pos, pos_name, slot_i in expanded:
                        model.add(assign[(mt["name"], day, shift["name"], pos_name, slot_i)] == 0)

    for shift, pos, pos_name, slot_i in expanded:
        if isinstance(pos, dict) and pos.get("regular_only"):
            for mt in mt_list:
                if mt.get("type") != "fulltime":
                    for day in range(num_days):
                        model.add(assign[(mt["name"], day, shift["name"], pos_name, slot_i)] == 0)

    for shift, pos, pos_name, slot_i in expanded:
        for mt in mt_list:
            if not _staff_can_work_position(mt, pos, catalog):
                for day in range(num_days):
                    model.add(assign[(mt["name"], day, shift["name"], pos_name, slot_i)] == 0)

    for shift in shift_list:
        for pos in shift.get("positions", []):
            if not isinstance(pos, dict):
                continue
            mpw = int(pos.get("max_per_week") or 0)
            if mpw <= 0:
                continue
            pos_name = pos["name"]
            slot_count = max(1, int(pos.get("slot_count", 1)))
            for mt in mt_list:
                day = 0
                while day < num_days:
                    week_days = list(range(day, min(day + 7, num_days)))
                    model.add(
                        sum(
                            assign.get((mt["name"], d, shift["name"], pos_name, si), 0)
                            for d in week_days
                            for si in range(slot_count)
                        )
                        <= mpw
                    )
                    day += 7

    # min/max shifts per month
    for mt in mt_list:
        total = sum(
            assign[(mt["name"], day, shift["name"], pos_name, slot_i)]
            for day in range(num_days)
            for shift, pos, pos_name, slot_i in expanded
        )
        mn = mt.get("min_shifts_per_month")
        mx = mt.get("max_shifts_per_month")
        if mn and int(mn) > 0:
            model.add(total >= int(mn))
        if mx and int(mx) > 0:
            model.add(total <= int(mx))

    # --- min_gap: sliding window — ใน N+1 วันต่อเนื่องทำได้ไม่เกิน 1 วัน (รองรับแยกตามกะ) ---
    def _apply_gap_rule(mt_name: str, g: int, shift_names: list[str] | None):
        if g <= 0:
            return
        if shift_names:
            shift_set = {s for s in (str(x).strip() for x in shift_names) if s}
            if not shift_set:
                shift_names = None
        if shift_names:
            # จำกัดเฉพาะกะใน shift_set
            for start_day in range(num_days - g):
                window_terms = []
                for d in range(g + 1):
                    day_idx = start_day + d
                    scoped_day_vars = [
                        assign[(mt_name, day_idx, shift["name"], pos_name, slot_i)]
                        for shift, pos, pos_name, slot_i in expanded
                        if shift["name"] in shift_set
                    ]
                    window_terms.append(sum(scoped_day_vars) if scoped_day_vars else 0)
                model.add(sum(window_terms) <= 1)
        else:
            # นับทุกกะ (เดิม)
            for start_day in range(num_days - g):
                window = [has_work[(mt_name, start_day + d)] for d in range(g + 1)]
                model.add(sum(window) <= 1)

    for mt in mt_list:
        mt_name = mt["name"]

        # 1) กฎใหม่: min_gap_rules = [{shift, gap_days}, ...]
        rules = mt.get("min_gap_rules") or []
        if isinstance(rules, list):
            for r in rules:
                if not isinstance(r, dict):
                    continue
                sh = str(r.get("shift") or "").strip()
                try:
                    g = int(r.get("gap_days") or 0)
                except Exception:
                    g = 0
                if sh and g > 0:
                    _apply_gap_rule(mt_name, g, [sh])

        # 2) backward compatible: min_gap_days + min_gap_shifts
        gap = mt.get("min_gap_days")
        try:
            g0 = int(gap) if gap is not None else 0
        except Exception:
            g0 = 0
        if g0 > 0:
            gap_shifts = mt.get("min_gap_shifts") or []
            gap_shifts = [str(s).strip() for s in gap_shifts if str(s).strip()]
            _apply_gap_rule(mt_name, g0, gap_shifts if gap_shifts else None)

    # --- Pair preferences ---
    # "apart": hard constraint — never same shift on same day
    # "together": soft — penalty when one works and the other doesn't on same day
    together_penalty_terms = []
    for p in pairs:
        n1, n2 = p["name_1"], p["name_2"]
        if n1 not in name_to_mt or n2 not in name_to_mt:
            continue
        if p["pair_type"] == "apart":
            for day in range(num_days):
                for shift, pos, pos_name, slot_i in expanded:
                    model.add(
                        assign[(n1, day, shift["name"], pos_name, slot_i)]
                        + assign[(n2, day, shift["name"], pos_name, slot_i)]
                        <= 1
                    )
        elif p["pair_type"] == "together":
            for day in range(num_days):
                if (n1, day) in has_work and (n2, day) in has_work:
                    diff = model.new_bool_var(f"pair_diff_{n1}_{n2}_d{day}")
                    model.add(has_work[(n1, day)] != has_work[(n2, day)]).only_enforce_if(diff)
                    model.add(has_work[(n1, day)] == has_work[(n2, day)]).only_enforce_if(diff.negated())
                    together_penalty_terms.append(diff)
        elif p["pair_type"] == "depends_on":
            # n2 ทำงานได้เฉพาะเวรเดียวกับ n1 (ถ้า n2 อยู่เวร S วัน D → n1 ต้องอยู่เวร S วัน D ด้วย)
            for day in range(num_days):
                for shift in shift_list:
                    sn = shift["name"]
                    n2_in_shift = [assign[(n2, day, sn, pn, si)] for s, _, pn, si in expanded if s["name"] == sn]
                    n1_in_shift = [assign[(n1, day, sn, pn, si)] for s, _, pn, si in expanded if s["name"] == sn]
                    if n2_in_shift and n1_in_shift:
                        model.add(sum(n2_in_shift) <= sum(n1_in_shift))

    # --- Max consecutive working days (default 5) ---
    MAX_CONSECUTIVE = 5
    consecutive_penalty_terms = []
    for mt in mt_list:
        for start_day in range(num_days - MAX_CONSECUTIVE):
            window = [has_work[(mt["name"], start_day + d)] for d in range(MAX_CONSECUTIVE + 1)]
            model.add(sum(window) <= MAX_CONSECUTIVE)
        # Soft penalty for 3+ consecutive days
        for start_day in range(num_days - 2):
            end_day = min(start_day + 3, num_days)
            if end_day - start_day == 3:
                consec = model.new_bool_var(f"consec_{mt['name'].replace(' ','_')}_d{start_day}")
                for d in range(start_day, end_day):
                    model.add(has_work[(mt["name"], d)] >= 1).only_enforce_if(consec)
                consecutive_penalty_terms.append(consec)

    # Balance
    total_per_mt = []
    for mt in mt_list:
        total = sum(
            assign[(mt["name"], day, shift["name"], pos_name, slot_i)]
            for day in range(num_days)
            for shift, pos, pos_name, slot_i in expanded
        )
        total_per_mt.append(total)
    n_slots = len(expanded) * num_days
    max_s = model.new_int_var(0, n_slots, "max_s")
    min_s = model.new_int_var(0, n_slots, "min_s")
    if total_per_mt:
        model.add_max_equality(max_s, total_per_mt)
        model.add_min_equality(min_s, total_per_mt)
    else:
        model.add(max_s == 0)
        model.add(min_s == 0)

    tw_balance_terms = []
    all_tw = set()
    for shift, pos, pos_name, slot_i in expanded:
        tw = isinstance(pos, dict) and (pos.get("time_window_name") or "").strip() or None
        if tw:
            all_tw.add(tw)

    for tw_idx, tw in enumerate(sorted(all_tw)):
        eligible_mts = [
            mt for mt in mt_list
            if any(_window_contains(catalog, sw, tw) for sw in (mt.get("time_windows") or []))
        ]
        if len(eligible_mts) < 2:
            continue
        tw_positions = [
            (shift, pos, pos_name, slot_i) for shift, pos, pos_name, slot_i in expanded
            if isinstance(pos, dict) and (pos.get("time_window_name") or "").strip() == tw
        ]
        if not tw_positions:
            continue
        tw_count_per_mt = []
        for mt in eligible_mts:
            cnt = sum(
                assign[(mt["name"], day, shift["name"], pos_name, slot_i)]
                for day in range(num_days)
                for shift, pos, pos_name, slot_i in tw_positions
            )
            tw_count_per_mt.append(cnt)
        tw_max = model.new_int_var(0, num_days, f"tw_max_{tw_idx}")
        tw_min = model.new_int_var(0, num_days, f"tw_min_{tw_idx}")
        model.add_max_equality(tw_max, tw_count_per_mt)
        model.add_min_equality(tw_min, tw_count_per_mt)
        tw_balance_terms.append(tw_max - tw_min)

    DUMMY_PENALTY = 10000
    dummy_terms = [
        assign[(DUMMY_WORKER, day, shift["name"], pos_name, slot_i)]
        for day in range(num_days)
        for shift, pos, pos_name, slot_i in expanded
        if _is_shift_active_on_day(shift, day, start_date, holiday_set)
    ]

    balance_obj = (max_s - min_s) * 10 + sum(tw_balance_terms) if tw_balance_terms else (max_s - min_s)
    spacing_obj = sum(consecutive_penalty_terms) * 5 if consecutive_penalty_terms else 0
    together_obj = sum(together_penalty_terms) * 3 if together_penalty_terms else 0
    total_obj = balance_obj + spacing_obj + together_obj
    if dummy_terms:
        model.minimize(total_obj + sum(dummy_terms) * DUMMY_PENALTY)
    else:
        model.minimize(total_obj)

    solver = cp_model.CpSolver()
    solver.parameters.max_time_in_seconds = timeout_seconds
    status = solver.solve(model)

    slots = []
    if status in (cp_model.OPTIMAL, cp_model.FEASIBLE):
        for day in range(num_days):
            for shift, pos, pos_name, slot_i in expanded:
                if not _is_shift_active_on_day(shift, day, start_date, holiday_set):
                    continue
                for mt in all_mt:
                    if solver.value(assign[(mt["name"], day, shift["name"], pos_name, slot_i)]) == 1:
                        tw = isinstance(pos, dict) and (pos.get("time_window_name") or "").strip() or None
                        slots.append({
                            "staff_name": mt["name"],
                            "day": day,
                            "shift_name": shift["name"],
                            "position": pos_name,
                            "slot_index": slot_i,
                            "time_window": tw,
                            "is_dummy": mt["name"] == DUMMY_WORKER,
                        })
                        break
    return slots, solver, status
