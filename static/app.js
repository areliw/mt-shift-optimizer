// Extract workspace ID from URL: /w/{workspace_id}/...
const _pathParts = window.location.pathname.split('/');
const WORKSPACE_ID = (_pathParts[1] === 'w' && _pathParts[2]) ? _pathParts[2] : '';
const API = WORKSPACE_ID ? "/w/" + WORKSPACE_ID + "/api" : "/api";

// ถ้า URL hash มี #t=TOKEN → บันทึก token ลง localStorage แล้วลบออกจาก URL
(function() {
  if (!WORKSPACE_ID) return;
  const hash = window.location.hash;
  const m = hash.match(/[#&]t=([0-9a-f]+)/i);
  if (m) {
    try {
      const tokens = JSON.parse(localStorage.getItem('ws_tokens') || '{}');
      tokens[WORKSPACE_ID] = m[1];
      localStorage.setItem('ws_tokens', JSON.stringify(tokens));
    } catch {}
    // ลบ hash ออกจาก URL โดยไม่ reload
    history.replaceState(null, '', window.location.pathname + window.location.search);
  }
})();

// Inject X-Workspace-Token on every request to this workspace
(function() {
  const _WS_PREFIX = WORKSPACE_ID ? '/w/' + WORKSPACE_ID + '/' : null;
  const _wsToken = (() => {
    try { return JSON.parse(localStorage.getItem('ws_tokens') || '{}')[WORKSPACE_ID] || ''; }
    catch { return ''; }
  })();
  if (!_WS_PREFIX || !_wsToken) return;
  const _origFetch = window.fetch.bind(window);
  window.fetch = function(url, opts) {
    opts = Object.assign({}, opts);
    const urlStr = typeof url === 'string' ? url : (url && url.url) || '';
    if (urlStr.startsWith(_WS_PREFIX) || urlStr.startsWith('/w/' + WORKSPACE_ID + '/api')) {
      opts.headers = Object.assign({'X-Workspace-Token': _wsToken}, opts.headers || {});
    }
    return _origFetch(url, opts);
  };
})();

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

async function loadSkills() {
  const r = await fetch(API + "/skills");
  return r.json();
}

async function loadTitles() {
  const r = await fetch(API + "/titles");
  return r.json();
}

async function loadLatestSchedule() {
  const r = await fetch(API + "/schedule/latest");
  if (r.status === 404) return null;
  return r.json();
}

const DAY_NAMES = ["จันทร์", "อังคาร", "พุธ", "พฤหัสบดี", "ศุกร์", "เสาร์", "อาทิตย์"];

// Shift editor state
let shiftsCache = [];
let currentShiftId = null;

function parseOffDaysOfMonth(str) {
  if (!str || typeof str !== "string") return [];
  return str
    .split(/[\s,]+/)
    .map((s) => parseInt(s.trim(), 10))
    .filter((n) => !isNaN(n) && n >= 1 && n <= 31);
}

function workDaysToOffDays(workDays, totalDays) {
  const workSet = new Set(workDays);
  const off = [];
  for (let d = 1; d <= totalDays; d++) {
    if (!workSet.has(d)) off.push(d);
  }
  return off;
}

function offDaysToWorkDays(offDays, totalDays) {
  const offSet = new Set(offDays);
  const work = [];
  for (let d = 1; d <= totalDays; d++) {
    if (!offSet.has(d)) work.push(d);
  }
  return work;
}

function getMonthTotalDays() {
  const startEl = document.getElementById("schedule_start_date");
  const numEl = document.getElementById("num_days");
  const numDays = numEl ? parseInt(numEl.value, 10) : 0;
  if (startEl && startEl.value) {
    const [y, m] = startEl.value.split("-").map(Number);
    if (y && m) return new Date(y, m, 0).getDate();
  }
  return numDays > 0 ? numDays : 31;
}

function renderStaffDetailContent(staff) {
  const typeLabel = staff.type === "fulltime" ? "เต็มเวลา" : "พาร์ทไทม์";
  const offLabel = staff.off_days && staff.off_days.length
    ? staff.off_days.map((d) => (DAY_NAMES[d] != null ? DAY_NAMES[d] : "วัน " + d)).join(", ")
    : "ไม่มี";
  const offMonthLabel = (staff.off_days_of_month && staff.off_days_of_month.length)
    ? staff.off_days_of_month.sort((a, b) => a - b).join(", ")
    : "ไม่มี";
  const skillLevels = staff.skill_levels || {};
  const skillsLabel = staff.skills && staff.skills.length
    ? staff.skills.map((s) => {
        const lvl = skillLevels[s] || 1;
        const labels = getSkillLevelLabels(s);
        const lvlName = labels[lvl] || ("ระดับ " + lvl);
        return escapeHtml(s) + " (" + escapeHtml(lvlName) + ")";
      }).join(", ")
    : "—";
  const timeWindowsLabel = (staff.time_windows && staff.time_windows.length) ? staff.time_windows.join(", ") : "—";
  const gapShiftsLabel = (staff.min_gap_shifts && staff.min_gap_shifts.length) ? staff.min_gap_shifts.join(", ") : "";
  const gapRulesLabel = (staff.min_gap_rules && staff.min_gap_rules.length)
    ? staff.min_gap_rules.map((r) => `${r.shift}: ${r.gap_days} วัน`).join(", ")
    : "";
  return (
    "<dl class=\"staff-detail-dl\">" +
    "<dt>ชื่อ</dt><dd>" + escapeHtml(staff.name) + "</dd>" +
    "<dt>ตำแหน่ง</dt><dd>" + escapeHtml(typeLabel) + "</dd>" +
    "</dl>" +
    "<hr class=\"detail-divider\" />" +
    "<dl class=\"staff-detail-dl\">" +
    "<dt>หยุดประจำสัปดาห์</dt><dd>" + escapeHtml(offLabel) + "</dd>" +
    "<dt>หยุดรายเดือน</dt><dd>" + escapeHtml(offMonthLabel) + "</dd>" +
    "</dl>" +
    "<hr class=\"detail-divider\" />" +
    "<dl class=\"staff-detail-dl\">" +
    "<dt>กะ/เดือน (min–max)</dt><dd>" + (staff.min_shifts_per_month != null || staff.max_shifts_per_month != null ? (staff.min_shifts_per_month != null ? staff.min_shifts_per_month : "—") + " – " + (staff.max_shifts_per_month != null ? staff.max_shifts_per_month : "—") : "ไม่จำกัด") + "</dd>" +
    "<dt>ห่างอย่างน้อย</dt><dd>" +
      (staff.min_gap_days != null
        ? staff.min_gap_days + " วัน" +
          (gapShiftsLabel ? " <span class=\"text-muted\" style=\"font-size:.82rem\">(เฉพาะ: " + escapeHtml(gapShiftsLabel) + ")</span>" : "") +
          (gapRulesLabel ? " <div class=\"text-muted\" style=\"font-size:.82rem;margin-top:.25rem\">แยกตามกะ: " + escapeHtml(gapRulesLabel) + "</div>" : "")
        : (gapRulesLabel ? "<span class=\"text-muted\">—</span><div class=\"text-muted\" style=\"font-size:.82rem;margin-top:.25rem\">แยกตามกะ: " + escapeHtml(gapRulesLabel) + "</div>" : "—")) +
    "</dd>" +
    "<dt>ทักษะ</dt><dd>" + skillsLabel + "</dd>" +
    "<dt>ช่วงที่อยู่ได้</dt><dd>" + escapeHtml(timeWindowsLabel) + "</dd>" +
    "</dl>"
  );
}

function renderMinGapShiftCheckboxes(containerEl, selected) {
  if (!containerEl) return;
  const set = selected instanceof Set ? selected : new Set(Array.isArray(selected) ? selected : []);
  const list = Array.isArray(shiftsCache) ? shiftsCache : [];
  containerEl.innerHTML = list.length
    ? list.map((sh) => {
        const nm = typeof sh === "string" ? sh : sh.name;
        if (!nm) return "";
        const checked = set.has(nm) ? " checked" : "";
        return "<label class=\"staff-skill-cb\"><input type=\"checkbox\" name=\"" + escapeHtml(containerEl.dataset.cbName || "min_gap_shift") + "\" value=\"" + escapeHtml(nm) + "\"" + checked + " /> " + escapeHtml(nm) + "</label> ";
      }).join("")
    : "<span class=\"text-muted\">ยังไม่มีกะ — ไปที่หน้ากะเพิ่มก่อน</span>";
}

function renderMinGapRulesInputs(containerEl, rules) {
  if (!containerEl) return;
  const list = Array.isArray(shiftsCache) ? shiftsCache : [];
  const map = new Map();
  (Array.isArray(rules) ? rules : []).forEach((r) => {
    if (r && typeof r === "object" && r.shift) map.set(String(r.shift), Number(r.gap_days) || "");
  });
  containerEl.innerHTML = list.length
    ? list.map((sh) => {
        const nm = typeof sh === "string" ? sh : sh.name;
        if (!nm) return "";
        const val = map.has(nm) ? map.get(nm) : "";
        return "<div class=\"form-inline\" style=\"margin:0 0 .35rem 0\">" +
          "<span style=\"min-width:10rem\">" + escapeHtml(nm) + "</span>" +
          "<input type=\"number\" class=\"min-gap-rule-input\" data-shift=\"" + escapeHtml(nm) + "\" min=\"0\" max=\"30\" placeholder=\"—\" value=\"" + escapeHtml(String(val)) + "\" style=\"width:5rem\" />" +
          "<span class=\"text-muted\" style=\"font-size:.82rem;margin:0\">วัน</span>" +
          "</div>";
      }).join("")
    : "<span class=\"text-muted\">ยังไม่มีกะ — ไปที่หน้ากะเพิ่มก่อน</span>";
}

function renderStaffDetailForm(staff, catalogSkills, catalogTitles, catalogTimeWindows) {
  const offDaysSet = new Set((staff.off_days && staff.off_days.length) ? staff.off_days.map((d) => Number(d)) : []);
  const titleVal = (staff.title != null && staff.title !== undefined) ? staff.title : "";
  const staffSkillsSet = new Set((staff.skills && staff.skills.length) ? staff.skills : []);
  const staffTimeWindowsSet = new Set((staff.time_windows && staff.time_windows.length) ? staff.time_windows : []);
  const offDaysOfMonthVal = (staff.off_days_of_month && staff.off_days_of_month.length) ? staff.off_days_of_month.sort((a, b) => a - b).join(", ") : "";
  const dayNames = ["จันทร์", "อังคาร", "พุธ", "พฤหัสบดี", "ศุกร์", "เสาร์", "อาทิตย์"];
  const offDaysCheckboxes = dayNames
    .map(
      (label, i) =>
        "<label class=\"staff-day-cb\"><input type=\"checkbox\" name=\"staff_edit_off_day\" value=\"" +
        i +
        "\"" +
        (offDaysSet.has(i) ? " checked" : "") +
        " /> " +
        escapeHtml(label) +
        "</label>"
    )
    .join(" ");
  const staffSkillLevels = staff.skill_levels || {};
  const skillsList = (catalogSkills && catalogSkills.length)
    ? catalogSkills
        .map((s) => {
          const sname = typeof s === "string" ? s : s.name;
          const skillLevels = (typeof s === "object" && s.levels) ? s.levels : [];
          const isChecked = staffSkillsSet.has(sname);
          const curLvl = staffSkillLevels[sname] || 1;
          let lvlOptions = "";
          if (skillLevels.length) {
            lvlOptions = skillLevels.map((l) =>
              "<option value=\"" + l.level + "\"" + (curLvl === l.level ? " selected" : "") + ">" + escapeHtml(l.label) + "</option>"
            ).join("");
          } else {
            lvlOptions = "<option value=\"1\">ระดับ 1</option>";
          }
          return "<label class=\"staff-skill-cb\"><input type=\"checkbox\" name=\"staff_edit_skill\" value=\"" +
            escapeHtml(sname) + "\"" + (isChecked ? " checked" : "") + " /> " + escapeHtml(sname) +
            "</label>" + (skillLevels.length ? "<select class=\"skill-level-per-staff small\" data-skill=\"" + escapeHtml(sname) + "\" title=\"ระดับทักษะ\">" + lvlOptions + "</select> " : " ");
        })
        .join("")
    : "<span class=\"text-muted\">ยังไม่มีทักษะในระบบ — ไปที่หน้าทักษะเพิ่มก่อน</span>";
  const timeWindowsList = Array.isArray(catalogTimeWindows) ? catalogTimeWindows : [];
  const timeWindowsCheckboxes = timeWindowsList.length
    ? timeWindowsList.map((tw) => "<label class=\"staff-tw-cb\"><input type=\"checkbox\" name=\"staff_edit_time_window\" value=\"" + escapeHtml(tw.name) + "\"" + (staffTimeWindowsSet.has(tw.name) ? " checked" : "") + " /> " + escapeHtml(tw.name) + "</label>").join(" ")
    : "<span class=\"text-muted\">ยังไม่มีรายการช่วงเวลา</span>";
  const titlesList = Array.isArray(catalogTitles) ? catalogTitles : [];
  const titleOptions =
    "<option value=\"\">— เลือก —</option>" +
    titlesList
      .map(
        (t) =>
          "<option value=\"" +
          escapeHtml(t.name) +
          "\"" +
          (t.name === titleVal ? " selected" : "") +
          ">" +
          escapeHtml(t.name) +
          " (" +
          (t.type === "parttime" ? "พาร์ทไทม์" : "เต็มเวลา") +
          ")</option>"
      )
      .join("");
  const isWorkMode = offDaysOfMonthVal.split(",").filter(s=>s.trim()).length > 15;
  return (
    "<form id=\"staff_edit_form\" class=\"staff-edit-form\">" +
    "<fieldset class=\"form-section\"><legend>ข้อมูลพื้นฐาน</legend>" +
    "<div class=\"form-group\"><label for=\"staff_edit_name\">ชื่อ</label><input type=\"text\" id=\"staff_edit_name\" value=\"" +
    escapeHtml(staff.name) +
    "\" /></div>" +
    "<div class=\"form-group\" style=\"margin-top:.5rem\"><label for=\"staff_edit_title\">ฉายา/ตำแหน่ง</label><select id=\"staff_edit_title\">" +
    titleOptions +
    "</select></div>" +
    "</fieldset>" +
    "<fieldset class=\"form-section\"><legend>วันหยุด</legend>" +
    "<div class=\"form-group\" style=\"margin-top:0\"><label>ประจำสัปดาห์</label><div id=\"staff_edit_off_days\" class=\"staff-off-days-checkboxes\">" +
    offDaysCheckboxes +
    "</div></div>" +
    "<div class=\"form-group staff-off-days-of-month-wrap\" style=\"margin-top:.5rem\">" +
    "<div class=\"month-mode-toggle\">" +
    "<label class=\"month-mode-label\"><input type=\"radio\" name=\"staff_edit_month_mode\" value=\"off\"" + (!isWorkMode ? " checked" : "") + " /> ระบุวันหยุด</label>" +
    "<label class=\"month-mode-label\"><input type=\"radio\" name=\"staff_edit_month_mode\" value=\"work\"" + (isWorkMode ? " checked" : "") + " /> ระบุวันทำงาน</label>" +
    "</div>" +
    "<label for=\"staff_edit_off_days_of_month\" id=\"staff_edit_month_label\">" + (isWorkMode ? "รายเดือน (วันที่ทำงาน)" : "รายเดือน (วันที่หยุด)") + "</label>" +
    "<input type=\"text\" id=\"staff_edit_off_days_of_month\" placeholder=\"เช่น 1, 15, 31\" value=\"" +
    escapeHtml(isWorkMode ? offDaysToWorkDays(parseOffDaysOfMonth(offDaysOfMonthVal), getMonthTotalDays()).join(", ") : offDaysOfMonthVal) +
    "\" style=\"max-width:16rem\" /></div>" +
    "</fieldset>" +
    "<fieldset class=\"form-section\"><legend>จำนวนกะ / เดือน</legend>" +
    "<div class=\"form-inline\" style=\"margin-bottom:0\">" +
    "<label for=\"staff_edit_min_shifts\">ขั้นต่ำ</label>" +
    "<input type=\"number\" id=\"staff_edit_min_shifts\" min=\"0\" max=\"31\" placeholder=\"—\" value=\"" + (staff.min_shifts_per_month != null ? staff.min_shifts_per_month : "") + "\" style=\"width:5rem\" />" +
    "<label for=\"staff_edit_max_shifts\">สูงสุด</label>" +
    "<input type=\"number\" id=\"staff_edit_max_shifts\" min=\"0\" max=\"31\" placeholder=\"—\" value=\"" + (staff.max_shifts_per_month != null ? staff.max_shifts_per_month : "") + "\" style=\"width:5rem\" />" +
    "<span class=\"text-muted\" style=\"font-size:.82rem;margin:0\">ว่างไว้ = ไม่จำกัด</span>" +
    "</div></fieldset>" +
    "<fieldset class=\"form-section\"><legend>ห่างกันอย่างน้อย (วัน)</legend>" +
    "<div class=\"form-inline\" style=\"margin-bottom:0\">" +
    "<input type=\"number\" id=\"staff_edit_min_gap\" min=\"0\" max=\"30\" placeholder=\"—\" value=\"" + (staff.min_gap_days != null ? staff.min_gap_days : "") + "\" style=\"width:5rem\" />" +
    "<span class=\"text-muted\" style=\"font-size:.82rem;margin:0\">เช่น 6 = ห่างอย่างน้อย 6 วัน</span>" +
    "</div>" +
    "<div class=\"form-group\" style=\"margin-top:.5rem\">" +
    "<label class=\"text-muted\" style=\"font-size:.82rem\">กำหนดเว้นขั้นต่ำแยกตามกะ (ใส่ตัวเลขเฉพาะกะที่อยากจำกัด)</label>" +
    "<div id=\"staff_edit_min_gap_rules\" class=\"staff-skills-checkboxes\"></div>" +
    "</div></fieldset>" +
    "<fieldset class=\"form-section\"><legend>ทักษะ &amp; เวลา</legend>" +
    "<div class=\"form-group\" style=\"margin-top:0\"><label>ทักษะ</label><div id=\"staff_edit_skills\" class=\"staff-skills-checkboxes\">" +
    skillsList +
    "</div></div>" +
    "<div class=\"form-group\" style=\"margin-top:.5rem\"><label>ช่วงที่อยู่ได้</label><div id=\"staff_edit_time_windows\" class=\"staff-time-windows-checkboxes\">" +
    timeWindowsCheckboxes +
    "</div></div>" +
    "</fieldset>" +
    "<p id=\"staff_edit_message\" class=\"message\" style=\"display:none\"></p>" +
    "<button type=\"submit\" class=\"btn-primary\">บันทึก</button>" +
    "</form>"
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
    const [staffRes, skillsRes, titlesRes, twRes] = await Promise.all([
      fetch(API + "/staff/" + staffId),
      fetch(API + "/skills"),
      fetch(API + "/titles"),
      fetch(API + "/time-windows"),
    ]);
    if (!staffRes.ok) {
      contentEl.innerHTML = "<p class=\"message error\">โหลดข้อมูลไม่สำเร็จ</p>";
      contentEl.style.display = "";
      loadingEl.style.display = "none";
      return;
    }
    const staff = await staffRes.json();
    const catalogSkills = await skillsRes.json();
    const catalogTitles = await titlesRes.json();
    const catalogTimeWindows = await twRes.json();
    const skillsList = Array.isArray(catalogSkills) ? catalogSkills : [];
    const titlesList = Array.isArray(catalogTitles) ? catalogTitles : [];
    const timeWindowsList = Array.isArray(catalogTimeWindows) ? catalogTimeWindows : [];
    contentEl.innerHTML = renderStaffDetailForm(staff, skillsList, titlesList, timeWindowsList);
    contentEl.style.display = "";

    const editGapRules = document.getElementById("staff_edit_min_gap_rules");
    if (editGapRules) renderMinGapRulesInputs(editGapRules, staff.min_gap_rules || []);

    document.querySelectorAll("input[name='staff_edit_month_mode']").forEach((radio) => {
      radio.addEventListener("change", () => {
        const label = document.getElementById("staff_edit_month_label");
        const input = document.getElementById("staff_edit_off_days_of_month");
        const currentDays = parseOffDaysOfMonth(input ? input.value : "");
        const total = getMonthTotalDays();
        if (radio.value === "work") {
          if (label) label.textContent = "วันทำงานรายเดือน (วันที่)";
          if (input) { input.placeholder = "เช่น 1, 5, 12 (กรอกเฉพาะวันที่มาทำงาน)"; input.value = offDaysToWorkDays(currentDays, total).join(", "); }
        } else {
          if (label) label.textContent = "วันหยุดรายเดือน (วันที่)";
          if (input) { input.placeholder = "เช่น 1, 15, 31"; input.value = workDaysToOffDays(currentDays, total).join(", "); }
        }
      });
    });

    const form = document.getElementById("staff_edit_form");
    const msgEl = document.getElementById("staff_edit_message");
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const name = (document.getElementById("staff_edit_name") && document.getElementById("staff_edit_name").value.trim()) || "";
      if (!name) {
        msgEl.textContent = "กรุณากรอกชื่อ";
        msgEl.className = "message error";
        msgEl.style.display = "";
        return;
      }
      const titleEl = document.getElementById("staff_edit_title");
      const title = (titleEl && titleEl.value) ? titleEl.value.trim() : "";
      const offDayCbs = document.querySelectorAll("#staff_edit_form input[name=\"staff_edit_off_day\"]:checked");
      const off_days = Array.from(offDayCbs).map((cb) => parseInt(cb.value, 10));
      const editOffMonthEl = document.getElementById("staff_edit_off_days_of_month");
      const editMonthMode = document.querySelector("input[name='staff_edit_month_mode']:checked");
      const isEditWorkMode = editMonthMode && editMonthMode.value === "work";
      const rawEditDays = parseOffDaysOfMonth(editOffMonthEl ? editOffMonthEl.value : "");
      const off_days_of_month = isEditWorkMode ? workDaysToOffDays(rawEditDays, getMonthTotalDays()) : rawEditDays;
      const skillCheckboxes = document.querySelectorAll("#staff_edit_form input[name=\"staff_edit_skill\"]:checked");
      const skills = Array.from(skillCheckboxes).map((cb) => cb.value);
      // collect skill_levels per person from level selects
      const skill_levels = {};
      skills.forEach((skillName) => {
        const lvlSel = document.querySelector("#staff_edit_form select.skill-level-per-staff[data-skill=\"" + skillName + "\"]");
        if (lvlSel) skill_levels[skillName] = parseInt(lvlSel.value, 10) || 1;
      });
      const timeWindowCbs = document.querySelectorAll("#staff_edit_form input[name=\"staff_edit_time_window\"]:checked");
      const time_windows = Array.from(timeWindowCbs).map((cb) => cb.value);
      const editMinEl = document.getElementById("staff_edit_min_shifts");
      const editMaxEl = document.getElementById("staff_edit_max_shifts");
      const editGapEl = document.getElementById("staff_edit_min_gap");
      const min_shifts_per_month = editMinEl && editMinEl.value !== "" ? parseInt(editMinEl.value, 10) : null;
      const max_shifts_per_month = editMaxEl && editMaxEl.value !== "" ? parseInt(editMaxEl.value, 10) : null;
      const min_gap_days = editGapEl && editGapEl.value !== "" ? parseInt(editGapEl.value, 10) : null;
      const min_gap_rules = Array.from(document.querySelectorAll("#staff_edit_form .min-gap-rule-input"))
        .map((el) => ({ shift: el.dataset.shift, gap_days: el.value !== "" ? parseInt(el.value, 10) : 0 }))
        .filter((r) => r.shift && r.gap_days && r.gap_days > 0);
      msgEl.style.display = "none";
      try {
        const res = await fetch(API + "/staff/" + staffId, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name, title, off_days, off_days_of_month, skills, time_windows, skill_levels, min_shifts_per_month, max_shifts_per_month, min_gap_days, min_gap_shifts: [], min_gap_rules }),
        });
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          msgEl.textContent = formatApiError(err) || "บันทึกไม่สำเร็จ";
          msgEl.className = "message error";
          msgEl.style.display = "";
          return;
        }
        msgEl.textContent = "บันทึกแล้ว";
        msgEl.className = "message success";
        msgEl.style.display = "";
        refreshStaff();
      } catch (err) {
        msgEl.textContent = "เกิดข้อผิดพลาด: " + (err.message || "");
        msgEl.className = "message error";
        msgEl.style.display = "";
      }
    });
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
          <button type="button" class="small btn-edit-staff" data-id="${s.id}" title="แก้ไข">แก้ไข</button>
          <button type="button" class="small btn-delete-staff" data-id="${s.id}" title="ลบ">ลบ</button>
        </li>`
    )
    .join("");
  ul.querySelectorAll(".staff-sidebar-item").forEach((li) => {
    const id = parseInt(li.dataset.id, 10);
    li.querySelector(".staff-sidebar-name").addEventListener("click", () => showStaffDetail(id));
  });
  ul.querySelectorAll(".btn-edit-staff").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const id = parseInt(btn.dataset.id, 10);
      if (!isNaN(id)) showStaffDetail(id);
    });
  });
  ul.querySelectorAll(".btn-delete-staff").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      if (!confirm("ลบคนนี้?")) return;
      const r = await fetch(API + "/staff/" + btn.dataset.id, { method: "DELETE" });
      if (!r.ok) { alert("ลบไม่สำเร็จ"); return; }
      document.getElementById("staff_detail_empty").style.display = "";
      document.getElementById("staff_detail_content").style.display = "none";
      await refreshStaff();
    });
  });
}

function renderShiftList(items) {
  const ul = document.getElementById("shift_list");
  function parseRoomAndKind(shiftName) {
    const s = String(shiftName || "").trim();
    let kind = "other";
    if (/เช้า/.test(s)) kind = "morning";
    else if (/บ่าย/.test(s)) kind = "afternoon";
    else if (/ดึก/.test(s)) kind = "night";
    const room = s.replace(/^ห้อง\s+/, "").replace(/\s*(เช้า|บ่าย|ดึก|เวรเช้า|เวรบ่าย|เวรดึก)$/, "").trim() || s;
    return { room, kind };
  }
  const kindOrder = { night: 1, morning: 2, afternoon: 3, other: 99 };
  const roomOrder = { Micro: 1, Hemato: 2, Immune: 3, Chem: 4 };

  const arr = Array.isArray(items) ? items.slice() : [];
  const sorted = arr
    .map((s) => ({ ...s, _meta: parseRoomAndKind(s.name) }))
    .sort((a, b) => {
      const ra = roomOrder[a._meta.room] || 50;
      const rb = roomOrder[b._meta.room] || 50;
      if (ra !== rb) return ra - rb;
      const ka = kindOrder[a._meta.kind] || 99;
      const kb = kindOrder[b._meta.kind] || 99;
      if (ka !== kb) return ka - kb;
      return String(a.name).localeCompare(String(b.name));
    });

  const groups = {};
  sorted.forEach((s) => {
    const room = (s._meta && s._meta.room) ? s._meta.room : "อื่นๆ";
    if (!groups[room]) groups[room] = [];
    groups[room].push(s);
  });
  const groupNames = Object.keys(groups).sort((a, b) => (roomOrder[a] || 99) - (roomOrder[b] || 99) || a.localeCompare(b));

  const renderRow = (s) => {
    const posLabel = s.positions && s.positions.length
      ? s.positions.map((p) => {
          const name = typeof p === "string" ? p : p.name;
          const n = typeof p === "object" && p.slot_count != null ? ` ×${p.slot_count}` : "";
          const tw = typeof p === "object" && p.time_window_name ? ` [${p.time_window_name}]` : "";
          let sk = "";
          if (typeof p === "object" && p.required_skill) {
            const lvlLabels = getSkillLevelLabels(p.required_skill);
            const lvlName = lvlLabels[p.min_skill_level] || ("lv" + (p.min_skill_level || 1));
            sk = ` 🔑${p.required_skill}≥${lvlName}`;
          }
          const at = typeof p === "object" && p.allowed_titles && p.allowed_titles.length ? ` [${p.allowed_titles.join("/")}]` : "";
          const mpw = typeof p === "object" && p.max_per_week ? ` ≤${p.max_per_week}/wk` : "";
          return name + n + tw + sk + at + mpw;
        }).join(" | ")
      : `donor: ${s.donor ?? 0}, xmatch: ${s.xmatch ?? 0}`;
    return `<li data-id="${s.id}">
        <span class="name">${escapeHtml(s.name)} — ${escapeHtml(posLabel)}</span>
        <button type="button" class="small btn-edit-shift" data-id="${s.id}">แก้ไข</button>
        <button class="small btn-delete-shift" data-id="${s.id}">ลบ</button>
      </li>`;
  };

  ul.innerHTML = groupNames
    .map((room) => {
      const header = `<li class="shift-room-header">${escapeHtml(room)}</li>`;
      return header + (groups[room] || []).map(renderRow).join("");
    })
    .join("");
  ul.querySelectorAll(".btn-edit-shift").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      const id = btn.dataset.id;
      if (!id) return;
      if (currentShiftId != null && hasShiftFormUnsavedChanges()) {
        if (!confirm("มีการแก้ไขที่ยังไม่บันทึก จะทิ้งและโหลดกะที่เลือกใหม่หรือไม่?")) return;
      }
      startEditShift(id);
    });
  });
  ul.querySelectorAll(".btn-delete-shift").forEach((btn) => {
    btn.addEventListener("click", async () => {
      if (!confirm("ลบกะนี้?")) return;
      const r = await fetch(API + "/shifts/" + btn.dataset.id, { method: "DELETE" });
      if (!r.ok) { alert("ลบไม่สำเร็จ"); return; }
      await refreshShifts();
    });
  });
}

function hasShiftFormUnsavedChanges() {
  if (currentShiftId == null) return false;
  const shift = (shiftsCache || []).find((s) => s.id === currentShiftId);
  if (!shift) return false;
  const nameInput = document.getElementById("shift_name");
  const currentName = (nameInput && nameInput.value || "").trim();
  if (currentName !== (shift.name || "").trim()) return true;
  const mfEl = document.getElementById("shift_min_fulltime");
  const currentMf = mfEl ? parseInt(mfEl.value, 10) || 0 : 0;
  const savedMf = parseInt(shift.min_fulltime, 10) || 0;
  if (currentMf !== savedMf) return true;
  const currentPositions = collectShiftPositions();
  const savedPositions = shift.positions || [];
  if (currentPositions.length !== savedPositions.length) return true;
  for (let i = 0; i < currentPositions.length; i++) {
    const a = currentPositions[i];
    const b = savedPositions[i];
    const an = typeof b === "string" ? b : (b && b.name);
    if ((a.name || "").trim() !== (an || "").trim()) return true;
    if ((a.time_window_name || "") !== (typeof b === "object" && b ? b.time_window_name || "" : "")) return true;
    const ac = a.slot_count != null ? a.slot_count : 1;
    const bc = typeof b === "object" && b && b.slot_count != null ? b.slot_count : 1;
    if (ac !== bc) return true;
  }
  return false;
}

function resetShiftForm() {
  currentShiftId = null;
  const nameInput = document.getElementById("shift_name");
  if (nameInput) nameInput.value = "";
  const adEl = document.getElementById("shift_active_days");
  if (adEl) adEl.value = "";
  const ihEl = document.getElementById("shift_include_holidays");
  if (ihEl) ihEl.checked = false;
  const mfEl = document.getElementById("shift_min_fulltime");
  if (mfEl) mfEl.value = "0";
  const list = document.getElementById("shift_positions_list");
  if (list) {
    list.innerHTML = "";
    if (typeof addPositionRow === "function") {
      addPositionRow();
    }
  }
  const bar = document.getElementById("pos_bulk_actions");
  if (bar) bar.remove();
  const editActions = document.getElementById("shift_edit_actions");
  if (editActions) editActions.style.display = "none";
  const addBtn = document.getElementById("add_shift");
  if (addBtn) addBtn.textContent = "เพิ่มกะ";
}

function startEditShift(shiftId) {
  const idNum = parseInt(shiftId, 10);
  const shift = (shiftsCache || []).find((s) => s.id === idNum);
  if (!shift) return;
  currentShiftId = shift.id;
  const nameInput = document.getElementById("shift_name");
  if (nameInput) nameInput.value = shift.name || "";
  const adEl = document.getElementById("shift_active_days");
  if (adEl) adEl.value = shift.active_days || "";
  const ihEl = document.getElementById("shift_include_holidays");
  if (ihEl) ihEl.checked = !!shift.include_holidays;
  const mfEl = document.getElementById("shift_min_fulltime");
  if (mfEl) mfEl.value = String(Math.max(0, parseInt(shift.min_fulltime, 10) || 0));
  const list = document.getElementById("shift_positions_list");
  if (list) {
    list.innerHTML = "";
    (shift.positions || []).forEach((p) => {
      const name = typeof p === "string" ? p : p.name;
      const note = typeof p === "object" && p.constraint_note ? p.constraint_note : "";
      const slotCount = typeof p === "object" && p.slot_count != null ? p.slot_count : 1;
      const tw = typeof p === "object" && p.time_window_name ? p.time_window_name : "";
      const reqSkill = typeof p === "object" && p.required_skill ? p.required_skill : "";
      const minLvl = typeof p === "object" && p.min_skill_level ? p.min_skill_level : 0;
      const allowedTitles = typeof p === "object" && Array.isArray(p.allowed_titles) ? p.allowed_titles : [];
      const maxPerWeek = typeof p === "object" && p.max_per_week != null ? p.max_per_week : 0;
      const activeWeekdays = typeof p === "object" && p.active_weekdays ? p.active_weekdays : "";
      if (typeof addPositionRow === "function") {
        addPositionRow(name, note, slotCount, tw, reqSkill, minLvl, allowedTitles, maxPerWeek, activeWeekdays);
      }
    });
  }
  const editActions = document.getElementById("shift_edit_actions");
  if (editActions) editActions.style.display = "";
  const addBtn = document.getElementById("add_shift");
  if (addBtn) addBtn.textContent = "บันทึกกะ";
}

function escapeHtml(s) {
  if (s == null) return "";
  if (typeof s === "object") s = JSON.stringify(s);
  const div = document.createElement("div");
  div.textContent = String(s);
  return div.innerHTML;
}

function formatApiError(d) {
  if (!d) return "";
  if (typeof d.detail === "string") return d.detail;
  if (Array.isArray(d.detail)) return d.detail.map((e) => e.msg || JSON.stringify(e)).join("; ");
  if (d.detail) return JSON.stringify(d.detail);
  return "";
}

function renderSchedule(data, staffList) {
  const meta = document.getElementById("schedule_meta");
  const wrap = document.getElementById("schedule_table_wrap");
  const exportLink = document.getElementById("export_csv");
  // Clear dummy warning banner ถ้ามี
  const oldWarn = document.getElementById("dummy_warn_banner");
  if (oldWarn) oldWarn.remove();

  if (!data) {
    meta.textContent = "ยังไม่มีตาราง — กด \"สร้างตารางเวร\" เพื่อสร้าง";
    wrap.innerHTML = "";
    exportLink.style.display = "none";
    return;
  }
  const runId = data.run_id;
  const startDate = data.start_date || null;
  const maxDayInSlots = data.slots.length ? Math.max(...data.slots.map((s) => s.day), 0) + 1 : 0;
  const displayDays = Math.max(data.num_days || 0, maxDayInSlots);
  const dateRange = startDate && displayDays > 0
    ? formatDayLabel(0, startDate) + " – " + formatDayLabel(displayDays - 1, startDate)
    : "";
  const dummyCount = data.slots.filter((s) => s.is_dummy).length;
  const metaSuffix = dummyCount > 0 ? `  ⚠ ${dummyCount} ช่องยังว่าง` : "";
  meta.textContent = `Run #${runId} — สร้างเมื่อ ${data.created_at} (${displayDays} วัน)${dateRange ? " · " + dateRange : ""}${metaSuffix}`;
  exportLink.href = API + "/schedule/export/csv?run_id=" + runId;
  exportLink.style.display = "inline";

  // Banner แจ้งเตือนถ้ามี dummy slots
  if (dummyCount > 0) {
    const warn = document.createElement("div");
    warn.id = "dummy_warn_banner";
    warn.className = "dummy-warn-banner";
    warn.innerHTML = `<strong>⚠ จัดไม่ครบ ${dummyCount} ช่อง</strong> — บุคลากรไม่พอหรือมีข้อจำกัด คลิกช่อง <span class="cell-dummy-preview">ว่าง</span> เพื่อมอบหมายเอง`;
    wrap.parentElement.insertBefore(warn, wrap);
  }

  const days = [];
  for (let d = 0; d < displayDays; d++) days.push(d);
  const posKey = data.slots.length && data.slots[0].position != null ? "position" : "room";

  // Build byDayShiftPosSlot: "day-shift-pos" → { slotIdx: slot }
  const byDayShiftPosSlot = {};
  data.slots.forEach((s) => {
    const pos = s[posKey] || s.room || s.position || "";
    const key = `${s.day}-${s.shift_name}-${pos}`;
    if (!byDayShiftPosSlot[key]) byDayShiftPosSlot[key] = {};
    byDayShiftPosSlot[key][s.slot_index ?? 0] = s;
  });

  // Build shiftPositions (ordered) and shiftSlotCounts from definitions
  const shiftPositions = {};
  const shiftSlotCounts = {}; // sn -> pos -> count
  (shiftsCache || []).forEach((sh) => {
    if (sh.positions && sh.positions.length) {
      shiftPositions[sh.name] = sh.positions.map((p) => (typeof p === "string" ? p : p.name));
      shiftSlotCounts[sh.name] = {};
      sh.positions.forEach((p) => {
        const pName = typeof p === "string" ? p : p.name;
        shiftSlotCounts[sh.name][pName] = (typeof p === "object" && p.slot_count) ? Math.max(1, p.slot_count) : 1;
      });
    }
  });
  // Augment with positions found in slots not covered by definition
  data.slots.forEach((s) => {
    const sn = s.shift_name;
    const pos = s[posKey] || s.room || s.position || "";
    if (!shiftPositions[sn]) shiftPositions[sn] = [];
    if (!shiftPositions[sn].includes(pos)) shiftPositions[sn].push(pos);
    if (!shiftSlotCounts[sn]) shiftSlotCounts[sn] = {};
    if (!shiftSlotCounts[sn][pos]) shiftSlotCounts[sn][pos] = 1;
  });

  function _posSlotCount(sn, pos) { return (shiftSlotCounts[sn] && shiftSlotCounts[sn][pos]) || 1; }
  function _shiftTotalCols(sn) {
    return (shiftPositions[sn] || []).reduce((acc, p) => acc + _posSlotCount(sn, p), 0) || 1;
  }

  // --- Group/sort shifts by "room" suffix for readability (Template 5) ---
  function parseRoomAndKind(shiftName) {
    const s = String(shiftName || "").trim();
    let kind = "other";
    if (/เช้า/.test(s)) kind = "morning";
    else if (/บ่าย/.test(s)) kind = "afternoon";
    else if (/ดึก/.test(s)) kind = "night";
    const room = s.replace(/^ห้อง\s+/, "").replace(/\s*(เช้า|บ่าย|ดึก|เวรเช้า|เวรบ่าย|เวรดึก)$/, "").trim() || s;
    return { room, kind };
  }
  const kindOrder = { night: 1, morning: 2, afternoon: 3, other: 99 };
  const roomOrder = { Micro: 1, Hemato: 2, Immune: 3, Chem: 4 };
  const shiftsMeta = Object.keys(shiftPositions)
    .map((sn) => ({ name: sn, ...parseRoomAndKind(sn) }))
    .sort((a, b) => {
      const ra = roomOrder[a.room] || 50;
      const rb = roomOrder[b.room] || 50;
      if (ra !== rb) return ra - rb;
      const ka = kindOrder[a.kind] || 99;
      const kb = kindOrder[b.kind] || 99;
      if (ka !== kb) return ka - kb;
      return a.name.localeCompare(b.name);
    });
  const shiftNames = shiftsMeta.map((m) => m.name);
  const hasRooms = shiftsMeta.some((m) => m.room);

  // Header rows:
  // 1) Room group (optional)
  // 2) Shift name
  // 3) Position
  let html = "<table><thead>";
  if (hasRooms) {
    html += "<tr><th class=\"th-day\" rowspan=\"3\">วัน</th>";
    let i = 0;
    while (i < shiftsMeta.length) {
      const room = shiftsMeta[i].room || "อื่นๆ";
      let colSpan = 0;
      let j = i;
      while (j < shiftsMeta.length && (shiftsMeta[j].room || "อื่นๆ") === room) {
        colSpan += _shiftTotalCols(shiftsMeta[j].name);
        j++;
      }
      html += `<th class="th-room" colspan="${colSpan}">${escapeHtml(room)}</th>`;
      i = j;
    }
    html += "</tr>";
  } else {
    html += "<tr><th class=\"th-day\" rowspan=\"2\">วัน</th>";
    shiftNames.forEach((sn) => {
      html += `<th colspan="${_shiftTotalCols(sn)}">${escapeHtml(sn)}</th>`;
    });
    html += "</tr>";
  }

  // Shift row (always)
  html += "<tr>";
  shiftNames.forEach((sn) => {
    const meta = shiftsMeta.find((m) => m.name === sn) || {};
    const room = meta.room || "";
    html += `<th class="th-shift" data-room="${escapeHtml(room)}" colspan="${_shiftTotalCols(sn)}">${escapeHtml(sn)}</th>`;
  });
  html += "</tr>";

  // Position row — one <th> per slot
  html += "<tr>";
  shiftNames.forEach((sn) => {
    const meta = shiftsMeta.find((m) => m.name === sn) || {};
    const room = meta.room || "";
    (shiftPositions[sn] || ["ช่อง"]).forEach((pos) => {
      const cnt = _posSlotCount(sn, pos);
      for (let si = 0; si < cnt; si++) {
        const label = cnt > 1 ? `${escapeHtml(pos)} ${si + 1}` : escapeHtml(pos);
        html += `<th class="th-pos" data-room="${escapeHtml(room)}">${label}</th>`;
      }
    });
  });
  html += "</tr></thead><tbody>";
  // Track which shifts are completely inactive on a day (no slots at all across all positions)
  const shiftActiveOnDay = {};
  data.slots.forEach((s) => {
    const key = `${s.day}-${s.shift_name}`;
    shiftActiveOnDay[key] = true;
  });

  days.forEach((day) => {
    const dayLabel = formatDayLabel(day, startDate);
    html += `<tr><td>${escapeHtml(dayLabel)}</td>`;
    let prevRoom = null;
    shiftNames.forEach((sn) => {
      const meta = shiftsMeta.find((m) => m.name === sn) || {};
      const room = meta.room || "";
      const shiftHasAnySlotToday = shiftActiveOnDay[`${day}-${sn}`];
      (shiftPositions[sn] || []).forEach((pos, posIdx) => {
        const cnt = _posSlotCount(sn, pos);
        const slotMap = byDayShiftPosSlot[`${day}-${sn}-${pos}`] || {};
        for (let si = 0; si < cnt; si++) {
          const isFirstOfRoom = (room && prevRoom !== null && room !== prevRoom && posIdx === 0 && si === 0);
          const roomSep = isFirstOfRoom ? " td-room-sep" : "";
          const s = slotMap[si];
          if (!s) {
            if (!shiftHasAnySlotToday) {
              html += `<td class="td-inactive${roomSep}" title="กะนี้ไม่เปิดวันนี้">—</td>`;
            } else {
              html += `<td class="${roomSep.trim()}"></td>`;
            }
          } else if (s.is_dummy) {
            html += `<td class="td-has-dummy${roomSep}"><span class="cell-dummy" data-run="${runId}" data-day="${day}" data-shift="${escapeHtml(sn)}" data-pos="${escapeHtml(pos)}" data-slot="${si}" title="คลิกเพื่อมอบหมาย">ว่าง</span></td>`;
          } else {
            const nameSpan = `<span class="cell-name" data-run="${runId}" data-day="${day}" data-shift="${escapeHtml(sn)}" data-pos="${escapeHtml(pos)}" data-slot="${si}" data-name="${escapeHtml(s.staff_name)}" title="คลิกเพื่อเปลี่ยน">${escapeHtml(s.staff_name)}</span>`;
            const content = s.time_window ? `${nameSpan} <small class="tw-label">(${escapeHtml(s.time_window)})</small>` : nameSpan;
            html += `<td${roomSep ? ` class="${roomSep.trim()}"` : ""}>${content}</td>`;
          }
        }
        prevRoom = room || prevRoom;
      });
    });
    html += "</tr>";
  });
  html += "</tbody></table>";
  wrap.innerHTML = html;

  // Attach click handlers to dummy spans
  const sf = staffList || [];
  // busyByDay[day] = Set(staff_name) who already has any non-dummy slot that day
  const busyByDay = {};
  (data.slots || []).forEach((s) => {
    if (s.is_dummy) return;
    const d = Number(s.day);
    if (!busyByDay[d]) busyByDay[d] = new Set();
    busyByDay[d].add(s.staff_name);
  });
  wrap.querySelectorAll(".cell-dummy").forEach((span) => {
    span.addEventListener("click", () => handleDummyClick(span, sf, runId, busyByDay));
  });
  wrap.querySelectorAll(".cell-name").forEach((span) => {
    span.addEventListener("click", () => handleNameClick(span, sf, runId, busyByDay));
  });

  // Summary stats
  renderScheduleSummary(data.slots, staffList);
}

