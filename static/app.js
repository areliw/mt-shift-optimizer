const API = "/api";

const THAI_MONTHS = ["ม.ค.", "ก.พ.", "มี.ค.", "เม.ย.", "พ.ค.", "มิ.ย.", "ก.ค.", "ส.ค.", "ก.ย.", "ต.ค.", "พ.ย.", "ธ.ค."];

function formatDayLabel(dayIndex, startDate) {
  if (!startDate) return "วันที่ " + (dayIndex + 1);
  const [y, m, d] = startDate.split("-").map(Number);
  const date = new Date(y, m - 1, d + dayIndex);
  const day = date.getDate();
  const month = THAI_MONTHS[date.getMonth()];
  const year = date.getFullYear() + 543;
  return day + " " + month + " " + year;
}

async function getSettings() {
  const r = await fetch(API + "/settings");
  return r.json();
}

async function loadStaff() {
  const r = await fetch(API + "/staff");
  return r.json();
}

async function loadShifts() {
  const r = await fetch(API + "/shifts");
  return r.json();
}

async function loadLatestSchedule() {
  const r = await fetch(API + "/schedule/latest");
  if (r.status === 404) return null;
  return r.json();
}

function renderStaffList(items) {
  const ul = document.getElementById("staff_list");
  ul.innerHTML = items
    .map(
      (s) =>
        `<li data-id="${s.id}">
          <span class="name">${escapeHtml(s.name)} (${s.type}) — skills: ${(s.skills || []).join(", ") || "-"} | off: [${(s.off_days || []).join(", ")}]</span>
          <button class="small btn-delete-staff" data-id="${s.id}">ลบ</button>
        </li>`
    )
    .join("");
  ul.querySelectorAll(".btn-delete-staff").forEach((btn) => {
    btn.addEventListener("click", async () => {
      if (!confirm("ลบคนนี้?")) return;
      await fetch(API + "/staff/" + btn.dataset.id, { method: "DELETE" });
      refreshStaff();
    });
  });
}

function renderShiftList(items) {
  const ul = document.getElementById("shift_list");
  ul.innerHTML = items
    .map(
      (s) =>
        `<li data-id="${s.id}">
          <span class="name">${escapeHtml(s.name)} — donor: ${s.donor}, xmatch: ${s.xmatch}</span>
          <button class="small btn-delete-shift" data-id="${s.id}">ลบ</button>
        </li>`
    )
    .join("");
  ul.querySelectorAll(".btn-delete-shift").forEach((btn) => {
    btn.addEventListener("click", async () => {
      if (!confirm("ลบกะนี้?")) return;
      await fetch(API + "/shifts/" + btn.dataset.id, { method: "DELETE" });
      refreshShifts();
    });
  });
}

function escapeHtml(s) {
  const div = document.createElement("div");
  div.textContent = s;
  return div.innerHTML;
}

