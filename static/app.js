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

const DAY_NAMES = ["จันทร์", "อังคาร", "พุธ", "พฤหัสบดี", "ศุกร์", "เสาร์", "อาทิตย์"];

function renderStaffDetailContent(staff) {
  const typeLabel = staff.type === "fulltime" ? "เต็มเวลา" : "พาร์ทไทม์";
  const offLabel = staff.off_days && staff.off_days.length
    ? staff.off_days.map((d) => (DAY_NAMES[d] != null ? DAY_NAMES[d] : "วัน " + d)).join(", ")
    : "ไม่มี";
  const skillsLabel = staff.skills && staff.skills.length ? staff.skills.join(", ") : "—";
  return (
    "<dl class=\"staff-detail-dl\">" +
    "<dt>ชื่อ</dt><dd>" + escapeHtml(staff.name) + "</dd>" +
    "<dt>ประเภท</dt><dd>" + escapeHtml(typeLabel) + "</dd>" +
    "<dt>วันหยุด (0–6)</dt><dd>" + escapeHtml(offLabel) + "</dd>" +
    "<dt>Skills</dt><dd>" + escapeHtml(skillsLabel) + "</dd>" +
    "</dl>"
  );
}

async function showStaffDetail(staffId) {
  const loadingEl = document.getElementById("staff_detail_loading");
  const contentEl = document.getElementById("staff_detail_content");
  const emptyEl = document.getElementById("staff_detail_empty");
  emptyEl.style.display = "none";
  contentEl.style.display = "none";
  loadingEl.style.display = "block";
  contentEl.innerHTML = "";

  document.querySelectorAll("#staff_list li").forEach((li) => {
    li.classList.toggle("active", parseInt(li.dataset.id, 10) === staffId);
  });

  try {
    const r = await fetch(API + "/staff/" + staffId);
    if (!r.ok) {
      contentEl.innerHTML = "<p class=\"message error\">โหลดข้อมูลไม่สำเร็จ</p>";
      contentEl.style.display = "";
      loadingEl.style.display = "none";
      return;
    }
    const staff = await r.json();
    contentEl.innerHTML = renderStaffDetailContent(staff);
    contentEl.style.display = "";
  } catch (e) {
    contentEl.innerHTML = "<p class=\"message error\">เกิดข้อผิดพลาด: " + escapeHtml(e.message) + "</p>";
    contentEl.style.display = "";
  }
  loadingEl.style.display = "none";
}

function renderStaffList(items) {
  const ul = document.getElementById("staff_list");
  ul.innerHTML = items
    .map(
      (s) =>
        `<li data-id="${s.id}" class="staff-sidebar-item">
          <span class="staff-sidebar-name">${escapeHtml(s.name)}</span>
          <button type="button" class="small btn-delete-staff" data-id="${s.id}" title="ลบ">ลบ</button>
        </li>`
    )
    .join("");
  ul.querySelectorAll(".staff-sidebar-item").forEach((li) => {
    const id = parseInt(li.dataset.id, 10);
    li.querySelector(".staff-sidebar-name").addEventListener("click", () => showStaffDetail(id));
  });
  ul.querySelectorAll(".btn-delete-staff").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      if (!confirm("ลบคนนี้?")) return;
      await fetch(API + "/staff/" + btn.dataset.id, { method: "DELETE" });
      document.getElementById("staff_detail_empty").style.display = "";
      document.getElementById("staff_detail_content").style.display = "none";
      refreshStaff();
    });
  });
}

function renderShiftList(items) {
  const ul = document.getElementById("shift_list");
  ul.innerHTML = items
    .map((s) => {
      const posLabel = s.positions && s.positions.length
        ? s.positions.map((p) => (typeof p === "string" ? p : p.name)).join(", ")
        : `donor: ${s.donor ?? 0}, xmatch: ${s.xmatch ?? 0}`;
      return `<li data-id="${s.id}">
          <span class="name">${escapeHtml(s.name)} — ${escapeHtml(posLabel)}</span>
          <button class="small btn-delete-shift" data-id="${s.id}">ลบ</button>
        </li>`;
    })
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
  const posKey = data.slots.length && data.slots[0].position != null ? "position" : "room";
  const byDayShiftPos = {};
  data.slots.forEach((s) => {
    const pos = s[posKey] || s.room || s.position || "";
    const key = `${s.day}-${s.shift_name}-${pos}`;
    if (!byDayShiftPos[key]) byDayShiftPos[key] = [];
    const cell = s.time_window ? `${s.staff_name} (${s.time_window})` : s.staff_name;
    byDayShiftPos[key].push(cell);
  });
  const shiftPositions = {};
  data.slots.forEach((s) => {
    const sn = s.shift_name;
    const pos = s[posKey] || s.room || s.position || "";
    if (!shiftPositions[sn]) shiftPositions[sn] = [];
    if (!shiftPositions[sn].includes(pos)) shiftPositions[sn].push(pos);
  });
  const shiftNames = Object.keys(shiftPositions).sort();
  shiftNames.forEach((sn) => shiftPositions[sn].sort());

  let html = "<table><thead><tr><th>วัน</th>";
  shiftNames.forEach((sn) => {
    const cols = (shiftPositions[sn] || []).length || 1;
    html += `<th colspan="${cols}">${escapeHtml(sn)}</th>`;
  });
  html += "</tr><tr><th></th>";
  shiftNames.forEach((sn) => {
    (shiftPositions[sn] || ["ช่อง"]).forEach((pos) => {
      html += `<th>${escapeHtml(pos)}</th>`;
    });
  });
  html += "</tr></thead><tbody>";
  days.forEach((day) => {
    const dayLabel = formatDayLabel(day, startDate);
    html += `<tr><td>${escapeHtml(dayLabel)}</td>`;
    shiftNames.forEach((sn) => {
      (shiftPositions[sn] || []).forEach((pos) => {
        const cell = (byDayShiftPos[`${day}-${sn}-${pos}`] || []).join(", ");
        html += `<td>${escapeHtml(cell)}</td>`;
      });
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
  const offDaysStr = document.getElementById("staff_off_days").value.trim();
  const off_days = offDaysStr ? offDaysStr.split(",").map((x) => parseInt(x.trim(), 10)).filter((n) => !isNaN(n)) : [];
  await fetch(API + "/staff", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, type, off_days: off_days, skills: [] }),
  });
  document.getElementById("staff_name").value = "";
  document.getElementById("staff_off_days").value = "";
  refreshStaff();
});