function renderScheduleSummary(slots, staffList) {
  const wrap = document.getElementById("schedule_table_wrap");
  const old = document.getElementById("schedule_summary");
  if (old) old.remove();
  if (!slots || slots.length === 0) return;

  // นับเวรต่อคน (ไม่นับ dummy)
  const realSlots = slots.filter((s) => !s.is_dummy);
  const countByStaff = {};
  realSlots.forEach((s) => {
    countByStaff[s.staff_name] = (countByStaff[s.staff_name] || 0) + 1;
  });
  const counts = Object.values(countByStaff);
  if (counts.length === 0) return;
  const maxC = Math.max(...counts);
  const minC = Math.min(...counts);
  const spread = maxC - minC;
  const dummyCount = slots.filter((s) => s.is_dummy).length;

  // เรียงชื่อตาม count มากก่อน
  const sorted = Object.entries(countByStaff).sort((a, b) => b[1] - a[1]);

  const div = document.createElement("div");
  div.id = "schedule_summary";
  div.className = "schedule-summary";
  div.innerHTML =
    `<h3 class="summary-title">สรุปเวรต่อคน</h3>` +
    `<div class="summary-meta">` +
    `<span>เวรสูงสุด: <strong>${maxC}</strong></span>` +
    `<span>เวรต่ำสุด: <strong>${minC}</strong></span>` +
    `<span class="${spread <= 1 ? "spread-good" : spread <= 2 ? "spread-ok" : "spread-warn"}">ต่าง: <strong>${spread}</strong></span>` +
    (dummyCount > 0 ? `<span class="spread-warn">ว่าง: <strong>${dummyCount}</strong></span>` : "") +
    `</div>` +
    `<div class="summary-bars">` +
    sorted.map(([name, cnt]) => {
      const pct = maxC > 0 ? Math.round((cnt / maxC) * 100) : 0;
      return `<div class="summary-bar-row"><span class="summary-name">${escapeHtml(name)}</span><div class="summary-bar-track"><div class="summary-bar-fill" style="width:${pct}%"></div></div><span class="summary-count">${cnt}</span></div>`;
    }).join("") +
    `</div>`;
  wrap.after(div);
}