function renderSchedule(data) {
  const meta = document.getElementById("schedule_meta");
  const wrap = document.getElementById("schedule_table_wrap");
  const exportLink = document.getElementById("export_csv");
  if (!data) {
    meta.textContent = "ยังไม่มีตาราง — กด \"สร้างตารางเวร\" เพื่อสร้าง";
    wrap.innerHTML = "";
    exportLink.style.display = "none";
    return;
  }
  const startDate = data.start_date || null;
  const maxDayInSlots = data.slots.length ? Math.max(...data.slots.map((s) => s.day), 0) + 1 : 0;
  const displayDays = Math.max(data.num_days || 0, maxDayInSlots);
  const dateRange = startDate && displayDays > 0
    ? formatDayLabel(0, startDate) + " – " + formatDayLabel(displayDays - 1, startDate)
    : "";
  meta.textContent = `Run #${data.run_id} — สร้างเมื่อ ${data.created_at} (${displayDays} วัน)${dateRange ? " · " + dateRange : ""}`;
  exportLink.href = API + "/schedule/export/csv?run_id=" + data.run_id;
  exportLink.style.display = "inline";

  const days = [];
  for (let d = 0; d < displayDays; d++) days.push(d);
  const shiftNames = [...new Set(data.slots.map((s) => s.shift_name))].sort();
  const byDayShiftRoom = {};
  data.slots.forEach((s) => {
    const key = `${s.day}-${s.shift_name}-${s.room}`;
    if (!byDayShiftRoom[key]) byDayShiftRoom[key] = [];
    byDayShiftRoom[key].push(s.staff_name);
  });

  let html = "<table><thead><tr><th>วัน</th>";
  shiftNames.forEach((sn) => {
    html += `<th colspan="2">${escapeHtml(sn)}</th>`;
  });
  html += "</tr><tr><th></th>";
  shiftNames.forEach(() => {
    html += "<th>Donor</th><th>Xmatch</th>";
  });
  html += "</tr></thead><tbody>";
  days.forEach((day) => {
    const dayLabel = formatDayLabel(day, startDate);
    html += `<tr><td>${escapeHtml(dayLabel)}</td>`;
    shiftNames.forEach((sn) => {
      const donor = (byDayShiftRoom[`${day}-${sn}-donor`] || []).join(", ");
      const xmatch = (byDayShiftRoom[`${day}-${sn}-xmatch`] || []).join(", ");
      html += `<td>${escapeHtml(donor)}</td><td>${escapeHtml(xmatch)}</td>`;
    });
    html += "</tr>";
  });
  html += "</tbody></table>";
  wrap.innerHTML = html;
}

async function refreshStaff() {
  const list = await loadStaff();
  renderStaffList(list);
}

async function refreshShifts() {
  const list = await loadShifts();
  renderShiftList(list);
}

async function refreshSettings() {
  const s = await getSettings();
  const n = Number(s.num_days);
  if (!isNaN(n) && n >= 1 && n <= 31) {
    document.getElementById("num_days").value = n;
  }
  if (s.schedule_start_date != null && s.schedule_start_date !== "") {
    document.getElementById("schedule_start_date").value = s.schedule_start_date;
  }
}

async function refreshSchedule() {
  try {
    const data = await loadLatestSchedule();
    renderSchedule(data);
  } catch {
    renderSchedule(null);
  }
}

function fillPresetYear() {
  const sel = document.getElementById("preset_year");
  const y = new Date().getFullYear();
  sel.innerHTML = "";
  for (let i = y - 1; i <= y + 2; i++) {
    const opt = document.createElement("option");
    opt.value = i;
    opt.textContent = i + 543;
    if (i === y) opt.selected = true;
    sel.appendChild(opt);
  }
}

document.getElementById("save_settings").addEventListener("click", async () => {
  const num_days = parseInt(document.getElementById("num_days").value, 10);
  const schedule_start_date = document.getElementById("schedule_start_date").value.trim();
  if (isNaN(num_days) || num_days < 1) {
    alert("กรอกจำนวนวันเป็นตัวเลขที่ถูกต้อง");
    return;
  }
  await fetch(API + "/settings", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ num_days, schedule_start_date: schedule_start_date || "" }),
  });
  document.getElementById("run_message").textContent = "บันทึกตั้งค่าแล้ว";
  document.getElementById("run_message").className = "message success";
});

document.getElementById("apply_month").addEventListener("click", async () => {
  const month = document.getElementById("preset_month").value;
  const year = document.getElementById("preset_year").value;
  if (!month || !year) {
    alert("เลือกเดือนและปี");
    return;
  }
  const y = parseInt(year, 10);
  const m = parseInt(month, 10);
  const first = `${y}-${String(m).padStart(2, "0")}-01`;
  const lastDay = new Date(y, m, 0).getDate();
  document.getElementById("num_days").value = lastDay;
  document.getElementById("schedule_start_date").value = first;
  await fetch(API + "/settings", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ num_days: lastDay, schedule_start_date: first }),
  });
  await refreshSettings();
  document.getElementById("num_days").value = lastDay;
  document.getElementById("schedule_start_date").value = first;
  document.getElementById("run_message").textContent = "ตั้งเป็นทั้งเดือน " + month + "/" + year + " (" + lastDay + " วัน) แล้ว";
  document.getElementById("run_message").className = "message success";
});

