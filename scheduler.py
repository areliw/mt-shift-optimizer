# scheduler.py

from ortools.sat.python import cp_model
from database import get_mt_list, get_shift_list, get_num_days


def generate_schedule(num_days=None):
    mt_list = get_mt_list()
    shift_list = get_shift_list()
    if num_days is None:
        num_days = get_num_days()
    model = cp_model.CpModel()

    # assign[(mt, day, shift_name, position)] = 1 if mt is assigned to (day, shift, position)
    assign = {}
    for mt in mt_list:
        for day in range(num_days):
            for shift in shift_list:
                for pos in shift["positions"]:
                    pos_name = pos["name"] if isinstance(pos, dict) else pos
                    assign[(mt["name"], day, shift["name"], pos_name)] = model.new_bool_var(
                        f"{mt['name']}_d{day}_{shift['name']}_{pos_name}"
                    )

    # Each (day, shift, position) gets exactly one staff
    for day in range(num_days):
        for shift in shift_list:
            for pos in shift["positions"]:
                pos_name = pos["name"] if isinstance(pos, dict) else pos
                model.add(
                    sum(assign[(mt["name"], day, shift["name"], pos_name)] for mt in mt_list)
                    == 1
                )

    # Each staff at most one assignment per day (across all shifts/positions)
    for mt in mt_list:
        for day in range(num_days):
            model.add(
                sum(
                    assign[(mt["name"], day, shift["name"], pos["name"] if isinstance(pos, dict) else pos)]
                    for shift in shift_list
                    for pos in shift["positions"]
                )
                <= 1
            )

    # Off days: no assignment
    for mt in mt_list:
        for day in mt["off_days"]:
            if day < num_days:
                for shift in shift_list:
                    for pos in shift["positions"]:
                        pos_name = pos["name"] if isinstance(pos, dict) else pos
                        model.add(assign[(mt["name"], day, shift["name"], pos_name)] == 0)

    # regular_only: only fulltime staff for positions with regular_only
    for shift in shift_list:
        for pos in shift["positions"]:
            if isinstance(pos, dict) and pos.get("regular_only"):
                pos_name = pos["name"]
                for mt in mt_list:
                    if mt.get("type") != "fulltime":
                        for day in range(num_days):
                            model.add(assign[(mt["name"], day, shift["name"], pos_name)] == 0)

    # Balance: minimize (max - min) assignments per staff
    total_per_mt = []
    for mt in mt_list:
        total = sum(
            assign[(mt["name"], day, shift["name"], pos["name"] if isinstance(pos, dict) else pos)]
            for day in range(num_days)
            for shift in shift_list
            for pos in shift["positions"]
        )
        total_per_mt.append(total)
    n_slots = sum(len(s["positions"]) for s in shift_list) * num_days
    max_s = model.new_int_var(0, n_slots, "max_s")
    min_s = model.new_int_var(0, n_slots, "min_s")
    model.add_max_equality(max_s, total_per_mt)
    model.add_min_equality(min_s, total_per_mt)
    model.minimize(max_s - min_s)

    solver = cp_model.CpSolver()
    status = solver.solve(model)

    # Build slots list: (staff_name, day, shift_name, position)
    slots = []
    for day in range(num_days):
        for shift in shift_list:
            for pos in shift["positions"]:
                pos_name = pos["name"] if isinstance(pos, dict) else pos
                for mt in mt_list:
                    if solver.value(assign[(mt["name"], day, shift["name"], pos_name)]) == 1:
                        slots.append({
                            "staff_name": mt["name"],
                            "day": day,
                            "shift_name": shift["name"],
                            "position": pos_name,
                        })
                        break
    return slots, solver, status