async function handleDummyClick(span, staffList, runId, busyByDay) {
  if (span.dataset.loading) return;
  const day = parseInt(span.dataset.day, 10);
  const shiftName = span.dataset.shift;
  const position = span.dataset.pos;
  const slotIndex = parseInt(span.dataset.slot, 10);

  if (!staffList || staffList.length === 0) {
    alert("ไม่มีบุคลากรในระบบ — ไปที่หน้าบุคลากรเพื่อเพิ่มก่อน");
    return;
  }

  const select = document.createElement("select");
  select.className = "dummy-assign-select";
  const ph = document.createElement("option");
  ph.value = "";
  ph.textContent = "— เลือกบุคลากร —";
  select.appendChild(ph);

  const shift = (shiftsCache || []).find((s) => s.name === shiftName);
  const posInfo = shift && shift.positions ? shift.positions.find((p) => p.name === position) : null;
  const requiredSkill = posInfo && posInfo.required_skill ? (posInfo.required_skill || "").trim() : "";
  const minSkillLevel = posInfo && posInfo.min_skill_level ? parseInt(posInfo.min_skill_level, 10) || 0 : 0;

  const canWorkPosition = (mt) => {
    if (!requiredSkill) return true;
    const skills = mt.skills || [];
    const levels = mt.skill_levels || {};
    if (!skills.includes(requiredSkill)) return false;
    const lvl = parseInt(levels[requiredSkill], 10) || 1;
    return lvl >= minSkillLevel;
  };

  const busy = busyByDay && busyByDay[day] ? busyByDay[day] : new Set();
  staffList.forEach((mt) => {
    const opt = document.createElement("option");
    opt.value = mt.name;
    const isBusy = busy.has(mt.name);
    const hasSkill = canWorkPosition(mt);
    let label = mt.name;
    if (isBusy) label += " (มีเวรแล้ว)";
    else if (!hasSkill && requiredSkill) label += " (ไม่มีทักษะ)";
    opt.textContent = label;
    if (isBusy || (!hasSkill && requiredSkill)) opt.disabled = true;
    select.appendChild(opt);
  });

  const restoreSpan = () => {
    const ns = document.createElement("span");
    ns.className = "cell-dummy";
    ns.title = "คลิกเพื่อมอบหมาย";
    ns.textContent = "ว่าง";
    Object.assign(ns.dataset, { run: runId, day, shift: shiftName, pos: position, slot: slotIndex });
    select.replaceWith(ns);
    ns.addEventListener("click", () => handleDummyClick(ns, staffList, runId, busyByDay));
  };

  span.replaceWith(select);
  select.focus();

  select.addEventListener("change", async () => {
    const staffName = select.value;
    if (!staffName) return;
    select.disabled = true;
    try {
      const r = await fetch(`${API}/schedule/${runId}/slot`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ day, shift_name: shiftName, position, slot_index: slotIndex, staff_name: staffName }),
      });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || "assign failed");
      await refreshSchedule();
    } catch (e) {
      restoreSpan();
      alert("มอบหมายไม่สำเร็จ: " + e.message);
    }
  });
  select.addEventListener("blur", () => { if (!select.value) restoreSpan(); });
}

