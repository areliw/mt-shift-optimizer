# scheduler.py

from ortools.sat.python import cp_model
from database import get_mt_list, get_shift_list, get_num_days


def generate_schedule(num_days=None):
    mt_list = get_mt_list()
    shift_list = get_shift_list()
    if num_days is None:
        num_days = get_num_days()
    model = cp_model.CpModel()

    # shifts[(mt, day, shift)] = ทำกะนี้ไหม
    shifts = {}
    for mt in mt_list:
        for day in range(num_days):
            for shift in shift_list:
                shifts[(mt["name"], day, shift["name"])] = model.new_bool_var(f"{mt['name']}_day{day}_{shift['name']}")

    # rooms[(mt, day, shift, room)] = อยู่ห้องนี้ไหม
    rooms = {}
    for mt in mt_list:
        for day in range(num_days):
            for shift in shift_list:
                for room in ["donor", "xmatch"]:
                    rooms[(mt["name"], day, shift["name"], room)] = model.new_bool_var(f"{mt['name']}_day{day}_{shift['name']}_{room}")

    # ถ้าทำกะนี้ → ต้องอยู่ห้องใดห้องหนึ่ง
    for mt in mt_list:
        for day in range(num_days):
            for shift in shift_list:
                model.add(
                    rooms[(mt["name"], day, shift["name"], "donor")] +
                    rooms[(mt["name"], day, shift["name"], "xmatch")] ==
                    shifts[(mt["name"], day, shift["name"])]
                )

    # ห้ามอยู่ห้องที่ไม่มี skill
    for mt in mt_list:
        for day in range(num_days):
            for shift in shift_list:
                for room in ["donor", "xmatch"]:
                    if room not in mt["skills"]:
                        model.add(rooms[(mt["name"], day, shift["name"], room)] == 0)

    # แต่ละคนทำได้แค่ 1 กะต่อวัน
    for mt in mt_list:
        for day in range(num_days):
            model.add(sum(shifts[(mt["name"], day, shift["name"])] for shift in shift_list) <= 1)

    # ห้ามทำงานในวันหยุด
    for mt in mt_list:
        for day in mt["off_days"]:
            for shift in shift_list:
                model.add(shifts[(mt["name"], day, shift["name"])] == 0)

    # แต่ละห้องต้องมี MT ครบ
    for day in range(num_days):
        for shift in shift_list:
            model.add(sum(rooms[(mt["name"], day, shift["name"], "donor")] for mt in mt_list) == shift["donor"])
            model.add(sum(rooms[(mt["name"], day, shift["name"], "xmatch")] for mt in mt_list) == shift["xmatch"])

    # กระจายเวรให้เท่ากัน
    total_shifts = []
    for mt in mt_list:
        total = sum(shifts[(mt["name"], day, shift["name"])] for day in range(num_days) for shift in shift_list)
        total_shifts.append(total)

    max_s = model.new_int_var(0, num_days * len(shift_list), "max_s")
    min_s = model.new_int_var(0, num_days * len(shift_list), "min_s")
    model.add_max_equality(max_s, total_shifts)
    model.add_min_equality(min_s, total_shifts)
    model.minimize(max_s - min_s)

    solver = cp_model.CpSolver()
    status = solver.solve(model)

    return shifts, rooms, solver, status