document.getElementById("add_staff").addEventListener("click", async () => {
  const name = document.getElementById("staff_name").value.trim();
  if (!name) {
    alert("กรอกชื่อ");
    return;
  }
  const type = document.getElementById("staff_type").value;
  const skills = [];
  if (document.getElementById("skill_donor").checked) skills.push("donor");
  if (document.getElementById("skill_xmatch").checked) skills.push("xmatch");
  const offDaysStr = document.getElementById("staff_off_days").value.trim();
  const off_days = offDaysStr ? offDaysStr.split(",").map((x) => parseInt(x.trim(), 10)).filter((n) => !isNaN(n)) : [];
  await fetch(API + "/staff", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, type, off_days: off_days, skills }),
  });
  document.getElementById("staff_name").value = "";
  document.getElementById("staff_off_days").value = "";
  document.getElementById("skill_donor").checked = false;
  document.getElementById("skill_xmatch").checked = false;
  refreshStaff();
});

document.getElementById("add_shift").addEventListener("click", async () => {
  const name = document.getElementById("shift_name").value.trim();
  if (!name) {
    alert("กรอกชื่อกะ");
    return;
  }
  const donor = parseInt(document.getElementById("shift_donor").value, 10) || 1;
  const xmatch = parseInt(document.getElementById("shift_xmatch").value, 10) || 1;
  await fetch(API + "/shifts", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, donor, xmatch }),
  });
  document.getElementById("shift_name").value = "";
  refreshShifts();
});

document.getElementById("run_schedule").addEventListener("click", async () => {
  const msg = document.getElementById("run_message");
  msg.textContent = "กำลังสร้างตาราง...";
  msg.className = "message";
  const presetMonth = document.getElementById("preset_month").value;
  const presetYear = document.getElementById("preset_year").value;
  let num_days;
  let schedule_start_date;
  if (presetMonth && presetYear) {
    const y = parseInt(presetYear, 10);
    const m = parseInt(presetMonth, 10);
    schedule_start_date = `${y}-${String(m).padStart(2, "0")}-01`;
    num_days = new Date(y, m, 0).getDate();
    document.getElementById("num_days").value = num_days;
    document.getElementById("schedule_start_date").value = schedule_start_date;
  } else {
    const numDaysRaw = document.getElementById("num_days").value;
    num_days = parseInt(String(numDaysRaw || "").trim(), 10);
    schedule_start_date = document.getElementById("schedule_start_date").value.trim();
    if (!numDaysRaw || isNaN(num_days) || num_days < 1 || num_days > 31) {
      try {
        const s = await getSettings();
        const fromApi = Number(s.num_days);
        if (!isNaN(fromApi) && fromApi >= 1 && fromApi <= 31) {
          num_days = Math.floor(fromApi);
          document.getElementById("num_days").value = num_days;
        } else {
          msg.textContent = "กรอกจำนวนวัน 1–31 หรือเลือก \"ใช้ทั้งเดือน\"";
          msg.className = "message error";
          return;
        }
      } catch {
        msg.textContent = "กรอกจำนวนวันเป็นตัวเลข 1–31 ในช่อง \"จำนวนวัน\"";
        msg.className = "message error";
        return;
      }
    }
  }
  try {
    const q = new URLSearchParams();
    if (num_days != null && num_days !== "") q.set("num_days", String(num_days));
    if (schedule_start_date) q.set("schedule_start_date", schedule_start_date);
    const url = API + "/schedule/run" + (q.toString() ? "?" + q.toString() : "");
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ num_days, schedule_start_date: schedule_start_date || null }),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      msg.textContent = data.detail || r.statusText || "เกิดข้อผิดพลาด";
      msg.className = "message error";
      return;
    }
    msg.textContent = "สร้างตารางเรียบร้อย (Run #" + data.run_id + ")";
    msg.className = "message success";
    await refreshSettings();
    refreshSchedule();
  } catch (e) {
    msg.textContent = "Error: " + e.message;
    msg.className = "message error";
  }
});

async function init() {
  fillPresetYear();
  await refreshSettings();
  await refreshStaff();
  await refreshShifts();
  await refreshSchedule();
}

init();