async function handleNameClick(span, staffList, runId, busyByDay) {
  if (span.dataset.loading) return;
  const day = parseInt(span.dataset.day, 10);
  const shiftName = span.dataset.shift;
  const position = span.dataset.pos;
  const slotIndex = parseInt(span.dataset.slot, 10);
  const currentName = span.dataset.name;

  if (!staffList || staffList.length === 0) {
    alert("ไม่มีบุคลากรในระบบ");
    return;
  }

  // --- Swap mode ---
  if (_swapPending) {
    const src = _swapPending;
    // คลิกที่สองบน slot เดิม → ยกเลิก
    if (src.span === span) { _clearSwapPending(); return; }
    // ยืนยัน swap
    _clearSwapPending();
    span.dataset.loading = "1";
    src.span.dataset.loading = "1";
    try {
      const [r1, r2] = await Promise.all([
        fetch(`${API}/schedule/${runId}/slot`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ day: src.day, shift_name: src.shiftName, position: src.position, slot_index: src.slotIndex, staff_name: currentName }),
        }),
        fetch(`${API}/schedule/${runId}/slot`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ day, shift_name: shiftName, position, slot_index: slotIndex, staff_name: src.staffName }),
        }),
      ]);
      if (!r1.ok || !r2.ok) throw new Error("swap failed");
      await refreshSchedule();
    } catch (e) {
      delete span.dataset.loading;
      delete src.span.dataset.loading;
      alert("สลับไม่สำเร็จ: " + e.message);
    }
    return;
  }

  // คลิกแรก → เข้า swap mode (ไม่เปิด dropdown ทันที)
  _swapPending = { span, runId, day, shiftName, position, slotIndex, staffName: currentName };
  span.classList.add("cell-name-swap-pending");
  // ถ้าคลิกที่อื่น (ไม่ใช่ .cell-name) → ยกเลิก swap mode แล้วเปิด dropdown ปกติ
  const onOutsideClick = (e) => {
    if (e.target === span) return;
    document.removeEventListener("click", onOutsideClick, true);
    if (!_swapPending || _swapPending.span !== span) return;
    if (e.target.classList && e.target.classList.contains("cell-name")) return; // handled by swap logic
    _clearSwapPending();
    // เปิด dropdown ปกติ
    _openNameDropdown(span, staffList, runId, busyByDay, day, shiftName, position, slotIndex, currentName);
  };
  setTimeout(() => document.addEventListener("click", onOutsideClick, true), 0);
}