function addPositionRow(name = "", note = "") {
  const list = document.getElementById("shift_positions_list");
  const div = document.createElement("div");
  div.className = "shift-position-row";
  div.style.marginBottom = "0.25rem";
  const nameIn = document.createElement("input");
  nameIn.type = "text";
  nameIn.className = "position-name";
  nameIn.placeholder = "ชื่อช่อง";
  nameIn.size = 12;
  nameIn.value = name;
  const noteIn = document.createElement("input");
  noteIn.type = "text";
  noteIn.className = "position-note";
  noteIn.placeholder = "หมายเหตุ (ถ้ามี)";
  noteIn.size = 20;
  noteIn.value = note;
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "small btn-remove-position";
  btn.textContent = "ลบ";
  btn.addEventListener("click", () => div.remove());
  div.appendChild(nameIn);
  div.appendChild(document.createTextNode(" "));
  div.appendChild(noteIn);
  div.appendChild(document.createTextNode(" "));
  div.appendChild(btn);
  list.appendChild(div);
}

function collectShiftPositions() {
  const rows = document.querySelectorAll("#shift_positions_list .shift-position-row");
  const positions = [];
  rows.forEach((row) => {
    const name = (row.querySelector(".position-name") && row.querySelector(".position-name").value.trim()) || "";
    const note = (row.querySelector(".position-note") && row.querySelector(".position-note").value.trim()) || "";
    if (name) positions.push({ name, constraint_note: note, regular_only: false });
  });
  return positions;
}

document.getElementById("add_position_row").addEventListener("click", () => addPositionRow());

document.getElementById("add_shift").addEventListener("click", async () => {
  const name = document.getElementById("shift_name").value.trim();
  if (!name) {
    alert("กรอกชื่อกะ");
    return;
  }
  let positions = collectShiftPositions();
  if (positions.length === 0) positions = [{ name: "ช่อง 1", constraint_note: "", regular_only: false }];
  await fetch(API + "/shifts", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, positions }),
  });
  document.getElementById("shift_name").value = "";
  document.getElementById("shift_positions_list").innerHTML = "";
  addPositionRow();
  refreshShifts();
});

async function applyTemplate(templateId) {
  const r = await fetch(API + "/apply-template?template=" + templateId, { method: "POST" });
  if (!r.ok) {
    const d = await r.json().catch(() => ({}));
    alert(d.detail || r.statusText || "โหลดเทมเพลตไม่สำเร็จ");
    return;
  }
  await refreshStaff();
  await refreshShifts();
}

document.getElementById("template_1").addEventListener("click", () => applyTemplate(1));
document.getElementById("template_2").addEventListener("click", () => applyTemplate(2));
document.getElementById("template_3").addEventListener("click", () => applyTemplate(3));

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
    showPage("schedule");
  } catch (e) {
    msg.textContent = "Error: " + e.message;
    msg.className = "message error";
  }
});

function showPage(pageId) {
  document.querySelectorAll(".app-page").forEach((el) => {
    el.style.display = el.id === "page-" + pageId ? "" : "none";
  });
  document.querySelectorAll(".app-nav-item").forEach((a) => {
    a.classList.toggle("active", a.dataset.page === pageId);
  });
}

document.querySelectorAll(".app-nav-item").forEach((a) => {
  a.addEventListener("click", (e) => {
    e.preventDefault();
    showPage(a.dataset.page);
  });
});

async function init() {
  fillPresetYear();
  addPositionRow();
  showPage("settings");
  await refreshSettings();
  await refreshStaff();
  await refreshShifts();
  await refreshSchedule();
}

init();