function _openNameDropdown(span, staffList, runId, busyByDay, day, shiftName, position, slotIndex, currentName) {
  const select = document.createElement("select");
  select.className = "dummy-assign-select";
  const ph = document.createElement("option");
  ph.value = "";
  ph.textContent = "— เปลี่ยนเป็น... —";
  select.appendChild(ph);

  const shift = (shiftsCache || []).find((s) => s.name === shiftName);
  const posInfo = shift && shift.positions ? shift.positions.find((p) => p.name === position) : null;
  const requiredSkill = posInfo && posInfo.required_skill ? (posInfo.required_skill || "").trim() : "";
  const minSkillLevel = posInfo && posInfo.min_skill_level ? parseInt(posInfo.min_skill_level, 10) || 0 : 0;

  const canWorkPosition = (mt) => {
    if (!requiredSkill) return true;
    const skills = mt.skills || [];
    const levels = mt.skill_levels || {};
    if (!skills.includes(requiredSkill)) return false;
    const lvl = parseInt(levels[requiredSkill], 10) || 1;
    return lvl >= minSkillLevel;
  };

  // เอาคนปัจจุบันออกจาก busy (กำลังถูกแทนที่)
  const busy = new Set(busyByDay && busyByDay[day] ? [...busyByDay[day]] : []);
  busy.delete(currentName);

  staffList.forEach((mt) => {
    const opt = document.createElement("option");
    opt.value = mt.name;
    const isBusy = busy.has(mt.name);
    const hasSkill = canWorkPosition(mt);
    let label = mt.name;
    if (isBusy && mt.name !== currentName) label += " (มีเวรแล้ว)";
    else if (!hasSkill && requiredSkill) label += " (ไม่มีทักษะ)";
    opt.textContent = label;
    if (mt.name === currentName) opt.selected = true;
    if (isBusy || (!hasSkill && requiredSkill)) opt.disabled = true;
    select.appendChild(opt);
  });

  const restoreSpan = () => {
    const ns = document.createElement("span");
    ns.className = "cell-name";
    ns.title = "คลิกเพื่อเปลี่ยน";
    ns.textContent = currentName;
    Object.assign(ns.dataset, { run: runId, day, shift: shiftName, pos: position, slot: slotIndex, name: currentName });
    select.replaceWith(ns);
    ns.addEventListener("click", () => handleNameClick(ns, staffList, runId, busyByDay));
  };

  span.replaceWith(select);
  select.focus();

  select.addEventListener("change", async () => {
    const staffName = select.value;
    if (!staffName) return;
    select.disabled = true;
    try {
      const r = await fetch(`${API}/schedule/${runId}/slot`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ day, shift_name: shiftName, position, slot_index: slotIndex, staff_name: staffName }),
      });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || "assign failed");
      await refreshSchedule();
    } catch (e) {
      restoreSpan();
      alert("เปลี่ยนไม่สำเร็จ: " + e.message);
    }
  });
  select.addEventListener("blur", () => { if (select.value === currentName || !select.value) restoreSpan(); });
}

async function refreshStaff() {
  const list = await loadStaff();
  renderStaffList(list);
  lastCounts.staff = list.length;
  updateNavBadges();
  updateHomeProcessSteps();
}

async function refreshShifts() {
  const list = await loadShifts();
  shiftsCache = Array.isArray(list) ? list : [];
  renderShiftList(list);
  refreshPairShiftsSelect();
  const addGapRules = document.getElementById("staff_add_min_gap_rules");
  if (addGapRules) renderMinGapRulesInputs(addGapRules, []);
  lastCounts.shifts = list.length;
  updateNavBadges();
  updateHomeProcessSteps();
}

function getSkillLevelLabels(skillName) {
  const catalog = window.skillsCatalog || [];
  const skill = catalog.find((s) => (typeof s === "object" ? s.name : s) === skillName);
  if (skill && skill.levels && skill.levels.length) {
    const map = {};
    skill.levels.forEach((l) => { map[l.level] = l.label; });
    return map;
  }
  return {};
}

function renderSkillList(skills) {
  const ul = document.getElementById("skill_list");
  if (!ul) return;
  ul.innerHTML = skills
    .map((s) => {
      const name = typeof s === "string" ? s : s.name;
      const levels = (typeof s === "object" && s.levels) ? s.levels : [];
      const levelsHtml = levels.length
        ? levels.map((l) =>
            `<span class="skill-level-tag" data-skill="${escapeHtml(name)}" data-level="${l.level}">${escapeHtml(l.label)} <button type="button" class="skill-level-x" title="ลบระดับนี้">&times;</button></span>`
          ).join('<span class="skill-level-arrow">&rarr;</span>')
        : '<span class="text-muted" style="font-size:.82rem">ยังไม่มีระดับ</span>';
      return `<li class="skill-list-item skill-item-card" data-skill="${escapeHtml(name)}">
          <div class="skill-item-header">
            <span class="skill-name">${escapeHtml(name)}</span>
            <button type="button" class="small btn-edit-skill" data-name="${escapeHtml(name)}" title="แก้ไขชื่อ">แก้ไข</button>
            <button type="button" class="small btn-delete-skill" data-name="${escapeHtml(name)}" title="ลบทักษะ">ลบ</button>
          </div>
          <div class="skill-levels-row">
            <span class="skill-levels-label">ระดับ:</span>
            <span class="skill-levels-tags">${levelsHtml}</span>
            <span class="skill-level-add-wrap">
              <input type="text" class="skill-level-add-input" placeholder="ชื่อระดับใหม่" data-skill="${escapeHtml(name)}" />
              <button type="button" class="small skill-level-add-btn" data-skill="${escapeHtml(name)}">+</button>
            </span>
          </div>
        </li>`;
    })
    .join("");

  ul.querySelectorAll(".btn-edit-skill").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const oldName = btn.dataset.name;
      if (!oldName) return;
      const newName = prompt("แก้ไขชื่อทักษะ", oldName);
      if (newName == null) return;
      const trimmed = newName.trim();
      if (!trimmed || trimmed === oldName) return;
      try {
        const r = await fetch(API + "/skills/" + encodeURIComponent(oldName), {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: trimmed }),
        });
        if (!r.ok) {
          const d = await r.json().catch(() => ({}));
          alert(formatApiError(d) || r.statusText || "แก้ไขไม่สำเร็จ");
          return;
        }
        await refreshSkills();
      } catch (e) {
        alert("เกิดข้อผิดพลาด: " + e.message);
      }
    });
  });
  ul.querySelectorAll(".btn-delete-skill").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const name = btn.dataset.name;
      if (!name || !confirm("ลบทักษะ \"" + name + "\" ออกจากรายการ?")) return;
      const r = await fetch(API + "/skills/" + encodeURIComponent(name), { method: "DELETE" });
      if (!r.ok) { alert("ลบไม่สำเร็จ"); return; }
      await refreshSkills();
    });
  });

  ul.querySelectorAll(".skill-level-x").forEach((xBtn) => {
    xBtn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const tag = xBtn.closest(".skill-level-tag");
      const skillName = tag.dataset.skill;
      const lvl = parseInt(tag.dataset.level, 10);
      const skill = skills.find((s) => (typeof s === "object" ? s.name : s) === skillName);
      if (!skill || !skill.levels) return;
      const newLabels = skill.levels.filter((l) => l.level !== lvl).map((l) => l.label);
      await saveSkillLevels(skillName, newLabels);
    });
  });

  ul.querySelectorAll(".skill-level-add-btn").forEach((btn) => {
    btn.addEventListener("click", () => addSkillLevel(btn.dataset.skill));
  });
  ul.querySelectorAll(".skill-level-add-input").forEach((input) => {
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); addSkillLevel(input.dataset.skill); }
    });
  });
}

async function addSkillLevel(skillName) {
  const input = document.querySelector(`.skill-level-add-input[data-skill="${skillName}"]`);
  if (!input) return;
  const label = input.value.trim();
  if (!label) return;
  const skill = (window.skillsCatalog || []).find((s) => (typeof s === "object" ? s.name : s) === skillName);
  const existing = (skill && skill.levels) ? skill.levels.map((l) => l.label) : [];
  existing.push(label);
  input.value = "";
  await saveSkillLevels(skillName, existing);
}

async function saveSkillLevels(skillName, labels) {
  try {
    const r = await fetch(API + "/skills/" + encodeURIComponent(skillName) + "/levels", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ levels: labels }),
    });
    if (!r.ok) {
      const d = await r.json().catch(() => ({}));
      alert(formatApiError(d) || "บันทึกระดับไม่สำเร็จ");
      return;
    }
    await refreshSkills();
  } catch (e) {
    alert("เกิดข้อผิดพลาด: " + e.message);
  }
}

var lastCounts = { skills: 0, staff: 0, shifts: 0 };

function updateNavBadges() {
  const el = (id) => document.getElementById(id);
  if (el("nav_badge_skills")) el("nav_badge_skills").textContent = lastCounts.skills;
  if (el("nav_badge_staff")) el("nav_badge_staff").textContent = lastCounts.staff;
  if (el("nav_badge_shifts")) el("nav_badge_shifts").textContent = lastCounts.shifts;
}

function updateHomeProcessSteps() {
  const container = document.getElementById("home_process_steps");
  if (!container) return;
  const numDaysVal = document.getElementById("num_days") && document.getElementById("num_days").value.trim();
  const hasSettings = !!numDaysVal && !isNaN(parseInt(numDaysVal, 10)) && parseInt(numDaysVal, 10) > 0;
  const steps = [
    { num: 1, label: "ตั้งค่า", done: hasSettings },
    { num: 2, label: "ทักษะ", done: lastCounts.skills > 0 },
    { num: 3, label: "บุคลากร", done: lastCounts.staff > 0 },
    { num: 4, label: "กะ", done: lastCounts.shifts > 0 },
    { num: 5, label: "สร้างตาราง", done: false },
  ];
  let html = "";
  steps.forEach((s, i) => {
    const doneClass = s.done ? " done" : "";
    html += `<span class="process-step${doneClass}" role="listitem"><span class="process-step-num">${s.done ? "✓" : s.num}</span> ${escapeHtml(s.label)}</span>`;
    if (i < steps.length - 1) html += '<span class="process-step-connector" aria-hidden="true"></span>';
  });
  container.innerHTML = html;
  const ready = hasSettings && lastCounts.skills > 0 && lastCounts.staff > 0 && lastCounts.shifts > 0;
  const hint = document.getElementById("run_ready_hint");
  if (hint) hint.style.display = ready ? "" : "none";
}

async function refreshSkills() {
  const list = await loadSkills();
  const arr = Array.isArray(list) ? list : [];
  window.skillsCatalog = arr;  // expose globally for position editor
  renderSkillList(arr);
  lastCounts.skills = arr.length;
  updateNavBadges();
  updateHomeProcessSteps();

  // อัปเดต dropdown "ทักษะที่ต้องการ" ในฟอร์มกะให้ตรงกับรายการทักษะล่าสุด
  document.querySelectorAll(".position-required-skill").forEach((sel) => {
    const current = sel.value || "";
    const options = (window.skillsCatalog || []).map((s) => {
      const sname = typeof s === "string" ? s : s.name;
      return `<option value="${escapeHtml(sname)}">${escapeHtml(sname)}</option>`;
    }).join("");
    sel.innerHTML = "<option value=\"\">-- ทักษะ --</option>" + options;
    if (current) sel.value = current;
  });
}

function renderTitleList(titles) {
  const ul = document.getElementById("title_list");
  if (!ul) return;
  const list = Array.isArray(titles) ? titles : [];
  ul.innerHTML = list
    .map(
      (t) =>
        `<li class="skill-list-item">
          <span class="skill-name">${escapeHtml(t.name)} <span class="text-muted">(${t.type === "parttime" ? "พาร์ทไทม์" : "เต็มเวลา"})</span></span>
          <button type="button" class="small btn-delete-title" data-name="${escapeHtml(t.name)}" title="ลบ">ลบ</button>
        </li>`
    )
    .join("");
  ul.querySelectorAll(".btn-delete-title").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const name = btn.dataset.name;
      if (!name || !confirm("ลบฉายา \"" + name + "\"?")) return;
      const r = await fetch(API + "/titles/" + encodeURIComponent(name), { method: "DELETE" });
      if (!r.ok) { alert("ลบไม่สำเร็จ"); return; }
      await refreshTitles();
    });
  });
}

async function refreshTitles() {
  const list = await loadTitles();
  window.titlesCatalog = Array.isArray(list) ? list : [];
  renderTitleList(list);
  await refreshStaffTitleSelect();
}

function fillStaffTitleSelect(titles) {
  const sel = document.getElementById("staff_title_select");
  if (!sel) return;
  const list = Array.isArray(titles) ? titles : [];
  const current = sel.value;
  sel.innerHTML = "<option value=\"\">— เลือก —</option>" + list.map((t) => "<option value=\"" + escapeHtml(t.name) + "\">" + escapeHtml(t.name) + " (" + (t.type === "parttime" ? "พาร์ทไทม์" : "เต็มเวลา") + ")</option>").join("");
  if (current && list.some((t) => t.name === current)) sel.value = current;
}

async function refreshStaffTitleSelect() {
  const list = await loadTitles();
  fillStaffTitleSelect(list);
}

function renderStaffAddSkillsCheckboxes(skills) {
  const container = document.getElementById("staff_add_skills");
  if (!container) return;
  const list = Array.isArray(skills) ? skills : [];
  container.innerHTML = list.length
    ? list
        .map((s) => {
          const sname = typeof s === "string" ? s : s.name;
          return '<label class="staff-skill-cb"><input type="checkbox" name="staff_add_skill" value="' +
            escapeHtml(sname) + '" /> ' + escapeHtml(sname) + "</label>";
        })
        .join(" ")
    : '<span class="text-muted">ยังไม่มีทักษะ — ไปที่หน้าทักษะเพิ่มก่อน</span>';
}

let timeWindowCatalog = [];

async function refreshStaffAddSkills() {
  const list = await loadSkills();
  const arr = Array.isArray(list) ? list : [];
  renderStaffAddSkillsCheckboxes(arr);
  lastCounts.skills = arr.length;
  updateNavBadges();
  updateHomeProcessSteps();
}

async function loadTimeWindows() {
  const r = await fetch(API + "/time-windows");
  const list = await r.json();
  return Array.isArray(list) ? list : [];
}

function renderTimeWindowList(list) {
  const ul = document.getElementById("time_window_list");
  if (!ul) return;
  ul.innerHTML = (list || [])
    .map(
      (tw) =>
        `<li class="skill-list-item">
          <span class="skill-name">${escapeHtml(tw.name)}</span>
          <span class="text-muted" style="font-size:0.85rem"> (${escapeHtml(tw.start_time || "")}–${escapeHtml(tw.end_time || "")})</span>
          <button type="button" class="small btn-delete-skill" data-name="${escapeHtml(tw.name)}" title="ลบช่วงเวลา">ลบ</button>
        </li>`
    )
    .join("");
  ul.querySelectorAll(".btn-delete-skill").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const name = btn.dataset.name;
      if (!name || !confirm("ลบช่วงเวลา \"" + name + "\" ออกจากรายการ?")) return;
      const r = await fetch(API + "/time-windows/" + encodeURIComponent(name), { method: "DELETE" });
      if (!r.ok) { alert("ลบไม่สำเร็จ"); return; }
      await refreshTimeWindows();
    });
  });
}

async function refreshTimeWindows() {
  const list = await loadTimeWindows();
  timeWindowCatalog = list;
  renderTimeWindowList(list);
  const container = document.getElementById("staff_add_time_windows");
  if (container) {
    container.innerHTML = list.length
      ? list.map((tw) => '<label class="staff-tw-cb"><input type="checkbox" name="staff_add_time_window" value="' + escapeHtml(tw.name) + '" /> ' + escapeHtml(tw.name) + "</label>").join(" ")
      : '<span class="text-muted">ยังไม่มีรายการช่วงเวลา — ไปที่หน้าทักษะเพิ่มก่อน</span>';
  }
}

async function refreshStaffAddTimeWindows() {
  const list = await loadTimeWindows();
  timeWindowCatalog = list;
  const container = document.getElementById("staff_add_time_windows");
  if (!container) return;
  container.innerHTML = list.length
    ? list.map((tw) => '<label class="staff-tw-cb"><input type="checkbox" name="staff_add_time_window" value="' + escapeHtml(tw.name) + '" /> ' + escapeHtml(tw.name) + "</label>").join(" ")
    : '<span class="text-muted">ยังไม่มีรายการช่วงเวลา — ไปที่หน้าทักษะเพิ่มก่อน</span>';
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
  loadHolidaysFromString(s.holiday_dates || "");
  syncHolidayHidden();
  renderHolidayCalendar();
}

async function refreshSchedule() {
  try {
    const [data, staffList] = await Promise.all([loadLatestSchedule(), loadStaff().catch(() => [])]);
    renderSchedule(data, staffList);
  } catch {
    renderSchedule(null, []);
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
  try {
    const r = await fetch(API + "/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ num_days, schedule_start_date: schedule_start_date || "" }),
    });
    if (!r.ok) {
      const d = await r.json().catch(() => ({}));
      alert(formatApiError(d) || r.statusText || "บันทึกไม่สำเร็จ");
      return;
    }
  } catch (e) {
    alert("เกิดข้อผิดพลาด: " + e.message);
    return;
  }
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
  const titleEl = document.getElementById("staff_title_select");
  const title = (titleEl && titleEl.value) ? titleEl.value.trim() : "";
  const addOffCbs = document.querySelectorAll("#staff_add_off_days input[name=\"staff_add_off_day\"]:checked");
  const off_days = Array.from(addOffCbs).map((cb) => parseInt(cb.value, 10));
  const addOffMonthEl = document.getElementById("staff_add_off_days_of_month");
  const addMonthMode = document.querySelector("input[name='staff_add_month_mode']:checked");
  const isWorkMode = addMonthMode && addMonthMode.value === "work";
  const rawDays = parseOffDaysOfMonth(addOffMonthEl ? addOffMonthEl.value : "");
  const off_days_of_month = isWorkMode ? workDaysToOffDays(rawDays, getMonthTotalDays()) : rawDays;
  const addSkillCbs = document.querySelectorAll("#staff_add_skills input[name=\"staff_add_skill\"]:checked");
  const skills = Array.from(addSkillCbs).map((cb) => cb.value);
  const addTwCbs = document.querySelectorAll("#staff_add_time_windows input[name=\"staff_add_time_window\"]:checked");
  const time_windows = Array.from(addTwCbs).map((cb) => cb.value);
  const minShiftsEl = document.getElementById("staff_add_min_shifts");
  const maxShiftsEl = document.getElementById("staff_add_max_shifts");
  const minGapEl = document.getElementById("staff_add_min_gap");
  const min_shifts_per_month = minShiftsEl && minShiftsEl.value !== "" ? parseInt(minShiftsEl.value, 10) : null;
  const max_shifts_per_month = maxShiftsEl && maxShiftsEl.value !== "" ? parseInt(maxShiftsEl.value, 10) : null;
  const min_gap_days = minGapEl && minGapEl.value !== "" ? parseInt(minGapEl.value, 10) : null;
  const min_gap_rules = Array.from(document.querySelectorAll("#staff_add_min_gap_rules .min-gap-rule-input"))
    .map((el) => ({ shift: el.dataset.shift, gap_days: el.value !== "" ? parseInt(el.value, 10) : 0 }))
    .filter((r) => r.shift && r.gap_days && r.gap_days > 0);
  try {
    const r = await fetch(API + "/staff", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, title, off_days, off_days_of_month, skills, time_windows, min_shifts_per_month, max_shifts_per_month, min_gap_days, min_gap_shifts: [], min_gap_rules }),
    });
    if (!r.ok) {
      const d = await r.json().catch(() => ({}));
      alert(formatApiError(d) || r.statusText || "เพิ่มไม่สำเร็จ");
      return;
    }
  } catch (e) {
    alert("เกิดข้อผิดพลาด: " + e.message);
    return;
  }
  document.getElementById("staff_name").value = "";
  if (titleEl) titleEl.value = "";
  document.querySelectorAll("#staff_add_off_days input[type=checkbox]").forEach((cb) => { cb.checked = false; });
  if (addOffMonthEl) addOffMonthEl.value = "";
  if (minShiftsEl) minShiftsEl.value = "";
  if (maxShiftsEl) maxShiftsEl.value = "";
  document.querySelectorAll("#staff_add_min_gap_rules .min-gap-rule-input").forEach((el) => { el.value = ""; });
  document.querySelectorAll("#staff_add_time_windows input[type=checkbox]").forEach((cb) => { cb.checked = false; });
  await refreshStaff();
});

document.body.addEventListener("click", async function addSkillHandler(e) {
  if (e.target.id !== "add_skill") return;
  const input = document.getElementById("skill_name");
  const name = (input && input.value.trim()) || "";
  if (!name) {
    alert("กรุณากรอกชื่อทักษะ");
    return;
  }
  try {
    const r = await fetch(API + "/skills", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
    if (!r.ok) {
      const d = await r.json().catch(() => ({}));
      alert(formatApiError(d) || r.statusText || "เพิ่มไม่สำเร็จ");
      return;
    }
    input.value = "";
    await refreshSkills();
  } catch (e) {
    alert("เกิดข้อผิดพลาด: " + e.message);
  }
});

document.getElementById("add_title").addEventListener("click", async () => {
  const input = document.getElementById("title_name");
  const name = (input && input.value.trim()) || "";
  if (!name) {
    alert("กรุณากรอกชื่อฉายา");
    return;
  }
  const typeEl = document.getElementById("title_type");
  const type = (typeEl && typeEl.value) || "fulltime";
  try {
    const r = await fetch(API + "/titles", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, type }),
    });
    if (!r.ok) {
      const d = await r.json().catch(() => ({}));
      alert(formatApiError(d) || r.statusText || "เพิ่มไม่สำเร็จ");
      return;
    }
    input.value = "";
    await refreshTitles();
  } catch (e) {
    alert("เกิดข้อผิดพลาด: " + e.message);
  }
});

document.getElementById("add_time_window").addEventListener("click", async () => {
  const startEl = document.getElementById("time_window_start");
  const endEl = document.getElementById("time_window_end");
  const nameEl = document.getElementById("time_window_name");
  const start_time = (startEl && startEl.value.trim()) || "";
  const end_time = (endEl && endEl.value.trim()) || "";
  if (!start_time || !end_time) {
    alert("กรุณากรอกเวลาเริ่ม-สิ้นสุด (เช่น 06:30, 12:00)");
    return;
  }
  const name = (nameEl && nameEl.value.trim()) || (start_time + "-" + end_time);
  try {
    const r = await fetch(API + "/time-windows", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, start_time, end_time }),
    });
    if (!r.ok) {
      const d = await r.json().catch(() => ({}));
      alert(formatApiError(d) || r.statusText || "เพิ่มไม่สำเร็จ");
      return;
    }
    if (startEl) startEl.value = "";
    if (endEl) endEl.value = "";
    if (nameEl) nameEl.value = "";
    await refreshTimeWindows();
  } catch (e) {
    alert("เกิดข้อผิดพลาด: " + e.message);
  }
});

function addPositionRow(name = "", note = "", slotCount = 1, timeWindowName = "", requiredSkill = "", minSkillLevel = 0, allowedTitles = [], maxPerWeek = 0, activeWeekdays = "") {
  const list = document.getElementById("shift_positions_list");
  const posIndex = list.querySelectorAll(".pos-card").length + 1;
  const card = document.createElement("div");
  card.className = "pos-card";

  const hasAdvanced = !!(requiredSkill || minSkillLevel || (allowedTitles && allowedTitles.length) || maxPerWeek || note || activeWeekdays);

  // --- Header row: badge + name + count + time window + toggle + delete ---
  const header = document.createElement("div");
  header.className = "pos-card-header";

  const badge = document.createElement("span");
  badge.className = "pos-badge";
  badge.textContent = posIndex;

  const nameIn = document.createElement("input");
  nameIn.type = "text";
  nameIn.className = "position-name";
  nameIn.placeholder = "ชื่อช่อง";
  nameIn.value = name;

  const countIn = document.createElement("input");
  countIn.type = "number";
  countIn.className = "position-slot-count";
  countIn.placeholder = "คน";
  countIn.min = 1;
  countIn.max = 99;
  countIn.value = slotCount >= 1 ? slotCount : 1;
  countIn.title = "จำนวนคน";

  const countLabel = document.createElement("span");
  countLabel.className = "pos-count-label";
  countLabel.textContent = "คน";

  const twSel = document.createElement("select");
  twSel.className = "position-time-window";
  twSel.title = "ช่วงเวลา";
  twSel.innerHTML = "<option value=\"\">-- เวลา --</option>" + (timeWindowCatalog || []).map((tw) => "<option value=\"" + escapeHtml(tw.name) + "\">" + escapeHtml(tw.name) + "</option>").join("");
  if (timeWindowName) twSel.value = timeWindowName;

  const toggleBtn = document.createElement("button");
  toggleBtn.type = "button";
  toggleBtn.className = "pos-toggle-btn" + (hasAdvanced ? " has-settings" : "");
  toggleBtn.title = "ตั้งค่าเพิ่มเติม";
  toggleBtn.textContent = hasAdvanced ? "▾ ตั้งค่า" : "▸ ตั้งค่า";

  const delBtn = document.createElement("button");
  delBtn.type = "button";
  delBtn.className = "small btn-remove-position";
  delBtn.textContent = "ลบ";
  delBtn.addEventListener("click", () => {
    card.remove();
    renumberPositionBadges();
  });

  header.appendChild(badge);
  header.appendChild(nameIn);
  header.appendChild(countIn);
  header.appendChild(countLabel);
  header.appendChild(twSel);
  header.appendChild(toggleBtn);
  header.appendChild(delBtn);

  // --- Advanced panel (hidden by default) ---
  const adv = document.createElement("div");
  adv.className = "pos-card-advanced";
  adv.style.display = hasAdvanced ? "" : "none";

  const skillSel = document.createElement("select");
  skillSel.className = "position-required-skill";
  skillSel.title = "ทักษะที่ต้องการ";
  const skillOptions = (window.skillsCatalog || []).map((s) => {
    const sname = typeof s === "string" ? s : s.name;
    return "<option value=\"" + escapeHtml(sname) + "\">" + escapeHtml(sname) + "</option>";
  }).join("");
  skillSel.innerHTML = "<option value=\"\">-- ทักษะ --</option>" + skillOptions;
  if (requiredSkill) skillSel.value = requiredSkill;

  const lvlSel = document.createElement("select");
  lvlSel.className = "position-min-skill-level";
  lvlSel.title = "ระดับทักษะขั้นต่ำ";

  function updateLvlOptions(selectedSkill, keepValue) {
    const skill = (window.skillsCatalog || []).find((s) => (typeof s === "object" ? s.name : s) === selectedSkill);
    const levels = (skill && skill.levels) ? skill.levels : [];
    let html = "<option value=\"0\">ระดับใดก็ได้</option>";
    if (levels.length) {
      levels.forEach((l) => { html += "<option value=\"" + l.level + "\">≥ " + escapeHtml(l.label) + "</option>"; });
    }
    lvlSel.innerHTML = html;
    if (keepValue != null) lvlSel.value = String(keepValue);
  }
  updateLvlOptions(requiredSkill, minSkillLevel || 0);
  skillSel.addEventListener("change", () => { updateLvlOptions(skillSel.value, 0); });

  const titlesWrap = document.createElement("span");
  titlesWrap.className = "position-allowed-titles-wrap";
  titlesWrap.title = "ฉายาที่อนุญาต (ไม่เลือก = ทุกฉายา)";
  const titlesLabel = document.createElement("small");
  titlesLabel.textContent = "ฉายา: ";
  titlesWrap.appendChild(titlesLabel);
  (window.titlesCatalog || []).forEach((t) => {
    const tname = typeof t === "object" ? t.name : t;
    const lbl = document.createElement("label");
    lbl.className = "position-title-cb";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.name = "position_allowed_title";
    cb.value = tname;
    if (Array.isArray(allowedTitles) && allowedTitles.includes(tname)) cb.checked = true;
    lbl.appendChild(cb);
    lbl.appendChild(document.createTextNode(" " + tname));
    titlesWrap.appendChild(lbl);
  });

  const mpwSel = document.createElement("select");
  mpwSel.className = "position-max-per-week";
  mpwSel.title = "จำนวนสูงสุดต่อสัปดาห์ (0 = ไม่จำกัด)";
  mpwSel.innerHTML = '<option value="0">ไม่จำกัด/wk</option><option value="1">≤1/wk</option><option value="2">≤2/wk</option><option value="3">≤3/wk</option>';
  mpwSel.value = String(maxPerWeek || 0);

  const awWrap = document.createElement("span");
  awWrap.className = "position-active-weekdays-wrap";
  awWrap.title = "เปิดเฉพาะวัน (0=จ … 6=อา) เช่น 6 = อาทิตย์เท่านั้น ว่าง = ทุกวันที่กะเปิด";
  const awLabel = document.createElement("label");
  awLabel.textContent = "เปิดเฉพาะวัน: ";
  const awIn = document.createElement("input");
  awIn.type = "text";
  awIn.className = "position-active-weekdays";
  awIn.placeholder = "ว่าง=ทุกวัน หรือ 6 หรือ 5,6";
  awIn.value = activeWeekdays || "";
  awIn.style.width = "6rem";
  awWrap.appendChild(awLabel);
  awWrap.appendChild(awIn);

  const noteIn = document.createElement("input");
  noteIn.type = "text";
  noteIn.className = "position-note";
  noteIn.placeholder = "หมายเหตุ";
  noteIn.value = note;

  adv.appendChild(skillSel);
  adv.appendChild(lvlSel);
  adv.appendChild(titlesWrap);
  adv.appendChild(mpwSel);
  adv.appendChild(awWrap);
  adv.appendChild(noteIn);

  // Toggle handler
  toggleBtn.addEventListener("click", () => {
    const isOpen = adv.style.display !== "none";
    adv.style.display = isOpen ? "none" : "";
    toggleBtn.textContent = isOpen ? "▸ ตั้งค่า" : "▾ ตั้งค่า";
  });

  card.appendChild(header);
  card.appendChild(adv);
  list.appendChild(card);
}

function renumberPositionBadges() {
  const cards = document.querySelectorAll("#shift_positions_list .pos-card");
  cards.forEach((card, i) => {
    const badge = card.querySelector(".pos-badge");
    if (badge) badge.textContent = i + 1;
  });
}

function collectShiftPositions() {
  const cards = document.querySelectorAll("#shift_positions_list .pos-card");
  const positions = [];
  cards.forEach((card) => {
    const name = (card.querySelector(".position-name") && card.querySelector(".position-name").value.trim()) || "";
    const note = (card.querySelector(".position-note") && card.querySelector(".position-note").value.trim()) || "";
    const countEl = card.querySelector(".position-slot-count");
    const slot_count = countEl && countEl.value !== "" ? Math.max(1, parseInt(countEl.value, 10) || 1) : 1;
    const twEl = card.querySelector(".position-time-window");
    const time_window_name = (twEl && twEl.value && twEl.value.trim()) || null;
    const skillEl = card.querySelector(".position-required-skill");
    const required_skill = (skillEl && skillEl.value && skillEl.value.trim()) || null;
    const lvlEl = card.querySelector(".position-min-skill-level");
    const min_skill_level = lvlEl ? parseInt(lvlEl.value, 10) || 0 : 0;
    const titleCbs = card.querySelectorAll("input[name=\"position_allowed_title\"]:checked");
    const allowed_titles = Array.from(titleCbs).map((cb) => cb.value);
    const mpwEl = card.querySelector(".position-max-per-week");
    const max_per_week = mpwEl ? parseInt(mpwEl.value, 10) || 0 : 0;
    const awEl = card.querySelector(".position-active-weekdays");
    const active_weekdays = (awEl && awEl.value && awEl.value.trim()) || null;
    if (name) positions.push({ name, constraint_note: note, regular_only: false, slot_count, time_window_name, required_skill, min_skill_level, allowed_titles, max_per_week, active_weekdays });
  });
  return positions;
}

document.getElementById("add_position_row").addEventListener("click", () => addPositionRow());

function updatePositionBulkActions() {
  const list = document.getElementById("shift_positions_list");
  const count = list.querySelectorAll(".pos-card").length;
  let bar = document.getElementById("pos_bulk_actions");
  if (count < 3) {
    if (bar) bar.remove();
    return;
  }
  if (!bar) {
    bar = document.createElement("div");
    bar.id = "pos_bulk_actions";
    bar.className = "pos-bulk-actions";
    list.parentElement.insertBefore(bar, list);
  }
  bar.innerHTML = "";
  const countSpan = document.createElement("span");
  countSpan.className = "pos-bulk-count";
  countSpan.textContent = count + " ช่อง";
  bar.appendChild(countSpan);
  const expandAll = document.createElement("button");
  expandAll.type = "button";
  expandAll.className = "small";
  expandAll.textContent = "ขยายทั้งหมด";
  expandAll.addEventListener("click", () => {
    list.querySelectorAll(".pos-card-advanced").forEach((a) => { a.style.display = ""; });
    list.querySelectorAll(".pos-toggle-btn").forEach((b) => { b.textContent = "▾ ตั้งค่า"; });
  });
  bar.appendChild(expandAll);
  const collapseAll = document.createElement("button");
  collapseAll.type = "button";
  collapseAll.className = "small";
  collapseAll.textContent = "ย่อทั้งหมด";
  collapseAll.addEventListener("click", () => {
    list.querySelectorAll(".pos-card-advanced").forEach((a) => { a.style.display = "none"; });
    list.querySelectorAll(".pos-toggle-btn").forEach((b) => { b.textContent = "▸ ตั้งค่า"; });
  });
  bar.appendChild(collapseAll);
}

const posListObserver = new MutationObserver(updatePositionBulkActions);
posListObserver.observe(document.getElementById("shift_positions_list"), { childList: true });

document.getElementById("add_shift").addEventListener("click", async () => {
  const name = document.getElementById("shift_name").value.trim();
  if (!name) {
    alert("กรอกชื่อกะ");
    return;
  }
  let positions = collectShiftPositions();
  if (positions.length === 0) positions = [{ name: "ช่อง 1", constraint_note: "", regular_only: false }];
  const activeDaysEl = document.getElementById("shift_active_days");
  const active_days = (activeDaysEl && activeDaysEl.value.trim()) || null;
  const inclHolEl = document.getElementById("shift_include_holidays");
  const include_holidays = inclHolEl ? inclHolEl.checked : false;
  const mfEl = document.getElementById("shift_min_fulltime");
  const min_fulltime = mfEl ? Math.max(0, parseInt(mfEl.value, 10) || 0) : 0;
  const isEdit = currentShiftId != null;
  const url = isEdit ? API + "/shifts/" + currentShiftId : API + "/shifts";
  const method = isEdit ? "PUT" : "POST";
  try {
    const r = await fetch(url, {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, positions, active_days, include_holidays, min_fulltime }),
    });
    if (!r.ok) {
      const d = await r.json().catch(() => ({}));
      alert(formatApiError(d) || r.statusText || "บันทึกไม่สำเร็จ");
      return;
    }
  } catch (e) {
    alert("เกิดข้อผิดพลาด: " + e.message);
    return;
  }
  resetShiftForm();
  await refreshShifts();
});

const shiftEditCancelBtn = document.getElementById("shift_edit_cancel");
if (shiftEditCancelBtn) {
  shiftEditCancelBtn.addEventListener("click", () => {
    resetShiftForm();
  });
}

async function applyTemplate(templateId) {
  const r = await fetch(API + "/apply-template?template=" + templateId, { method: "POST" });
  if (!r.ok) {
    const d = await r.json().catch(() => ({}));
    alert(formatApiError(d) || r.statusText || "โหลดเทมเพลตไม่สำเร็จ");
    return;
  }
  const data = await r.json().catch(() => ({}));
  await Promise.all([refreshStaff(), refreshShifts(), refreshSkills(), refreshTitles(), refreshTimeWindows(), refreshSettings(), refreshPairs(), refreshSchedule()]);
  refreshStaffAddSkills();
  refreshStaffTitleSelect();
  refreshStaffAddTimeWindows();
  // แจ้งผล
  const staffCount = data.staff_count != null ? data.staff_count : "";
  const shiftCount = Array.isArray(data.shift_ids) ? data.shift_ids.length : "";
  const msg = document.getElementById("run_message");
  if (msg) {
    msg.textContent = `โหลด Template ${templateId} สำเร็จ` +
      (staffCount ? ` — บุคลากร ${staffCount} คน` : "") +
      (shiftCount ? `, ${shiftCount} กะ` : "") +
      " — พร้อมสร้างตารางเวร";
    msg.className = "message success";
  }
  await showPage("home");
}

document.getElementById("template_1").addEventListener("click", () => applyTemplate(1));
document.getElementById("template_2").addEventListener("click", () => applyTemplate(2));
document.getElementById("template_5").addEventListener("click", () => applyTemplate(5));
document.getElementById("template_3").addEventListener("click", () => applyTemplate(3));
document.getElementById("template_4").addEventListener("click", () => applyTemplate(4));

document.getElementById("clear_all").addEventListener("click", async () => {
  if (!confirm("ล้างทั้งหมด (บุคลากร, กะ, ตาราง) — กลับเป็นหน้าว่าง?\nการกระทำนี้ยกเลิกไม่ได้")) return;
  const r = await fetch(API + "/clear-all", { method: "POST" });
  if (!r.ok) {
    const d = await r.json().catch(() => ({}));
    alert(formatApiError(d) || r.statusText || "ล้างไม่สำเร็จ");
    return;
  }
  await Promise.all([refreshStaff(), refreshShifts(), refreshSkills(), refreshTitles(), refreshTimeWindows(), refreshSchedule()]);
  refreshStaffAddSkills();
  refreshStaffTitleSelect();
  refreshStaffAddTimeWindows();
  updateNavBadges();
  updateHomeProcessSteps();
  document.getElementById("staff_detail_content").innerHTML = "";
  document.getElementById("staff_detail_empty").style.display = "";
  document.getElementById("staff_detail_content").style.display = "none";
});

document.getElementById("run_schedule").addEventListener("click", async () => {
  const btn = document.getElementById("run_schedule");
  const btnText = btn && btn.querySelector(".btn-text");
  const defaultText = (btn && btn.getAttribute("data-default-text")) || "สร้างตารางเวร";
  const msg = document.getElementById("run_message");
  msg.textContent = "";
  msg.className = "message";
  if (btn) {
    btn.disabled = true;
    btn.classList.add("is-loading");
    if (btnText) btnText.textContent = "กำลังสร้าง...";
  }
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
          if (btn) { btn.disabled = false; btn.classList.remove("is-loading"); if (btnText) btnText.textContent = defaultText; }
          return;
        }
      } catch {
        msg.textContent = "กรอกจำนวนวันเป็นตัวเลข 1–31 ในช่อง \"จำนวนวัน\"";
        msg.className = "message error";
        if (btn) { btn.disabled = false; btn.classList.remove("is-loading"); if (btnText) btnText.textContent = defaultText; }
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
      const detail = data.detail;
      if (detail && typeof detail === "object" && Array.isArray(detail.reasons)) {
        msg.innerHTML = "<strong>จัดตารางไม่ได้ — สาเหตุที่เป็นไปได้:</strong><ul class=\"reasons-list\">" +
          detail.reasons.map((r) => "<li>" + escapeHtml(r) + "</li>").join("") + "</ul>";
      } else {
        msg.textContent = (detail && (typeof detail === "string" ? detail : detail.message)) || r.statusText || "เกิดข้อผิดพลาด";
      }
      msg.className = "message error";
      msg.style.whiteSpace = "pre-wrap";
      if (btn) { btn.disabled = false; btn.classList.remove("is-loading"); if (btnText) btnText.textContent = defaultText; }
      return;
    }
    if (btn) { btn.disabled = false; btn.classList.remove("is-loading"); if (btnText) btnText.textContent = defaultText; }
    if (data.has_dummy && data.dummy_count > 0) {
      const hints = (data.infeasibility_hints || []).map((h) => "<li>" + escapeHtml(h) + "</li>").join("");
      msg.innerHTML = `<strong>⚠ สร้างตารางได้บางส่วน — ว่าง ${data.dummy_count} ช่อง</strong> (คนไม่พอหรือมีข้อจำกัด)<br>` +
        (hints ? `<ul class="reasons-list">${hints}</ul>` : "") +
        `<br>ไปที่หน้า "ตารางล่าสุด" แล้วคลิก <strong>ว่าง</strong> เพื่อมอบหมายเอง`;
      msg.className = "message warning";
    } else {
      msg.textContent = "สร้างตารางเรียบร้อย (Run #" + data.run_id + ")";
      msg.className = "message success";
    }
    await refreshSettings();
    await refreshSchedule();
    updateHomeProcessSteps();
    showPage("schedule");
  } catch (e) {
    msg.textContent = "Error: " + e.message;
    msg.className = "message error";
    if (btn) { btn.disabled = false; btn.classList.remove("is-loading"); if (btnText) btnText.textContent = defaultText; }
  }
});

async function showPage(pageId) {
  document.querySelectorAll(".app-page").forEach((el) => {
    el.style.display = el.id === "page-" + pageId ? "" : "none";
  });
  document.querySelectorAll(".app-nav-item").forEach((a) => {
    a.classList.toggle("active", a.dataset.page === pageId);
  });
  if (pageId === "home") {
    refreshPairs();
  }
  if (pageId === "skills") {
    await refreshSkills();
    await refreshTitles();
    await refreshTimeWindows();
  }
  if (pageId === "staff") {
    refreshStaffAddSkills();
    refreshStaffTitleSelect();
    refreshStaffAddTimeWindows();
  }
  if (pageId === "shifts") {
    fetch(API + "/time-windows").then((r) => r.ok ? r.json() : []).then((list) => { timeWindowCatalog = Array.isArray(list) ? list : []; }).catch(() => {});
    await Promise.all([refreshShifts(), refreshSkills(), refreshTitles()]);
  }
}

document.querySelectorAll(".app-nav-item").forEach((a) => {
  a.addEventListener("click", async (e) => {
    e.preventDefault();
    await showPage(a.dataset.page);
  });
});

document.querySelectorAll("input[name='staff_add_month_mode']").forEach((radio) => {
  radio.addEventListener("change", () => {
    const label = document.getElementById("staff_add_month_label");
    const input = document.getElementById("staff_add_off_days_of_month");
    if (radio.value === "work") {
      if (label) label.textContent = "วันทำงานรายเดือน (วันที่)";
      if (input) input.placeholder = "เช่น 1, 5, 12 (กรอกเฉพาะวันที่มาทำงาน)";
    } else {
      if (label) label.textContent = "วันหยุดรายเดือน (วันที่)";
      if (input) input.placeholder = "เช่น 1, 15, 31";
    }
  });
});

// --- Holiday calendar ---
let holidaySet = new Set();

function getCalendarMonth() {
  const startDate = (document.getElementById("schedule_start_date").value || "").trim();
  if (!startDate) return null;
  const [y, m] = startDate.split("-").map(Number);
  if (!y || !m) return null;
  return { year: y, month: m };
}

function renderHolidayCalendar() {
  const container = document.getElementById("holiday_calendar");
  if (!container) return;
  const info = getCalendarMonth();
  if (!info) {
    container.innerHTML = '<span class="text-muted">ตั้งวันเริ่มต้นก่อน แล้วจะแสดงปฏิทินให้เลือก</span>';
    return;
  }
  const { year, month } = info;
  const daysInMonth = new Date(year, month, 0).getDate();
  const firstDow = new Date(year, month - 1, 1).getDay();
  const startIdx = firstDow === 0 ? 6 : firstDow - 1;
  const pad = (n) => String(n).padStart(2, "0");
  const monthNames = ["", "ม.ค.", "ก.พ.", "มี.ค.", "เม.ย.", "พ.ค.", "มิ.ย.", "ก.ค.", "ส.ค.", "ก.ย.", "ต.ค.", "พ.ย.", "ธ.ค."];

  let html = `<div style="font-weight:600; margin-bottom:.25rem">${monthNames[month]} ${year + 543}</div>`;
  html += '<div class="holiday-cal-header"><span>จ</span><span>อ</span><span>พ</span><span>พฤ</span><span>ศ</span><span>ส</span><span>อา</span></div>';
  html += '<div class="holiday-cal-grid">';
  for (let i = 0; i < startIdx; i++) html += '<div class="hcal-day empty"></div>';
  for (let d = 1; d <= daysInMonth; d++) {
    const iso = `${year}-${pad(month)}-${pad(d)}`;
    const date = new Date(year, month - 1, d);
    const dow = date.getDay();
    const isWeekend = dow === 0 || dow === 6;
    const isHoliday = holidaySet.has(iso);
    const cls = ["hcal-day"];
    if (isWeekend) cls.push("weekend");
    if (isHoliday) cls.push("holiday");
    html += `<div class="${cls.join(" ")}" data-date="${iso}">${d}</div>`;
  }
  html += '</div>';
  html += '<div class="holiday-cal-legend">';
  html += '<span><span class="legend-swatch lh"></span>วันหยุด</span>';
  html += '<span><span class="legend-swatch lw"></span>วันปกติ</span>';
  html += `<span style="margin-left:auto; font-size:.8rem">เลือกแล้ว <strong id="holiday_count">${holidaySet.size}</strong> วัน</span>`;
  html += '</div>';
  container.innerHTML = html;

  container.querySelectorAll(".hcal-day:not(.empty)").forEach((el) => {
    el.addEventListener("click", () => {
      const iso = el.dataset.date;
      if (holidaySet.has(iso)) {
        holidaySet.delete(iso);
        el.classList.remove("holiday");
      } else {
        holidaySet.add(iso);
        el.classList.add("holiday");
      }
      syncHolidayHidden();
      const countEl = document.getElementById("holiday_count");
      if (countEl) countEl.textContent = holidaySet.size;
    });
  });
}

function syncHolidayHidden() {
  const el = document.getElementById("holiday_dates");
  if (el) el.value = Array.from(holidaySet).sort().join(",");
}

function loadHolidaysFromString(isoStr) {
  holidaySet.clear();
  if (!isoStr) return;
  for (const part of isoStr.split(",")) {
    const t = part.trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(t)) holidaySet.add(t);
  }
}

document.getElementById("save_holidays").addEventListener("click", async () => {
  syncHolidayHidden();
  const val = document.getElementById("holiday_dates").value || "";
  const msgEl = document.getElementById("holiday_save_msg");
  try {
    const r = await fetch(API + "/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ holiday_dates: val }),
    });
    if (!r.ok) {
      const d = await r.json().catch(() => ({}));
      if (msgEl) { msgEl.textContent = formatApiError(d) || "บันทึกไม่สำเร็จ"; msgEl.style.color = "#c62828"; }
      return;
    }
    if (msgEl) { msgEl.textContent = "บันทึกแล้ว (" + holidaySet.size + " วัน)"; msgEl.style.color = "#2e7d32"; }
  } catch (e) {
    if (msgEl) { msgEl.textContent = "ผิดพลาด: " + e.message; msgEl.style.color = "#c62828"; }
  }
});

document.getElementById("schedule_start_date").addEventListener("change", () => {
  renderHolidayCalendar();
});

// --- Import / Export ---
document.getElementById("export_json").addEventListener("click", async () => {
  try {
    const r = await fetch(API + "/export");
    const data = await r.json();
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "mt-shift-config.json";
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  } catch (e) {
    alert("Export ไม่สำเร็จ: " + e.message);
  }
});

document.getElementById("import_json_file").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  if (!confirm("Import จะล้างข้อมูลเก่าทั้งหมด แล้วโหลดจากไฟล์ — ดำเนินการ?")) {
    e.target.value = "";
    return;
  }
  try {
    const text = await file.text();
    const data = JSON.parse(text);
    const r = await fetch(API + "/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    });
    if (!r.ok) {
      const d = await r.json().catch(() => ({}));
      alert(formatApiError(d) || "Import ไม่สำเร็จ");
      return;
    }
    alert("Import สำเร็จ");
    await Promise.all([refreshStaff(), refreshShifts(), refreshSkills(), refreshTitles(), refreshTimeWindows(), refreshSettings(), refreshSchedule(), refreshPairs()]);
  } catch (err) {
    alert("Import ไม่สำเร็จ: " + err.message);
  }
  e.target.value = "";
});

// --- Staff Pairs ---
function refreshPairShiftsSelect() {
  const wrap = document.getElementById("pair_shifts_checkboxes");
  const filterOn = document.getElementById("pair_shift_filter_on");
  if (!wrap || !filterOn) return;
  const shifts = Array.isArray(shiftsCache) ? shiftsCache : [];
  wrap.innerHTML = shifts.map((s) =>
    `<label class="pair-shift-chip" style="display:inline-flex; align-items:center; gap:.25rem; padding:.25rem .5rem; background:var(--surface-2, #f8fafc); border:1px solid var(--border, #e2e8f0); border-radius:var(--radius-sm, 6px); cursor:pointer; font-size:.88rem; user-select:none">
      <input type="checkbox" class="pair-shift-cb" value="${escapeHtml(s.name)}" />
      <span>${escapeHtml(s.name)}</span>
    </label>`
  ).join("");
}

function getPairSelectedShifts() {
  const filterOn = document.getElementById("pair_shift_filter_on");
  if (!filterOn || !filterOn.checked) return [];
  const cbs = document.querySelectorAll(".pair-shift-cb:checked");
  return Array.from(cbs).map((el) => el.value).filter(Boolean);
}

async function refreshPairs() {
  try {
    const r = await fetch(API + "/staff-pairs");
    const pairs = await r.json();
    const ul = document.getElementById("pair_list");
    if (!ul) return;
    ul.innerHTML = (pairs || []).map((p) => {
      let typeLabel, cls, arrow;
      if (p.pair_type === "together") { typeLabel = "อยู่ด้วยกัน"; cls = "pair-together"; arrow = "↔"; }
      else if (p.pair_type === "depends_on") { typeLabel = "ต้องอยู่กับ"; cls = "pair-depends"; arrow = "→"; }
      else { typeLabel = "ห้ามอยู่ด้วยกัน"; cls = "pair-apart"; arrow = "↔"; }
      const shiftNote = (p.shift_names || []).length > 0
        ? ` <span class="text-muted" style="font-size:.82rem">(เฉพาะ ${(p.shift_names || []).map((s) => escapeHtml(s)).join(", ")})</span>`
        : "";
      const label = p.pair_type === "depends_on"
        ? `${escapeHtml(p.name_2)} ${arrow} ต้องอยู่กับ ${escapeHtml(p.name_1)}`
        : `${escapeHtml(p.name_1)} ${arrow} ${escapeHtml(p.name_2)} (${typeLabel})`;
      return `<li class="skill-list-item"><span class="${cls}">${label}${shiftNote}</span> <button type="button" class="small btn-delete-pair" data-id="${p.id}">ลบ</button></li>`;
    }).join("");
    ul.querySelectorAll(".btn-delete-pair").forEach((btn) => {
      btn.addEventListener("click", async () => {
        await fetch(API + "/staff-pairs/" + btn.dataset.id, { method: "DELETE" });
        await refreshPairs();
      });
    });
  } catch {}
  try {
    const staff = await loadStaff();
    const sel1 = document.getElementById("pair_staff_1");
    const sel2 = document.getElementById("pair_staff_2");
    if (sel1 && sel2) {
      const opts = '<option value="">-- เลือก --</option>' + (staff || []).map((s) => `<option value="${s.id}">${escapeHtml(s.name)}</option>`).join("");
      sel1.innerHTML = opts;
      sel2.innerHTML = opts;
    }
  } catch {}
  refreshPairShiftsSelect();
  const filterOn = document.getElementById("pair_shift_filter_on");
  const wrap = document.getElementById("pair_shifts_checkboxes");
  if (filterOn && wrap && !filterOn.dataset.bound) {
    filterOn.dataset.bound = "1";
    wrap.style.display = filterOn.checked ? "flex" : "none";
    filterOn.onchange = () => { wrap.style.display = filterOn.checked ? "flex" : "none"; };
  }
}

document.getElementById("add_pair").addEventListener("click", async () => {
  const s1 = document.getElementById("pair_staff_1").value;
  const s2 = document.getElementById("pair_staff_2").value;
  const pt = document.getElementById("pair_type").value;
  const shiftNames = getPairSelectedShifts();
  if (!s1 || !s2) { alert("เลือกบุคลากรทั้ง 2 คน"); return; }
  if (s1 === s2) { alert("ต้องเลือกคนละคน"); return; }
  try {
    const body = { staff_id_1: parseInt(s1, 10), staff_id_2: parseInt(s2, 10), pair_type: pt };
    if (shiftNames.length > 0) body.shift_names = shiftNames;
    const r = await fetch(API + "/staff-pairs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!r.ok) {
      const d = await r.json().catch(() => ({}));
      alert(formatApiError(d) || "เพิ่มไม่สำเร็จ");
      return;
    }
    await refreshPairs();
  } catch (e) {
    alert("เกิดข้อผิดพลาด: " + e.message);
  }
});

async function init() {
  fillPresetYear();
  fetch(API + "/time-windows").then((r) => r.ok ? r.json() : []).then((list) => { timeWindowCatalog = Array.isArray(list) ? list : []; }).catch(() => {});
  addPositionRow();
  await showPage("home");
  await refreshSettings();
  await Promise.all([refreshStaff(), refreshShifts(), refreshSkills(), refreshTitles()]);
  await refreshStaffAddSkills();
  await refreshStaffTitleSelect();
  await refreshStaffAddTimeWindows();
  await refreshSchedule();
  await refreshPairs();
}

init();
