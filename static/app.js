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

/** เช็คว่า staff หยุดวันนี้ไหม (off_days=weekday, off_days_of_month=วันที่ของเดือน) */
function _isStaffOffOnDay(mt, dayIndex, startDate) {
  if (!startDate) return false;
  const [y, m, d] = startDate.split("-").map(Number);
  const date = new Date(y, m - 1, d + dayIndex);
  const weekday = (date.getDay() + 6) % 7; // JS Sun=0 → Python Mon=0
  if (mt.off_days && mt.off_days.includes(weekday)) return true;
  if (mt.off_days_of_month && mt.off_days_of_month.includes(date.getDate())) return true;
  return false;
}

function _timeToMinutes(text) {
  const raw = String(text || "").trim();
  if (!/^\d{2}:\d{2}$/.test(raw)) return NaN;
  const [hh, mm] = raw.split(":").map(Number);
  if (Number.isNaN(hh) || Number.isNaN(mm) || mm < 0 || mm > 59) return NaN;
  if (hh === 24 && mm === 0) return 24 * 60;
  if (hh < 0 || hh > 23) return NaN;
  return hh * 60 + mm;
}

function _windowContains(catalogByName, staffWindowName, positionWindowName) {
  if (!positionWindowName || !staffWindowName) return true;
  const pos = catalogByName[positionWindowName];
  const staff = catalogByName[staffWindowName];
  if (!pos || !staff) return false;
  const posStart = _timeToMinutes(pos.start_time);
  const posEnd = _timeToMinutes(pos.end_time);
  const staffStart = _timeToMinutes(staff.start_time);
  const staffEnd = _timeToMinutes(staff.end_time);
  if ([posStart, posEnd, staffStart, staffEnd].some((n) => Number.isNaN(n))) return false;
  return staffStart <= posStart && staffEnd >= posEnd;
}

function _canWorkPositionTimeWindow(mt, positionTimeWindowName) {
  const twName = (positionTimeWindowName || "").trim();
  if (!twName) return true;
  const catalogByName = {};
  (Array.isArray(timeWindowCatalog) ? timeWindowCatalog : []).forEach((tw) => {
    if (!tw || !tw.name) return;
    catalogByName[String(tw.name)] = {
      start_time: tw.start_time || "",
      end_time: tw.end_time || "",
    };
  });
  const candidateWindows = Array.isArray(mt.time_windows) ? mt.time_windows.filter(Boolean) : [];
  if (!candidateWindows.length) return false;
  return candidateWindows.some((staffWindowName) => _windowContains(catalogByName, String(staffWindowName), twName));
}

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

let _toastSeq = 0;
function showToast(message, type = "success", durationMs = 2600) {
  const text = String(message || "").trim();
  if (!text) return;
  let container = document.getElementById("app_toast_container");
  if (!container) {
    container = document.createElement("div");
    container.id = "app_toast_container";
    container.className = "app-toast-container";
    document.body.appendChild(container);
  }
  const toast = document.createElement("div");
  toast.className = "app-toast " + (type === "error" ? "error" : "success");
  toast.setAttribute("role", "status");
  toast.dataset.toastId = String(++_toastSeq);
  toast.textContent = text;
  container.appendChild(toast);
  const remove = () => {
    toast.classList.add("hide");
    setTimeout(() => {
      if (toast.parentElement) toast.remove();
      if (container && container.childElementCount === 0) container.remove();
    }, 180);
  };
  setTimeout(remove, Math.max(1200, durationMs));
}

// Shift editor state
let shiftsCache = [];
let currentShiftId = null;
let pairRulesCache = [];

// Swap state
let _swapPending = null;
let _lastSwap = null; // เก็บข้อมูล swap ล่าสุดเพื่อ undo
function _clearSwapPending() {
  if (_swapPending) {
    _swapPending.span.classList.remove("cell-name-swap-pending");
    _swapPending = null;
  }
}
function _showUndoSwapBanner() {
  const old = document.getElementById("undo_swap_banner");
  if (old) old.remove();
  if (!_lastSwap) return;
  const banner = document.createElement("div");
  banner.id = "undo_swap_banner";
  banner.className = "undo-swap-banner";
  banner.innerHTML = `<span>สลับ "${_lastSwap.name_a}" ↔ "${_lastSwap.name_b}" แล้ว</span> <button id="undo_swap_btn">↩ ยกเลิก</button>`;
  const wrap = document.getElementById("scheduleTableWrap") || document.body;
  wrap.parentElement.insertBefore(banner, wrap);
  document.getElementById("undo_swap_btn").addEventListener("click", async () => {
    const s = _lastSwap;
    if (!s) return;
    _lastSwap = null;
    banner.remove();
    try {
      const r = await fetch(`${API}/schedule/${s.runId}/swap`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          day_a: s.day_a, shift_name_a: s.shift_a, position_a: s.pos_a, slot_index_a: s.slot_a,
          day_b: s.day_b, shift_name_b: s.shift_b, position_b: s.pos_b, slot_index_b: s.slot_b,
        }),
      });
      if (!r.ok) throw new Error("undo failed");
      await refreshSchedule();
    } catch (e) {
      alert("ยกเลิกสลับไม่สำเร็จ: " + e.message);
    }
  });
  // auto-hide after 15 seconds
  setTimeout(() => { _lastSwap = null; banner.remove(); }, 15000);
}
document.addEventListener("keydown", (e) => { if (e.key === "Escape") _clearSwapPending(); });

function _pairShiftApplies(pair, shiftName) {
  const names = Array.isArray(pair && pair.shift_names) ? pair.shift_names.filter(Boolean) : [];
  return names.length === 0 || names.includes(shiftName);
}

function _checkDependsOnPairForCandidate(candidateName, day, shiftName, dayShiftStaffMap, currentName) {
  const key = `${day}-${shiftName}`;
  const currentSet = new Set(dayShiftStaffMap && dayShiftStaffMap[key] ? Array.from(dayShiftStaffMap[key]) : []);
  if (currentName) currentSet.delete(currentName);
  if (candidateName) currentSet.add(candidateName);

  // Group depends_on rules by dependent — OR logic: ผ่านถ้ามี provider ใด provider หนึ่งอยู่
  const depGroups = new Map(); // dependent -> [provider, ...]
  for (const p of (pairRulesCache || [])) {
    if (!p || p.pair_type !== "depends_on") continue;
    if (!_pairShiftApplies(p, shiftName)) continue;
    if (!p.name_1 || !p.name_2) continue;
    if (!depGroups.has(p.name_2)) depGroups.set(p.name_2, []);
    depGroups.get(p.name_2).push(p.name_1);
  }

  for (const [dependent, providers] of depGroups) {
    if (!currentSet.has(dependent)) continue;
    const anyPresent = providers.some(pr => currentSet.has(pr));
    if (!anyPresent) {
      const providerList = providers.join(" หรือ ");
      if (candidateName === dependent) {
        return { ok: false, reason: `ต้องอยู่กับ ${providerList}` };
      }
      return { ok: false, reason: `${dependent} ต้องอยู่กับ ${providerList}` };
    }
  }
  return { ok: true, reason: "" };
}

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

function normalizeOffDaysByMode(rawInput, mode, totalDays) {
  const rawDays = parseOffDaysOfMonth(rawInput || "");
  if (mode === "work") {
    // Empty/invalid work-day input means "no monthly off-day restriction".
    if (!rawDays.length) return [];
    return workDaysToOffDays(rawDays, totalDays);
  }
  return rawDays;
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

function formatOffDaysOfMonth(days, totalDays) {
  return Array.from(new Set((Array.isArray(days) ? days : [])
    .map((day) => parseInt(day, 10))
    .filter((day) => !isNaN(day) && day >= 1 && day <= totalDays)))
    .sort((a, b) => a - b)
    .join(", ");
}

function getStaffMonthMode(prefix) {
  const selected = document.querySelector("input[name='" + prefix + "_month_mode']:checked");
  return selected ? selected.value : "off";
}

function getMonthCalendarInfo() {
  const totalDays = getMonthTotalDays();
  const startEl = document.getElementById("schedule_start_date");
  if (startEl && startEl.value) {
    const [year, month] = startEl.value.split("-").map(Number);
    if (year && month) {
      const firstDow = new Date(year, month - 1, 1).getDay();
      return {
        totalDays,
        hasRealMonth: true,
        year,
        month,
        startIdx: firstDow === 0 ? 6 : firstDow - 1,
      };
    }
  }
  return { totalDays, hasRealMonth: false, year: null, month: null, startIdx: 0 };
}

function updateStaffMonthModeUI(prefix) {
  const mode = getStaffMonthMode(prefix);
  const label = document.getElementById(prefix + "_month_label");
  const input = document.getElementById(prefix + "_off_days_of_month");
  const hint = document.getElementById(prefix + "_month_hint");
  if (label) label.textContent = mode === "work" ? "วันทำงานรายเดือน (คลิกวันที่)" : "วันหยุดรายเดือน (คลิกวันที่)";
  if (input) {
    input.placeholder = mode === "work"
      ? "คลิกเลือกวันที่มาทำงานจากปฏิทิน"
      : "คลิกเลือกวันที่หยุดจากปฏิทิน";
  }
  if (hint) {
    hint.textContent = mode === "work"
      ? "วันที่ที่เลือกจะถูกตีความเป็นวันทำงานของเดือน"
      : "วันที่ที่เลือกจะถูกตีความเป็นวันหยุดของเดือน";
  }
}

function renderStaffMonthCalendar(prefix) {
  const container = document.getElementById(prefix + "_off_days_of_month_calendar");
  const input = document.getElementById(prefix + "_off_days_of_month");
  if (!container || !input) return;

  const mode = getStaffMonthMode(prefix);
  const info = getMonthCalendarInfo();
  const totalDays = info.totalDays;
  const selectedDays = parseOffDaysOfMonth(input.value).filter((day) => day >= 1 && day <= totalDays);
  const normalized = formatOffDaysOfMonth(selectedDays, totalDays);
  if (input.value !== normalized) input.value = normalized;

  const countLabel = mode === "work" ? "วันทำงาน" : "วันหยุด";
  const headerLabel = info.hasRealMonth
    ? (THAI_MONTHS[info.month - 1] || "") + " " + (info.year + 543)
    : "เลือกวันที่ของเดือน";

  let html = '<div class="staff-month-calendar mode-' + mode + '">';
  html += '<div class="staff-month-cal-top">';
  html += '<strong>' + escapeHtml(headerLabel) + '</strong>';
  html += '<span class="staff-month-cal-count">เลือก ' + countLabel + ' <strong id="' + prefix + '_month_count">' + selectedDays.length + '</strong> วัน</span>';
  html += '</div>';
  if (info.hasRealMonth) {
    html += '<div class="holiday-cal-header staff-month-cal-header"><span>จ</span><span>อ</span><span>พ</span><span>พฤ</span><span>ศ</span><span>ส</span><span>อา</span></div>';
  }
  html += '<div class="holiday-cal-grid staff-month-cal-grid">';
  for (let i = 0; i < info.startIdx; i++) html += '<div class="hcal-day empty"></div>';
  const selectedSet = new Set(selectedDays);
  const shiftRuleMap = new Map();
  const shiftRuleEl = document.getElementById(prefix + "_shift_day_rules");
  if (shiftRuleEl && shiftRuleEl.id) {
    const draftRules = collectShiftDayRulesDraft("#" + shiftRuleEl.id);
    draftRules.forEach((r) => {
      const day = Number(r && r.day);
      if (!day || day < 1 || day > totalDays) return;
      const shifts = Array.isArray(r && r.allowed_shifts) ? r.allowed_shifts.filter(Boolean) : [];
      if (!shiftRuleMap.has(day)) shiftRuleMap.set(day, []);
      shifts.forEach((sn) => {
        if (!shiftRuleMap.get(day).includes(sn)) shiftRuleMap.get(day).push(sn);
      });
      if (!shifts.length && !shiftRuleMap.has(day)) shiftRuleMap.set(day, []);
    });
  }
  for (let day = 1; day <= totalDays; day++) {
    const cls = ["hcal-day", "staff-month-day"];
    if (info.hasRealMonth) {
      const dow = new Date(info.year, info.month - 1, day).getDay();
      if (dow === 0 || dow === 6) cls.push("weekend");
    }
    if (selectedSet.has(day)) cls.push("selected");
    const shiftRules = shiftRuleMap.get(day) || null;
    if (shiftRules != null) cls.push("has-shift-rule");
    const shiftRuleDetail = shiftRules == null
      ? ""
      : (shiftRules.length
        ? " | ข้อยกเว้นรายวัน: อนุญาตเฉพาะ " + shiftRules.join("/")
        : " | ข้อยกเว้นรายวัน: ยังไม่เลือกกะ");
    html += '<button type="button" class="' + cls.join(" ") + '" data-day="' + day + '" aria-pressed="' + (selectedSet.has(day) ? "true" : "false") + '" title="' + countLabel + ' วันที่ ' + day + shiftRuleDetail + '">' + day + '</button>';
  }
  html += '</div>';
  html += '<div class="holiday-cal-legend staff-month-cal-legend">';
  html += '<span><span class="legend-swatch smd"></span>' + countLabel + '</span>';
  html += '<span><span class="legend-swatch sr"></span>มีกฎข้อยกเว้นรายวันแยกกะ</span>';
  html += '<span><span class="legend-swatch lw"></span>ยังไม่เลือก</span>';
  if (info.hasRealMonth) html += '<span><span class="legend-swatch lwe"></span>เสาร์-อาทิตย์</span>';
  html += '</div>';
  html += '</div>';
  container.innerHTML = html;

  container.querySelectorAll(".staff-month-day").forEach((el) => {
    el.addEventListener("click", () => {
      const clickedDay = parseInt(el.dataset.day, 10);
      const nextSelected = new Set(parseOffDaysOfMonth(input.value).filter((day) => day >= 1 && day <= totalDays));
      if (nextSelected.has(clickedDay)) nextSelected.delete(clickedDay);
      else nextSelected.add(clickedDay);
      input.value = formatOffDaysOfMonth(Array.from(nextSelected), totalDays);
      renderStaffMonthCalendar(prefix);
    });
  });
}

function switchStaffMonthMode(prefix, nextMode) {
  const input = document.getElementById(prefix + "_off_days_of_month");
  if (!input) return;
  const totalDays = getMonthTotalDays();
  const currentDays = parseOffDaysOfMonth(input.value).filter((day) => day >= 1 && day <= totalDays);
  const converted = nextMode === "work"
    ? (currentDays.length ? offDaysToWorkDays(currentDays, totalDays) : [])
    : (currentDays.length ? workDaysToOffDays(currentDays, totalDays) : []);
  input.value = formatOffDaysOfMonth(converted, totalDays);
  updateStaffMonthModeUI(prefix);
  renderStaffMonthCalendar(prefix);
}

function renderAllStaffMonthCalendars() {
  renderStaffMonthCalendar("staff_add");
  renderStaffMonthCalendar("staff_edit");
}

function getShiftActiveDaysOfMonthValues() {
  const hidden = document.getElementById("shift_active_days_of_month");
  return parseOffDaysOfMonth(hidden ? hidden.value : "");
}

function setShiftActiveDaysOfMonth(days) {
  const hidden = document.getElementById("shift_active_days_of_month");
  const summary = document.getElementById("shift_active_days_of_month_summary");
  const value = formatOffDaysOfMonth(days, 31);
  if (hidden) hidden.value = value;
  if (summary) summary.value = value;
  renderShiftActiveDaysOfMonthCalendar();
}

function getShiftHolidayDaysInCurrentMonth() {
  const info = getMonthCalendarInfo();
  const days = new Set();
  if (!info.hasRealMonth) return days;
  holidaySet.forEach((iso) => {
    const [yy, mm, dd] = String(iso || "").split("-").map(Number);
    if (yy === info.year && mm === info.month && dd >= 1 && dd <= 31) {
      days.add(dd);
    }
  });
  return days;
}

function syncShiftDaysWithHolidaySwitch() {
  const includeHolidayEl = document.getElementById("shift_include_holidays");
  const includeHolidays = !!(includeHolidayEl && includeHolidayEl.checked);
  if (!includeHolidays) {
    renderShiftActiveDaysOfMonthCalendar();
    return;
  }
  const current = new Set(getShiftActiveDaysOfMonthValues());
  const holidayDays = getShiftHolidayDaysInCurrentMonth();
  let changed = false;
  holidayDays.forEach((d) => {
    if (!current.has(d)) {
      current.add(d);
      changed = true;
    }
  });
  if (changed) {
    setShiftActiveDaysOfMonth(Array.from(current));
  } else {
    renderShiftActiveDaysOfMonthCalendar();
  }
}

function renderShiftActiveDaysOfMonthCalendar() {
  const container = document.getElementById("shift_active_days_of_month_calendar");
  if (!container) return;
  const info = getMonthCalendarInfo();
  const selectedDays = getShiftActiveDaysOfMonthValues();
  const selectedSet = new Set(selectedDays);
  const includeHolidayEl = document.getElementById("shift_include_holidays");
  const includeHolidays = !!(includeHolidayEl && includeHolidayEl.checked);
  const holidayDays = includeHolidays ? getShiftHolidayDaysInCurrentMonth() : new Set();
  const dayLabels = ["จ", "อ", "พ", "พฤ", "ศ", "ส", "อา"];
  let html = '<div class="staff-month-calendar shift-month-picker">';
  html += '<div class="staff-month-cal-top">';
  html += '<strong>วันที่ของเดือน</strong>';
  html += '<span class="staff-month-cal-count">เลือก <strong>' + selectedDays.length + '</strong> วัน</span>';
  html += '</div>';
  html += '<div class="holiday-cal-header shift-month-picker-header">' + dayLabels.map((d) => '<span>' + d + '</span>').join("") + '</div>';
  html += '<div class="shift-month-picker-grid">';
  if (info.hasRealMonth) {
    for (let i = 0; i < info.startIdx; i++) html += '<div class="hcal-day empty"></div>';
  }
  for (let day = 1; day <= 31; day++) {
    const cls = ["hcal-day", "staff-month-day"];
    if (info.hasRealMonth) {
      const dow = new Date(info.year, info.month - 1, day).getDay();
      if (dow === 0 || dow === 6) cls.push("weekend");
    }
    if (selectedSet.has(day)) cls.push("selected");
    if (holidayDays.has(day)) cls.push(selectedSet.has(day) ? "holiday-selected" : "holiday-added");
    html += '<button type="button" class="' + cls.join(" ") + '" data-shift-day-of-month="' + day + '" aria-pressed="' + (selectedSet.has(day) ? "true" : "false") + '">' + day + '</button>';
  }
  html += '</div>';
  html += '<div class="holiday-cal-legend staff-month-cal-legend">';
  html += '<span><span class="legend-swatch smd"></span>วันที่เปิดเพิ่ม</span>';
  if (includeHolidays) html += '<span><span class="legend-swatch shd"></span>เพิ่มจากวันหยุดราชการ</span>';
  html += '<span><span class="legend-swatch lw"></span>ยังไม่เลือก</span>';
  html += '</div>';
  html += '</div>';
  container.innerHTML = html;

  container.querySelectorAll("[data-shift-day-of-month]").forEach((el) => {
    el.addEventListener("click", () => {
      const day = parseInt(el.dataset.shiftDayOfMonth, 10);
      const next = new Set(getShiftActiveDaysOfMonthValues());
      if (next.has(day)) next.delete(day);
      else next.add(day);
      setShiftActiveDaysOfMonth(Array.from(next));
    });
  });
}

function renderStaffDetailContent(staff) {
  const typeLabel = staff.type === "fulltime" ? "เต็มเวลา" : "พาร์ทไทม์";
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
  const shiftLimits = (staff.shift_limits && typeof staff.shift_limits === "object") ? staff.shift_limits : {};
  const shiftLimitsLabel = Object.entries(shiftLimits)
    .map(([sn, lim]) => {
      const minVal = lim && lim.min != null ? lim.min : "—";
      const maxVal = lim && lim.max != null ? lim.max : "—";
      return `${sn} (min ${minVal} / max ${maxVal})`;
    })
    .join(", ");
  const shiftDayRules = Array.isArray(staff.shift_day_rules) ? staff.shift_day_rules : [];
  const shiftDayRulesLabel = shiftDayRules
    .map((r) => {
      const day = Number(r && r.day);
      const shifts = Array.isArray(r && r.allowed_shifts) ? r.allowed_shifts.filter(Boolean) : [];
      if (!day || !shifts.length) return "";
      return "วันที่ " + day + ": " + shifts.join("/");
    })
    .filter(Boolean)
    .join(", ");
  return (
    "<dl class=\"staff-detail-dl\">" +
    "<dt>ชื่อ</dt><dd>" + escapeHtml(staff.name) + "</dd>" +
    "<dt>ตำแหน่ง</dt><dd>" + escapeHtml(typeLabel) + "</dd>" +
    "</dl>" +
    "<hr class=\"detail-divider\" />" +
    "<dl class=\"staff-detail-dl\">" +
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
    "<dt>ขั้นต่ำ/สูงสุดรายกะ</dt><dd>" + (shiftLimitsLabel ? escapeHtml(shiftLimitsLabel) : "—") + "</dd>" +
    "<dt>ข้อยกเว้นรายวันแยกกะ</dt><dd>" + (shiftDayRulesLabel ? escapeHtml(shiftDayRulesLabel) : "—") + "</dd>" +
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

function renderShiftLimitsInputs(containerEl, shiftLimits) {
  if (!containerEl) return;
  const list = Array.isArray(shiftsCache) ? shiftsCache : [];
  const map = shiftLimits && typeof shiftLimits === "object" ? shiftLimits : {};
  containerEl.innerHTML = list.length
    ? list.map((sh) => {
        const nm = typeof sh === "string" ? sh : sh.name;
        if (!nm) return "";
        const lim = map[nm] && typeof map[nm] === "object" ? map[nm] : {};
        const minVal = lim.min != null ? String(lim.min) : "";
        const maxVal = lim.max != null ? String(lim.max) : "";
        return "<div class=\"form-inline\" style=\"margin:0 0 .35rem 0\">" +
          "<span style=\"min-width:10rem\">" + escapeHtml(nm) + "</span>" +
          "<label style=\"margin:0 .25rem 0 0\">min</label>" +
          "<input type=\"number\" class=\"shift-limit-min-input\" data-shift=\"" + escapeHtml(nm) + "\" min=\"0\" max=\"31\" placeholder=\"—\" value=\"" + escapeHtml(minVal) + "\" style=\"width:4.5rem\" />" +
          "<label style=\"margin:0 .25rem 0 .5rem\">max</label>" +
          "<input type=\"number\" class=\"shift-limit-max-input\" data-shift=\"" + escapeHtml(nm) + "\" min=\"0\" max=\"31\" placeholder=\"—\" value=\"" + escapeHtml(maxVal) + "\" style=\"width:4.5rem\" />" +
          "<span class=\"text-muted\" style=\"font-size:.82rem;margin:0 .25rem\">/เดือน</span>" +
          "</div>";
      }).join("")
    : "<span class=\"text-muted\">ยังไม่มีกะ — ไปที่หน้ากะเพิ่มก่อน</span>";
}

function collectShiftLimits(containerSelector) {
  const result = {};
  const maxByShift = {};
  document.querySelectorAll(containerSelector + " .shift-limit-max-input").forEach((maxEl) => {
    const shift = (maxEl.dataset.shift || "").trim();
    if (!shift) return;
    maxByShift[shift] = maxEl;
  });
  document.querySelectorAll(containerSelector + " .shift-limit-min-input").forEach((minEl) => {
    const shift = (minEl.dataset.shift || "").trim();
    if (!shift) return;
    const maxEl = maxByShift[shift] || null;
    const minRaw = minEl.value;
    const maxRaw = maxEl ? maxEl.value : "";
    const minVal = minRaw !== "" ? Math.max(0, parseInt(minRaw, 10) || 0) : null;
    const maxVal = maxRaw !== "" ? Math.max(0, parseInt(maxRaw, 10) || 0) : null;
    if (minVal == null && maxVal == null) return;
    result[shift] = { min: minVal, max: maxVal };
  });
  return result;
}

function _normalizeShiftDayRules(rawRules, allowEmpty = false) {
  const merged = new Map();
  (Array.isArray(rawRules) ? rawRules : []).forEach((item) => {
    if (!item || typeof item !== "object") return;
    const day = parseInt(item.day, 10);
    if (isNaN(day) || day < 1 || day > 31) return;
    const shifts = Array.isArray(item.allowed_shifts) ? item.allowed_shifts : [];
    const clean = shifts.map((name) => String(name || "").trim()).filter(Boolean);
    if (!merged.has(day)) merged.set(day, new Set());
    if (!clean.length && !allowEmpty) return;
    clean.forEach((name) => merged.get(day).add(name));
  });
  return Array.from(merged.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([day, names]) => ({ day, allowed_shifts: Array.from(names.values()) }));
}

function collectShiftDayRulesDraft(containerSelector) {
  const rows = Array.from(document.querySelectorAll(containerSelector + " .shift-day-rule-row"));
  const result = rows.map((row) => {
    const dayEl = row.querySelector(".shift-day-rule-day");
    const day = dayEl ? parseInt(dayEl.value, 10) : NaN;
    const allowed_shifts = Array.from(row.querySelectorAll(".shift-day-rule-shift:checked")).map((cb) => String(cb.value || "").trim()).filter(Boolean);
    return { day, allowed_shifts };
  });
  return _normalizeShiftDayRules(result, true);
}

function renderShiftDayRulesInputs(containerEl, rules, addBtnSelector) {
  if (!containerEl) return;
  const rerenderRelatedCalendar = () => {
    if (!containerEl || !containerEl.id) return;
    if (containerEl.id === "staff_add_shift_day_rules") renderStaffMonthCalendar("staff_add");
    if (containerEl.id === "staff_edit_shift_day_rules") renderStaffMonthCalendar("staff_edit");
  };
  const rerenderRulesUI = (nextRules, options = {}) => {
    const scrollTop = window.scrollY;
    renderShiftDayRulesInputs(containerEl, nextRules, addBtnSelector);
    window.scrollTo({ top: scrollTop, behavior: "auto" });
    if (options.focusIndex != null) {
      const inputs = containerEl.querySelectorAll(".shift-day-rule-day");
      const target = inputs[options.focusIndex];
      if (target) {
        try {
          target.focus({ preventScroll: true });
        } catch {
          target.focus();
        }
        if (typeof target.select === "function") target.select();
      }
    }
  };
  const list = Array.isArray(shiftsCache) ? shiftsCache : [];
  const shiftNames = list.map((sh) => (typeof sh === "string" ? sh : sh.name)).filter(Boolean);
  const normalized = _normalizeShiftDayRules(rules, true);
  if (!normalized.length) {
    containerEl.innerHTML = "<div class=\"shift-day-rules-empty\"><strong>ยังไม่มีกฎรายวัน</strong><span class=\"text-muted\">เพิ่มเฉพาะวันที่ต้องจำกัดกะแบบพิเศษ</span><button type=\"button\" class=\"small shift-day-rules-empty-add\">+ เพิ่มกฎแรก</button></div>";
  } else {
    containerEl.innerHTML = normalized.map((rule, idx) => {
      const checks = shiftNames.length
        ? shiftNames.map((sn) => {
            const checked = rule.allowed_shifts.includes(sn) ? " checked" : "";
            return "<label class=\"staff-skill-cb\"><input type=\"checkbox\" class=\"shift-day-rule-shift\" value=\"" + escapeHtml(sn) + "\"" + checked + " /> " + escapeHtml(sn) + "</label>";
          }).join(" ")
        : "<span class=\"text-muted\">ยังไม่มีกะในระบบ</span>";
      return "<div class=\"shift-day-rule-row\">" +
        "<div class=\"form-inline shift-day-rule-top\">" +
        "<label class=\"shift-day-rule-day-label\">วันที่</label>" +
        "<input type=\"number\" class=\"shift-day-rule-day\" min=\"1\" max=\"31\" value=\"" + rule.day + "\" />" +
        "<span class=\"shift-day-rule-picked\">เลือก " + rule.allowed_shifts.length + " กะ</span>" +
        "<button type=\"button\" class=\"small shift-day-rule-select-all\">เลือกทั้งหมด</button>" +
        "<button type=\"button\" class=\"small shift-day-rule-clear\">ล้างเลือก</button>" +
        "<button type=\"button\" class=\"small shift-day-rule-remove\" data-idx=\"" + idx + "\">ลบ</button>" +
        "</div>" +
        "<div class=\"staff-skills-checkboxes shift-day-rule-checks\">" + checks + "</div>" +
        "</div>";
    }).join("");
  }

  containerEl.querySelectorAll(".shift-day-rule-row").forEach((row) => {
    const picked = row.querySelector(".shift-day-rule-picked");
    const refreshPicked = () => {
      if (!picked) return;
      const count = row.querySelectorAll(".shift-day-rule-shift:checked").length;
      picked.textContent = "เลือก " + count + " กะ";
      rerenderRelatedCalendar();
    };
    row.querySelectorAll(".shift-day-rule-shift").forEach((cb) => {
      cb.addEventListener("change", refreshPicked);
    });
  });

  containerEl.querySelectorAll(".shift-day-rule-remove").forEach((btn) => {
    btn.addEventListener("click", () => {
      const rows = collectShiftDayRulesDraft("#" + containerEl.id);
      const idx = parseInt(btn.dataset.idx || "-1", 10);
      if (!isNaN(idx) && idx >= 0 && idx < rows.length) rows.splice(idx, 1);
      rerenderRulesUI(rows);
    });
  });

  containerEl.querySelectorAll(".shift-day-rule-select-all").forEach((btn) => {
    btn.addEventListener("click", () => {
      const row = btn.closest(".shift-day-rule-row");
      if (!row) return;
      row.querySelectorAll(".shift-day-rule-shift").forEach((cb) => { cb.checked = true; });
      const rows = collectShiftDayRulesDraft("#" + containerEl.id);
      rerenderRulesUI(rows);
    });
  });

  containerEl.querySelectorAll(".shift-day-rule-clear").forEach((btn) => {
    btn.addEventListener("click", () => {
      const row = btn.closest(".shift-day-rule-row");
      if (!row) return;
      row.querySelectorAll(".shift-day-rule-shift").forEach((cb) => { cb.checked = false; });
      const rows = collectShiftDayRulesDraft("#" + containerEl.id);
      rerenderRulesUI(rows);
    });
  });

  containerEl.querySelectorAll(".shift-day-rule-day").forEach((dayInput) => {
    dayInput.addEventListener("input", () => {
      rerenderRelatedCalendar();
    });
    dayInput.addEventListener("change", () => {
      rerenderRelatedCalendar();
    });
    dayInput.addEventListener("blur", () => {
      rerenderRelatedCalendar();
    });
  });

  containerEl.querySelectorAll(".shift-day-rules-empty-add").forEach((btn) => {
    btn.addEventListener("click", () => {
      rerenderRulesUI([{ day: 1, allowed_shifts: [] }], { focusIndex: 0 });
    });
  });

  if (addBtnSelector) {
    const addBtn = document.querySelector(addBtnSelector);
    if (addBtn && !addBtn.dataset.boundShiftDayRule) {
      addBtn.dataset.boundShiftDayRule = "1";
      addBtn.addEventListener("click", () => {
        const rows = collectShiftDayRulesDraft("#" + containerEl.id);
        rows.unshift({ day: 1, allowed_shifts: [] });
        rerenderRulesUI(rows, { focusIndex: 0 });
      });
    }
  }
  rerenderRelatedCalendar();
}

function collectShiftDayRules(containerSelector) {
  const rows = Array.from(document.querySelectorAll(containerSelector + " .shift-day-rule-row"));
  const result = rows.map((row) => {
    const dayEl = row.querySelector(".shift-day-rule-day");
    const day = dayEl ? parseInt(dayEl.value, 10) : NaN;
    const allowed_shifts = Array.from(row.querySelectorAll(".shift-day-rule-shift:checked")).map((cb) => String(cb.value || "").trim()).filter(Boolean);
    return { day, allowed_shifts };
  });
  return _normalizeShiftDayRules(result, false);
}

function renderStaffDetailForm(staff, catalogSkills, catalogTitles, catalogTimeWindows) {
  const titleVal = (staff.title != null && staff.title !== undefined) ? staff.title : "";
  const staffSkillsSet = new Set((staff.skills && staff.skills.length) ? staff.skills : []);
  const staffTimeWindowsSet = new Set((staff.time_windows && staff.time_windows.length) ? staff.time_windows : []);
  const offDaysOfMonthVal = (staff.off_days_of_month && staff.off_days_of_month.length) ? staff.off_days_of_month.sort((a, b) => a - b).join(", ") : "";
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
    "<div class=\"form-group staff-off-days-of-month-wrap\" style=\"margin-top:.5rem\">" +
    "<div class=\"month-mode-toggle\">" +
    "<label class=\"month-mode-label\"><input type=\"radio\" name=\"staff_edit_month_mode\" value=\"off\"" + (!isWorkMode ? " checked" : "") + " /> ระบุวันหยุด</label>" +
    "<label class=\"month-mode-label\"><input type=\"radio\" name=\"staff_edit_month_mode\" value=\"work\"" + (isWorkMode ? " checked" : "") + " /> ระบุวันทำงาน</label>" +
    "</div>" +
    "<label for=\"staff_edit_off_days_of_month\" id=\"staff_edit_month_label\">" + (isWorkMode ? "วันทำงานรายเดือน (คลิกวันที่)" : "วันหยุดรายเดือน (คลิกวันที่)") + "</label>" +
    "<input type=\"text\" id=\"staff_edit_off_days_of_month\" placeholder=\"เช่น 1, 15, 31\" value=\"" +
    escapeHtml(isWorkMode ? offDaysToWorkDays(parseOffDaysOfMonth(offDaysOfMonthVal), getMonthTotalDays()).join(", ") : offDaysOfMonthVal) +
    "\" class=\"staff-month-input\" readonly style=\"max-width:16rem\" />" +
    "<div id=\"staff_edit_month_hint\" class=\"text-muted staff-month-help\"></div>" +
    "<div id=\"staff_edit_off_days_of_month_calendar\"></div></div>" +
    "</fieldset>" +
    "<details class=\"form-section shift-day-rules-section shift-day-rules-collapse\" open><summary class=\"shift-day-rules-summary\">ข้อยกเว้นรายวันแยกกะ</summary>" +
    "<div class=\"form-group shift-day-rules-wrap\" style=\"margin-top:0\">" +
    "<label class=\"text-muted\" style=\"font-size:.82rem\">เช่น วันที่ 27 อนุญาตเฉพาะเวรบ่าย/ดึก</label>" +
    "<div id=\"staff_edit_shift_day_rules\" class=\"shift-day-rules-list\"></div>" +
    "<button type=\"button\" id=\"staff_edit_shift_day_rule_add\" class=\"small shift-day-rules-add-btn\">+ เพิ่มกฎรายวัน</button>" +
    "</div></details>" +
    "<fieldset class=\"form-section\"><legend>จำนวนกะ / เดือน (รวม)</legend>" +
    "<div class=\"form-inline\" style=\"margin-bottom:0\">" +
    "<label for=\"staff_edit_min_shifts\">ขั้นต่ำ</label>" +
    "<input type=\"number\" id=\"staff_edit_min_shifts\" min=\"0\" max=\"31\" placeholder=\"—\" value=\"" + (staff.min_shifts_per_month != null ? staff.min_shifts_per_month : "") + "\" style=\"width:5rem\" />" +
    "<label for=\"staff_edit_max_shifts\">สูงสุด</label>" +
    "<input type=\"number\" id=\"staff_edit_max_shifts\" min=\"0\" max=\"31\" placeholder=\"—\" value=\"" + (staff.max_shifts_per_month != null ? staff.max_shifts_per_month : "") + "\" style=\"width:5rem\" />" +
    "<span class=\"text-muted\" style=\"font-size:.82rem;margin:0\">ว่างไว้ = ไม่จำกัด</span>" +
    "</div></fieldset>" +
    "<fieldset class=\"form-section form-section--highlight\"><legend>⚡ ขั้นต่ำ/สูงสุด รายกะ</legend>" +
    "<div class=\"form-group\" style=\"margin-top:0\">" +
    "<label class=\"text-muted\" style=\"font-size:.82rem\">บังคับ solver — เช่น ต้องอยู่เวรดึก X-match อย่างน้อย 3 ครั้ง/เดือน</label>" +
    "<div id=\"staff_edit_shift_limits\" class=\"staff-skills-checkboxes\"></div>" +
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
    const [staffRes, skillsRes, titlesRes, twRes, shiftsRes] = await Promise.all([
      fetch(API + "/staff/" + staffId),
      fetch(API + "/skills"),
      fetch(API + "/titles"),
      fetch(API + "/time-windows"),
      fetch(API + "/shifts"),
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
    const shiftsList = shiftsRes.ok ? await shiftsRes.json() : [];
    shiftsCache = Array.isArray(shiftsList) ? shiftsList : [];
    const skillsList = Array.isArray(catalogSkills) ? catalogSkills : [];
    const titlesList = Array.isArray(catalogTitles) ? catalogTitles : [];
    const timeWindowsList = Array.isArray(catalogTimeWindows) ? catalogTimeWindows : [];
    contentEl.innerHTML = renderStaffDetailForm(staff, skillsList, titlesList, timeWindowsList);
    contentEl.style.display = "";

    const editGapRules = document.getElementById("staff_edit_min_gap_rules");
    if (editGapRules) renderMinGapRulesInputs(editGapRules, staff.min_gap_rules || []);
    const editShiftLimits = document.getElementById("staff_edit_shift_limits");
    if (editShiftLimits) renderShiftLimitsInputs(editShiftLimits, staff.shift_limits || {});
    const editShiftDayRules = document.getElementById("staff_edit_shift_day_rules");
    if (editShiftDayRules) renderShiftDayRulesInputs(editShiftDayRules, staff.shift_day_rules || [], "#staff_edit_shift_day_rule_add");
    updateStaffMonthModeUI("staff_edit");
    renderStaffMonthCalendar("staff_edit");

    document.querySelectorAll("input[name='staff_edit_month_mode']").forEach((radio) => {
      radio.addEventListener("change", () => {
        switchStaffMonthMode("staff_edit", radio.value);
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
        showToast("กรุณากรอกชื่อ", "error");
        return;
      }
      const titleEl = document.getElementById("staff_edit_title");
      const title = (titleEl && titleEl.value) ? titleEl.value.trim() : "";
      const off_days = [];
      const editOffMonthEl = document.getElementById("staff_edit_off_days_of_month");
      const editMonthMode = document.querySelector("input[name='staff_edit_month_mode']:checked");
      const monthMode = editMonthMode ? editMonthMode.value : "off";
      const off_days_of_month = normalizeOffDaysByMode(
        editOffMonthEl ? editOffMonthEl.value : "",
        monthMode,
        getMonthTotalDays(),
      );
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
      const shiftLimitInputs = document.querySelectorAll("#staff_edit_shift_limits .shift-limit-min-input");
      const shift_limits = shiftLimitInputs.length
        ? collectShiftLimits("#staff_edit_shift_limits")
        : (staff.shift_limits || {});
      const shift_day_rules = collectShiftDayRules("#staff_edit_shift_day_rules");
      msgEl.style.display = "none";
      try {
        const res = await fetch(API + "/staff/" + staffId, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name, title, off_days, off_days_of_month, skills, time_windows, skill_levels, min_shifts_per_month, max_shifts_per_month, min_gap_days, min_gap_shifts: [], min_gap_rules, shift_day_rules, shift_limits }),
        });
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          const errMsg = formatApiError(err) || "บันทึกไม่สำเร็จ";
          msgEl.textContent = errMsg;
          msgEl.className = "message error";
          msgEl.style.display = "";
          showToast(errMsg, "error");
          return;
        }
        msgEl.textContent = "บันทึกแล้ว";
        msgEl.className = "message success";
        msgEl.style.display = "";
        showToast("บันทึกข้อมูลบุคลากรแล้ว", "success");
        refreshStaff();
      } catch (err) {
        const errMsg = "เกิดข้อผิดพลาด: " + (err.message || "");
        msgEl.textContent = errMsg;
        msgEl.className = "message error";
        msgEl.style.display = "";
        showToast(errMsg, "error");
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
  const arr = Array.isArray(items) ? items.slice() : [];

  const buildShiftColumns = (s) => {
    const columns = [];
    if (Array.isArray(s.positions) && s.positions.length) {
      s.positions.forEach((p) => {
        const baseName = typeof p === "string" ? p : (p && p.name) || "ช่อง";
        const slotCount = typeof p === "object" && p && p.slot_count != null ? Math.max(1, parseInt(p.slot_count, 10) || 1) : 1;
        const weekdaySet = new Set(
          String(typeof p === "object" && p && p.active_weekdays ? p.active_weekdays : "")
            .split(",")
            .map((v) => parseInt(v.trim(), 10))
            .filter((v) => !isNaN(v) && v >= 0 && v <= 6)
        );
        const holidayMode = typeof p === "object" && p && p.holiday_mode ? p.holiday_mode : "all";
        for (let i = 1; i <= slotCount; i++) {
          columns.push({ label: slotCount > 1 ? `${baseName} #${i}` : baseName, activeWeekdays: weekdaySet, holidayMode });
        }
      });
    } else {
      const donor = Math.max(0, parseInt(s.donor, 10) || 0);
      const xmatch = Math.max(0, parseInt(s.xmatch, 10) || 0);
      for (let i = 1; i <= donor; i++) columns.push({ label: `Donor #${i}`, activeWeekdays: new Set(), holidayMode: "all" });
      for (let i = 1; i <= xmatch; i++) columns.push({ label: `Xmatch #${i}`, activeWeekdays: new Set(), holidayMode: "all" });
    }
    if (!columns.length) columns.push({ label: "ช่อง 1", activeWeekdays: new Set(), holidayMode: "all" });
    return columns;
  };

  const buildCombinedPreviewHtml = (shiftItems) => {
    const monthDays = getMonthTotalDays();
    const startDateEl = document.getElementById("schedule_start_date");
    const startDate = startDateEl && startDateEl.value ? startDateEl.value : "";
    const monthHolidayDays = getShiftHolidayDaysInCurrentMonth();

    const shiftDefs = shiftItems.map((s) => {
      const selectedDays = new Set(
        Array.isArray(s.active_days_of_month)
          ? s.active_days_of_month.map((d) => parseInt(d, 10)).filter((d) => !isNaN(d) && d >= 1 && d <= 31)
          : []
      );
      return {
        shift: s,
        columns: buildShiftColumns(s),
        selectedDays,
        hasManualDays: selectedDays.size > 0,
        includeHolidays: !!s.include_holidays,
      };
    });

    let html = '<div class="shift-preview shift-preview-combined">' +
      '<div class="shift-preview-title">ตัวอย่างตารางรวม (เหมือนหน้า Solver)</div>' +
      '<div class="shift-preview-wrap">' +
      '<table class="shift-preview-solver-table"><thead>' +
      '<tr><th class="th-day" rowspan="2">วัน</th>' +
      shiftDefs.map((d) => '<th class="th-shift" colspan="' + d.columns.length + '">' + escapeHtml(d.shift.name || "") + '</th>').join("") +
      '</tr><tr>' +
      shiftDefs.map((d) => d.columns.map((c) => '<th class="th-pos">' + escapeHtml(c.label) + '</th>').join("")).join("") +
      '</tr></thead><tbody>';

    for (let day = 1; day <= monthDays; day++) {
      const date = startDate ? new Date(startDate + "T00:00:00") : null;
      if (date) date.setDate(day);
      const pyWeekday = date ? (date.getDay() + 6) % 7 : null;
      const dayLabel = startDate ? formatDayLabel(day - 1, startDate) : ("วันที่ " + day);
      html += '<tr><td>' + escapeHtml(dayLabel) + '</td>';

      shiftDefs.forEach((d) => {
        const isOpen = (d.hasManualDays ? d.selectedDays.has(day) : true) || (d.includeHolidays && monthHolidayDays.has(day));
        if (!isOpen) {
          html += '<td class="td-inactive" colspan="' + d.columns.length + '">— ปิดกะ —</td>';
          return;
        }
        d.columns.forEach((c) => {
          const weekdayRestricted = c.activeWeekdays && c.activeWeekdays.size > 0;
          const isHoliday = monthHolidayDays.has(day);
          const holidayBlocked = (c.holidayMode === "non_holiday_only" && isHoliday) || (c.holidayMode === "holiday_only" && !isHoliday);
          if (holidayBlocked || (weekdayRestricted && (pyWeekday == null || !c.activeWeekdays.has(pyWeekday)))) {
            html += '<td class="td-inactive">—</td>';
          } else {
            html += '<td><span class="text-muted">(ชื่อคน)</span></td>';
          }
        });
      });

      html += '</tr>';
    }

    html += '</tbody></table></div></div>';
    return html;
  };

  const renderRow = (s) => {
    const posDetails = s.positions && s.positions.length
      ? '<div class="shift-pos-list">' + s.positions.map((p) => {
          const name = typeof p === "string" ? p : p.name;
          const slotCount = typeof p === "object" && p.slot_count != null ? Math.max(1, p.slot_count) : 1;
          const tw = typeof p === "object" && p.time_window_name ? p.time_window_name : "";
          let skillHtml = "";
          if (typeof p === "object" && p.required_skill) {
            const lvlLabels = getSkillLevelLabels(p.required_skill);
            const lvlName = lvlLabels[p.min_skill_level] || ("lv" + (p.min_skill_level || 1));
            skillHtml = '<span class="shift-pos-meta skill">🔑 ' + escapeHtml(p.required_skill) + ' ≥ ' + escapeHtml(lvlName) + '</span>';
          }
          const timeHtml = tw ? '<span class="shift-pos-meta time">' + escapeHtml(tw) + '</span>' : '';
          const titleHtml = typeof p === "object" && p.allowed_titles && p.allowed_titles.length
            ? '<span class="shift-pos-meta title">' + escapeHtml(p.allowed_titles.join('/')) + '</span>'
            : '';
          const maxPerWeekHtml = typeof p === "object" && p.max_per_week
            ? '<span class="shift-pos-meta limit">≤ ' + escapeHtml(String(p.max_per_week)) + ' /wk</span>'
            : '';
          const holidayModeHtml = typeof p === "object" && p.holiday_mode && p.holiday_mode !== "all"
            ? '<span class="shift-pos-meta holiday">' + escapeHtml(p.holiday_mode === "non_holiday_only" ? 'ไม่ใช่วันหยุดราชการ' : 'เฉพาะวันหยุดราชการ') + '</span>'
            : '';
          return '<div class="shift-pos-item">' +
            '<div class="shift-pos-main"><strong>' + escapeHtml(name || 'ช่อง') + '</strong><span class="shift-pos-count">×' + slotCount + '</span></div>' +
            '<div class="shift-pos-meta-row">' + timeHtml + skillHtml + titleHtml + maxPerWeekHtml + holidayModeHtml + '</div>' +
            '</div>';
        }).join('') + '</div>'
      : '<div class="shift-pos-list"><div class="shift-pos-item"><div class="shift-pos-main"><strong>donor</strong><span class="shift-pos-count">×' + escapeHtml(String(s.donor ?? 0)) + '</span></div></div><div class="shift-pos-item"><div class="shift-pos-main"><strong>xmatch</strong><span class="shift-pos-count">×' + escapeHtml(String(s.xmatch ?? 0)) + '</span></div></div></div>';
    return `<li data-id="${s.id}" class="shift-list-item">
        <div class="shift-row-main">
          <div class="shift-row-copy">
            <div class="name">${escapeHtml(s.name)}</div>
            ${posDetails}
          </div>
          <button type="button" class="small btn-move-shift" data-id="${s.id}" data-direction="up" title="เลื่อนขึ้น">↑</button>
          <button type="button" class="small btn-move-shift" data-id="${s.id}" data-direction="down" title="เลื่อนลง">↓</button>
          <button type="button" class="small btn-edit-shift" data-id="${s.id}">แก้ไข</button>
          <button class="small btn-delete-shift" data-id="${s.id}">ลบ</button>
        </div>
      </li>`;
  };

  ul.innerHTML = arr.map(renderRow).join("");

  let combined = document.getElementById("shift_preview_combined");
  if (!combined) {
    combined = document.createElement("div");
    combined.id = "shift_preview_combined";
    ul.insertAdjacentElement("afterend", combined);
  }
  combined.innerHTML = arr.length ? buildCombinedPreviewHtml(arr) : "";

  ul.querySelectorAll(".btn-move-shift").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      e.preventDefault();
      const id = btn.dataset.id;
      const direction = btn.dataset.direction;
      if (!id || !direction) return;
      const r = await fetch(API + "/shifts/" + id + "/move", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ direction }),
      });
      if (!r.ok) {
        const d = await r.json().catch(() => ({}));
        alert(formatApiError(d) || "เลื่อนลำดับไม่สำเร็จ");
        return;
      }
      await refreshShifts();
    });
  });
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
  const currentActiveDaysOfMonth = formatOffDaysOfMonth(getShiftActiveDaysOfMonthValues(), 31);
  const savedActiveDaysOfMonth = formatOffDaysOfMonth(shift.active_days_of_month || [], 31);
  if (currentActiveDaysOfMonth !== savedActiveDaysOfMonth) return true;
  const ihEl = document.getElementById("shift_include_holidays");
  if (!!(ihEl && ihEl.checked) !== !!shift.include_holidays) return true;
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

// --- Title Requirements per Shift ---
function renderTitleRequirements(reqs) {
  const wrap = document.getElementById("shift_title_requirements");
  if (!wrap) return;
  wrap.innerHTML = "";
  const titles = (window.titlesCatalog || []).map(t => typeof t === "string" ? t : t.name);
  (reqs || []).forEach((req) => {
    const row = document.createElement("div");
    row.className = "title-req-row";
    row.style.display = "flex";
    row.style.gap = "6px";
    row.style.alignItems = "center";
    row.style.marginBottom = "4px";
    const sel = document.createElement("select");
    sel.className = "title-req-title";
    sel.innerHTML = '<option value="">-- เลือกฉายา --</option>' + titles.map(t => `<option value="${escapeHtml(t)}"${t === req.title ? " selected" : ""}>${escapeHtml(t)}</option>`).join("");
    const lbl = document.createElement("span");
    lbl.textContent = " >= ";
    const inp = document.createElement("input");
    inp.type = "number";
    inp.className = "title-req-min";
    inp.min = "0";
    inp.max = "99";
    inp.value = req.min || 0;
    inp.style.width = "50px";
    const unit = document.createElement("span");
    unit.textContent = " คน";
    const del = document.createElement("button");
    del.type = "button";
    del.className = "small danger";
    del.textContent = "ลบ";
    del.addEventListener("click", () => { row.remove(); });
    row.append(sel, lbl, inp, unit, del);
    wrap.appendChild(row);
  });
}

function collectTitleRequirements() {
  const wrap = document.getElementById("shift_title_requirements");
  if (!wrap) return [];
  return Array.from(wrap.querySelectorAll(".title-req-row")).map(row => {
    const title = (row.querySelector(".title-req-title") || {}).value || "";
    const min = parseInt((row.querySelector(".title-req-min") || {}).value, 10) || 0;
    return { title: title.trim(), min };
  }).filter(r => r.title && r.min > 0);
}

document.getElementById("add_title_req_row").addEventListener("click", () => {
  const current = collectTitleRequirements();
  current.push({ title: "", min: 1 });
  renderTitleRequirements(current);
});

function resetShiftForm() {
  currentShiftId = null;
  const nameInput = document.getElementById("shift_name");
  if (nameInput) nameInput.value = "";
  setShiftActiveDaysOfMonth([]);
  const ihEl = document.getElementById("shift_include_holidays");
  if (ihEl) ihEl.checked = false;
  renderTitleRequirements([]);
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
  setShiftActiveDaysOfMonth(shift.active_days_of_month || []);
  const ihEl = document.getElementById("shift_include_holidays");
  if (ihEl) ihEl.checked = !!shift.include_holidays;
  renderTitleRequirements(shift.title_requirements || []);
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
      const holidayMode = typeof p === "object" && p.holiday_mode ? p.holiday_mode : "all";
      if (typeof addPositionRow === "function") {
        addPositionRow(name, note, slotCount, tw, reqSkill, minLvl, allowedTitles, maxPerWeek, activeWeekdays, holidayMode);
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

let _lastScheduleData = null;
let _lastStaffList = [];

function renderSchedule(data, staffList) {
  _lastScheduleData = data;
  _lastStaffList = staffList || [];
  const meta = document.getElementById("schedule_meta");
  const wrap = document.getElementById("schedule_table_wrap");
  const exportXlsx = document.getElementById("export_xlsx");
  const printBtn = document.getElementById("print_schedule");
  // Clear dummy warning banner ถ้ามี
  const oldWarn = document.getElementById("dummy_warn_banner");
  if (oldWarn) oldWarn.remove();

  if (!data) {
    meta.textContent = "ยังไม่มีตาราง — กด \"สร้างตารางเวร\" เพื่อสร้าง";
    wrap.innerHTML = "";
    if (exportXlsx) exportXlsx.style.display = "none";
    if (printBtn) printBtn.style.display = "none";
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
  if (exportXlsx) {
    exportXlsx.href = API + "/schedule/export/xlsx?run_id=" + runId;
    exportXlsx.style.display = "inline";
  }
  if (printBtn) printBtn.style.display = "inline";

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
  const orderedShiftNames = [];
  (shiftsCache || []).forEach((sh) => {
    if (sh && sh.name && shiftPositions[sh.name] && !orderedShiftNames.includes(sh.name)) {
      orderedShiftNames.push(sh.name);
    }
  });
  Object.keys(shiftPositions).forEach((sn) => {
    if (!orderedShiftNames.includes(sn)) orderedShiftNames.push(sn);
  });
  const shiftsMeta = orderedShiftNames.map((sn) => ({ name: sn, ...parseRoomAndKind(sn) }));
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
    let isHoliday = false;
    if (startDate) {
      const [sy, sm, sd] = startDate.split("-").map(Number);
      const dt = new Date(sy, sm - 1, sd + day);
      const iso = dt.getFullYear() + "-" + String(dt.getMonth()+1).padStart(2,"0") + "-" + String(dt.getDate()).padStart(2,"0");
      isHoliday = holidaySet.has(iso);
    }
    html += `<tr class="${isHoliday ? "tr-holiday" : ""}"><td>${escapeHtml(dayLabel)}</td>`;
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
            html += `<td class="td-has-dummy${roomSep}"><span class="cell-dummy" data-run="${runId}" data-day="${day}" data-shift="${escapeHtml(sn)}" data-pos="${escapeHtml(pos)}" data-slot="${si}" title="คลิกเพื่อมอบหมาย">ว่าง<span class="cell-dummy-hint">กดเพื่อมอบหมาย</span></span></td>`;
          } else {
            const nameSpan = `<span class="cell-name" data-run="${runId}" data-day="${day}" data-shift="${escapeHtml(sn)}" data-pos="${escapeHtml(pos)}" data-slot="${si}" data-name="${escapeHtml(s.staff_name)}" title="คลิกเพื่อเปลี่ยน">${escapeHtml(s.staff_name)}</span>`;
            const content = nameSpan;
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
  const dayShiftStaffMap = {};
  (data.slots || []).forEach((s) => {
    if (s.is_dummy) return;
    const d = Number(s.day);
    if (!busyByDay[d]) busyByDay[d] = new Set();
    busyByDay[d].add(s.staff_name);
    const key = `${d}-${s.shift_name}`;
    if (!dayShiftStaffMap[key]) dayShiftStaffMap[key] = new Set();
    dayShiftStaffMap[key].add(s.staff_name);
  });
  wrap.querySelectorAll(".cell-dummy").forEach((span) => {
    span.addEventListener("click", () => handleDummyClick(span, sf, runId, busyByDay, dayShiftStaffMap, startDate));
  });
  wrap.querySelectorAll(".cell-name").forEach((span) => {
    span.addEventListener("click", () => handleNameClick(span, sf, runId, busyByDay, dayShiftStaffMap, startDate));
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

  // --- ตาราง Staff × Shift ---
  const shiftNames = [...new Set(realSlots.map(s => s.shift_name))];
  const staffNames = sorted.map(([n]) => n);
  // นับ slot per staff per shift
  const matrix = {};
  realSlots.forEach(s => {
    const key = `${s.staff_name}|||${s.shift_name}`;
    matrix[key] = (matrix[key] || 0) + 1;
  });
  let matrixHtml = `<details class="summary-matrix-details"><summary class="summary-matrix-toggle">ดูตาราง เจ้าหน้าที่ × กะ</summary>` +
    `<div class="summary-matrix-wrap"><table class="summary-matrix"><thead><tr><th>ชื่อ</th>` +
    shiftNames.map(sn => `<th>${escapeHtml(sn)}</th>`).join("") +
    `<th><strong>รวม</strong></th></tr></thead><tbody>` +
    staffNames.map(name => {
      let rowTotal = 0;
      const cells = shiftNames.map(sn => {
        const cnt = matrix[`${name}|||${sn}`] || 0;
        rowTotal += cnt;
        return `<td class="${cnt === 0 ? "cell-zero" : ""}">${cnt || "-"}</td>`;
      }).join("");
      return `<tr><td class="matrix-name">${escapeHtml(name)}</td>${cells}<td><strong>${rowTotal}</strong></td></tr>`;
    }).join("") +
    `</tbody><tfoot><tr><td><strong>รวม/กะ</strong></td>` +
    shiftNames.map(sn => {
      const total = staffNames.reduce((sum, name) => sum + (matrix[`${name}|||${sn}`] || 0), 0);
      return `<td><strong>${total}</strong></td>`;
    }).join("") +
    `<td><strong>${realSlots.length}</strong></td></tr></tfoot></table></div></details>`;
  div.innerHTML += matrixHtml;

  wrap.after(div);
}

async function handleDummyClick(span, staffList, runId, busyByDay, dayShiftStaffMap, startDate) {
  if (span.dataset.loading) return;
  const day = parseInt(span.dataset.day, 10);
  const shiftName = span.dataset.shift;
  const position = span.dataset.pos;
  const slotIndex = parseInt(span.dataset.slot, 10);

  // --- Swap mode: สลับคนกับช่องว่าง ---
  if (_swapPending) {
    const src = _swapPending;
    _clearSwapPending();
    span.dataset.loading = "1";
    try {
      const r = await fetch(`${API}/schedule/${runId}/swap`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          day_a: src.day, shift_name_a: src.shiftName, position_a: src.position, slot_index_a: src.slotIndex,
          day_b: day, shift_name_b: shiftName, position_b: position, slot_index_b: slotIndex,
        }),
      });
      const rj = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(rj.detail || "swap failed");
      if (rj.warnings && rj.warnings.length) alert("⚠️ คำเตือน:\n" + rj.warnings.join("\n"));
      await refreshSchedule();
    } catch (e) {
      delete span.dataset.loading;
      alert("สลับไม่สำเร็จ: " + e.message);
    }
    return;
  }

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
  const positionTimeWindowName = posInfo && posInfo.time_window_name ? (posInfo.time_window_name || "").trim() : "";

  const canWorkPosition = (mt) => {
    if (!requiredSkill) return true;
    const skills = mt.skills || [];
    const levels = mt.skill_levels || {};
    if (!skills.includes(requiredSkill)) return false;
    const lvl = parseInt(levels[requiredSkill], 10) || 1;
    return lvl >= minSkillLevel;
  };

  // busySameShift = มีเวรในกะนี้แล้ว (hard block), busyOtherShift = มีเวรกะอื่น (warn เท่านั้น)
  const sameShiftKey = `${day}-${shiftName}`;
  const sameShiftStaff = (dayShiftStaffMap && dayShiftStaffMap[sameShiftKey]) ? dayShiftStaffMap[sameShiftKey] : new Set();
  const allDayStaff = (busyByDay && busyByDay[day]) ? busyByDay[day] : new Set();
  // แยกคนเลือกได้ vs เลือกไม่ได้ → เลือกได้อยู่ข้างบน
  const eligible = [];
  const ineligible = [];
  staffList.forEach((mt) => {
    const isBusySameShift = sameShiftStaff.has(mt.name);
    const isBusyOtherShift = !isBusySameShift && allDayStaff.has(mt.name);
    const hasSkill = canWorkPosition(mt);
    const isOff = _isStaffOffOnDay(mt, day, startDate);
    const hasTimeWindow = _canWorkPositionTimeWindow(mt, positionTimeWindowName);
    const pairCheck = _checkDependsOnPairForCandidate(mt.name, day, shiftName, dayShiftStaffMap, null);
    let label = mt.name;
    const reasons = [];
    if (isBusySameShift) reasons.push("มีเวรกะนี้แล้ว");
    else if (isBusyOtherShift) reasons.push("มีเวรกะอื่นวันนี้");
    if (!hasSkill && requiredSkill) reasons.push("ไม่มีทักษะ");
    if (isOff) reasons.push("off");
    if (!hasTimeWindow && positionTimeWindowName) reasons.push("ไม่อยู่ช่วงเวลา");
    if (!pairCheck.ok) reasons.push(pairCheck.reason);
    if (reasons.length) label += " (" + reasons.join(", ") + ")";
    const disabled = isBusySameShift || (!hasSkill && requiredSkill) || isOff || !hasTimeWindow || !pairCheck.ok;
    (disabled ? ineligible : eligible).push({ mt, label, disabled });
  });
  eligible.forEach(({ mt, label }) => {
    const opt = document.createElement("option");
    opt.value = mt.name;
    opt.textContent = label;
    select.appendChild(opt);
  });
  if (ineligible.length) {
    const sep = document.createElement("option");
    sep.disabled = true;
    sep.textContent = "── เลือกไม่ได้ ──";
    select.appendChild(sep);
    ineligible.forEach(({ mt, label }) => {
      const opt = document.createElement("option");
      opt.value = mt.name;
      opt.textContent = label;
      opt.disabled = true;
      select.appendChild(opt);
    });
  }

  const restoreSpan = () => {
    const ns = document.createElement("span");
    ns.className = "cell-dummy";
    ns.title = "คลิกเพื่อมอบหมาย";
    ns.textContent = "ว่าง";
    Object.assign(ns.dataset, { run: runId, day, shift: shiftName, pos: position, slot: slotIndex });
    select.replaceWith(ns);
    ns.addEventListener("click", () => handleDummyClick(ns, staffList, runId, busyByDay, dayShiftStaffMap, startDate));
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
      const rj = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(rj.detail || "assign failed");
      if (rj.warnings && rj.warnings.length) alert("⚠️ คำเตือน:\n" + rj.warnings.join("\n"));
      await refreshSchedule();
    } catch (e) {
      restoreSpan();
      alert("มอบหมายไม่สำเร็จ: " + e.message);
    }
  });
  select.addEventListener("blur", () => { if (!select.value) restoreSpan(); });
}

async function handleNameClick(span, staffList, runId, busyByDay, dayShiftStaffMap, startDate) {
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

  // --- Swap mode: คลิกที่สอง ---
  if (_swapPending) {
    const src = _swapPending;
    if (src.span === span) { _clearSwapPending(); return; }
    _clearSwapPending();
    span.dataset.loading = "1";
    try {
      const r = await fetch(`${API}/schedule/${runId}/swap`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          day_a: src.day, shift_name_a: src.shiftName, position_a: src.position, slot_index_a: src.slotIndex,
          day_b: day, shift_name_b: shiftName, position_b: position, slot_index_b: slotIndex,
        }),
      });
      const rj = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(rj.detail || "swap failed");
      // เก็บ swap ล่าสุดเพื่อ undo (สลับ a↔b กลับ)
      _lastSwap = {
        runId, name_a: src.staffName, name_b: currentName,
        day_a: src.day, shift_a: src.shiftName, pos_a: src.position, slot_a: src.slotIndex,
        day_b: day, shift_b: shiftName, pos_b: position, slot_b: slotIndex,
      };
      if (rj.warnings && rj.warnings.length) alert("⚠️ คำเตือน:\n" + rj.warnings.join("\n"));
      await refreshSchedule();
      _showUndoSwapBanner();
    } catch (e) {
      delete span.dataset.loading;
      alert("สลับไม่สำเร็จ: " + e.message);
    }
    return;
  }

  _openNameDropdown(span, staffList, runId, busyByDay, dayShiftStaffMap, day, shiftName, position, slotIndex, currentName, startDate);
}

function _openNameDropdown(span, staffList, runId, busyByDay, dayShiftStaffMap, day, shiftName, position, slotIndex, currentName, startDate) {
  const wrap = document.createElement("span");
  wrap.className = "name-edit-wrap";

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
  const positionTimeWindowName = posInfo && posInfo.time_window_name ? (posInfo.time_window_name || "").trim() : "";

  const canWorkPosition = (mt) => {
    if (!requiredSkill) return true;
    const skills = mt.skills || [];
    const levels = mt.skill_levels || {};
    if (!skills.includes(requiredSkill)) return false;
    const lvl = parseInt(levels[requiredSkill], 10) || 1;
    return lvl >= minSkillLevel;
  };

  const sameShiftKey2 = `${day}-${shiftName}`;
  const sameShiftStaff2 = (dayShiftStaffMap && dayShiftStaffMap[sameShiftKey2]) ? new Set([...dayShiftStaffMap[sameShiftKey2]]) : new Set();
  const allDayStaff2 = (busyByDay && busyByDay[day]) ? new Set([...busyByDay[day]]) : new Set();
  sameShiftStaff2.delete(currentName);
  allDayStaff2.delete(currentName);

  // แยกคนเลือกได้ vs เลือกไม่ได้ → เลือกได้อยู่ข้างบน
  const eligible = [];
  const ineligible = [];
  staffList.forEach((mt) => {
    const isBusySameShift = mt.name !== currentName && sameShiftStaff2.has(mt.name);
    const isBusyOtherShift = !isBusySameShift && mt.name !== currentName && allDayStaff2.has(mt.name);
    const hasSkill = canWorkPosition(mt);
    const isOff = _isStaffOffOnDay(mt, day, startDate);
    const hasTimeWindow = _canWorkPositionTimeWindow(mt, positionTimeWindowName);
    const pairCheck = _checkDependsOnPairForCandidate(mt.name, day, shiftName, dayShiftStaffMap, currentName);
    let label = mt.name;
    const reasons = [];
    if (isBusySameShift) reasons.push("มีเวรกะนี้แล้ว");
    else if (isBusyOtherShift) reasons.push("มีเวรกะอื่นวันนี้");
    if (!hasSkill && requiredSkill) reasons.push("ไม่มีทักษะ");
    if (isOff) reasons.push("off");
    if (!hasTimeWindow && positionTimeWindowName) reasons.push("ไม่อยู่ช่วงเวลา");
    if (!pairCheck.ok && mt.name !== currentName) reasons.push(pairCheck.reason);
    if (reasons.length) label += " (" + reasons.join(", ") + ")";
    const isCurrent = mt.name === currentName;
    const disabled = !isCurrent && (isBusySameShift || (!hasSkill && requiredSkill) || isOff || !hasTimeWindow || !pairCheck.ok);
    (disabled ? ineligible : eligible).push({ mt, label, disabled, isCurrent });
  });
  eligible.forEach(({ mt, label, isCurrent }) => {
    const opt = document.createElement("option");
    opt.value = mt.name;
    opt.textContent = label;
    if (isCurrent) opt.selected = true;
    select.appendChild(opt);
  });
  if (ineligible.length) {
    const sep = document.createElement("option");
    sep.disabled = true;
    sep.textContent = "── เลือกไม่ได้ ──";
    select.appendChild(sep);
    ineligible.forEach(({ mt, label }) => {
      const opt = document.createElement("option");
      opt.value = mt.name;
      opt.textContent = label;
      opt.disabled = true;
      select.appendChild(opt);
    });
  }

  const swapBtn = document.createElement("button");
  swapBtn.type = "button";
  swapBtn.className = "btn-swap-pick";
  swapBtn.title = "สลับกับช่องอื่น";
  swapBtn.textContent = "⇄";

  const restoreSpan = () => {
    const ns = document.createElement("span");
    ns.className = "cell-name";
    ns.title = "คลิกเพื่อเปลี่ยน";
    ns.textContent = currentName;
    Object.assign(ns.dataset, { run: runId, day, shift: shiftName, pos: position, slot: slotIndex, name: currentName });
    wrap.replaceWith(ns);
    ns.addEventListener("click", () => handleNameClick(ns, staffList, runId, busyByDay, dayShiftStaffMap, startDate));
  };

  wrap.appendChild(select);
  wrap.appendChild(swapBtn);
  span.replaceWith(wrap);
  select.focus();

  swapBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    // สร้าง span จำลองเพื่อใช้ใน swap
    const ns = document.createElement("span");
    ns.className = "cell-name cell-name-swap-pending";
    ns.title = "รอสลับ — คลิกชื่ออื่น หรือ Esc เพื่อยกเลิก";
    ns.textContent = currentName;
    Object.assign(ns.dataset, { run: runId, day, shift: shiftName, pos: position, slot: slotIndex, name: currentName });
    ns.addEventListener("click", () => handleNameClick(ns, staffList, runId, busyByDay, dayShiftStaffMap, startDate));
    wrap.replaceWith(ns);
    _swapPending = { span: ns, runId, day, shiftName, position, slotIndex, staffName: currentName };
  });

  select.addEventListener("change", async () => {
    const staffName = select.value;
    if (!staffName) return;
    select.disabled = true;
    swapBtn.disabled = true;
    try {
      const r = await fetch(`${API}/schedule/${runId}/slot`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ day, shift_name: shiftName, position, slot_index: slotIndex, staff_name: staffName }),
      });
      const rj = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(rj.detail || "assign failed");
      if (rj.warnings && rj.warnings.length) alert("⚠️ คำเตือน:\n" + rj.warnings.join("\n"));
      await refreshSchedule();
    } catch (e) {
      restoreSpan();
      alert("เปลี่ยนไม่สำเร็จ: " + e.message);
    }
  });
  select.addEventListener("blur", (e) => {
    // delay เพื่อให้ swapBtn click ทำงานก่อน
    setTimeout(() => { if (!wrap.contains(document.activeElement)) restoreSpan(); }, 150);
  });
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
  const addShiftLimits = document.getElementById("staff_add_shift_limits");
  if (addShiftLimits) renderShiftLimitsInputs(addShiftLimits, {});
  const addShiftDayRules = document.getElementById("staff_add_shift_day_rules");
  if (addShiftDayRules) renderShiftDayRulesInputs(addShiftDayRules, [], "#staff_add_shift_day_rule_add");
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
    { num: 1, label: "ทักษะ", done: lastCounts.skills > 0, page: "skills", hint: "เพิ่มทักษะก่อน" },
    { num: 2, label: "บุคลากร", done: lastCounts.staff > 0, page: "staff", hint: "เพิ่มบุคลากร" },
    { num: 3, label: "กะ", done: lastCounts.shifts > 0, page: "shifts", hint: "สร้างกะเวร" },
    { num: 4, label: "สร้างตาราง", done: false, page: null, hint: "" },
  ];
  const firstIncomplete = steps.findIndex((s) => !s.done);
  let html = "";
  steps.forEach((s, i) => {
    const isCurrent = i === firstIncomplete && !s.done;
    const doneClass = s.done ? " done" : isCurrent ? " current" : "";
    const inner = s.done ? "✓" : s.num;
    const label = s.page
      ? `<a href="#" class="process-step-link" data-page="${s.page}" title="${s.done ? "" : s.hint}">${escapeHtml(s.label)}</a>`
      : escapeHtml(s.label);
    html += `<span class="process-step${doneClass}" role="listitem"><span class="process-step-num">${inner}</span> ${label}${isCurrent ? `<span class="process-step-hint">${s.hint}</span>` : ""}</span>`;
    if (i < steps.length - 1) html += '<span class="process-step-connector" aria-hidden="true"></span>';
  });
  container.innerHTML = html;
  container.querySelectorAll(".process-step-link").forEach((a) => {
    a.addEventListener("click", (e) => { e.preventDefault(); navigateTo(a.dataset.page); });
  });
  const ready = lastCounts.skills > 0 && lastCounts.staff > 0 && lastCounts.shifts > 0;
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
  renderAllStaffMonthCalendars();
  syncShiftDaysWithHolidaySwitch();
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
    showToast("กรอกชื่อ", "error");
    return;
  }
  const titleEl = document.getElementById("staff_title_select");
  const title = (titleEl && titleEl.value) ? titleEl.value.trim() : "";
  const off_days = [];
  const addOffMonthEl = document.getElementById("staff_add_off_days_of_month");
  const addMonthMode = document.querySelector("input[name='staff_add_month_mode']:checked");
  const monthMode = addMonthMode ? addMonthMode.value : "off";
  const off_days_of_month = normalizeOffDaysByMode(
    addOffMonthEl ? addOffMonthEl.value : "",
    monthMode,
    getMonthTotalDays(),
  );
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
  const shift_day_rules = collectShiftDayRules("#staff_add_shift_day_rules");
  const shift_limits = collectShiftLimits("#staff_add_shift_limits");
  try {
    const r = await fetch(API + "/staff", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, title, off_days, off_days_of_month, skills, time_windows, min_shifts_per_month, max_shifts_per_month, min_gap_days, min_gap_shifts: [], min_gap_rules, shift_day_rules, shift_limits }),
    });
    if (!r.ok) {
      const d = await r.json().catch(() => ({}));
      const errMsg = formatApiError(d) || r.statusText || "เพิ่มไม่สำเร็จ";
      alert(errMsg);
      showToast(errMsg, "error");
      return;
    }
  } catch (e) {
    const errMsg = "เกิดข้อผิดพลาด: " + e.message;
    alert(errMsg);
    showToast(errMsg, "error");
    return;
  }
  document.getElementById("staff_name").value = "";
  if (titleEl) titleEl.value = "";
  if (addOffMonthEl) addOffMonthEl.value = "";
  renderStaffMonthCalendar("staff_add");
  if (minShiftsEl) minShiftsEl.value = "";
  if (maxShiftsEl) maxShiftsEl.value = "";
  document.querySelectorAll("#staff_add_min_gap_rules .min-gap-rule-input").forEach((el) => { el.value = ""; });
  document.querySelectorAll("#staff_add_shift_limits input").forEach((el) => { el.value = ""; });
  const addShiftDayRules = document.getElementById("staff_add_shift_day_rules");
  if (addShiftDayRules) renderShiftDayRulesInputs(addShiftDayRules, [], "#staff_add_shift_day_rule_add");
  document.querySelectorAll("#staff_add_time_windows input[type=checkbox]").forEach((cb) => { cb.checked = false; });
  showToast("เพิ่มบุคลากรแล้ว", "success");
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

function addPositionRow(name = "", note = "", slotCount = 1, timeWindowName = "", requiredSkill = "", minSkillLevel = 0, allowedTitles = [], maxPerWeek = 0, activeWeekdays = "", holidayMode = "all") {
  const list = document.getElementById("shift_positions_list");
  const posIndex = list.querySelectorAll(".pos-card").length + 1;
  const card = document.createElement("div");
  card.className = "pos-card";

  const hasAdvanced = !!(requiredSkill || minSkillLevel || (allowedTitles && allowedTitles.length) || maxPerWeek || note || activeWeekdays || (holidayMode && holidayMode !== "all"));

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

  const moveUpBtn = document.createElement("button");
  moveUpBtn.type = "button";
  moveUpBtn.className = "small btn-move-position";
  moveUpBtn.textContent = "↑";
  moveUpBtn.title = "เลื่อนช่องขึ้น";
  moveUpBtn.addEventListener("click", () => {
    const prev = card.previousElementSibling;
    if (!prev) return;
    list.insertBefore(card, prev);
    renumberPositionBadges();
  });

  const moveDownBtn = document.createElement("button");
  moveDownBtn.type = "button";
  moveDownBtn.className = "small btn-move-position";
  moveDownBtn.textContent = "↓";
  moveDownBtn.title = "เลื่อนช่องลง";
  moveDownBtn.addEventListener("click", () => {
    const next = card.nextElementSibling;
    if (!next) return;
    list.insertBefore(next, card);
    renumberPositionBadges();
  });

  const moveToWrap = document.createElement("span");
  moveToWrap.className = "position-move-to-wrap";

  const moveToLabel = document.createElement("span");
  moveToLabel.className = "position-move-to-label";
  moveToLabel.textContent = "ไปลำดับ";

  const moveToSel = document.createElement("select");
  moveToSel.className = "position-move-to";
  moveToSel.title = "ย้ายไปลำดับที่ต้องการ";
  moveToSel.setAttribute("aria-label", "ย้ายไปลำดับที่");
  moveToSel.addEventListener("change", () => {
    const target = parseInt(moveToSel.value, 10);
    if (isNaN(target) || target < 1) return;
    movePositionCardToIndex(card, target - 1, list);
    renumberPositionBadges();
  });

  moveToWrap.appendChild(moveToLabel);
  moveToWrap.appendChild(moveToSel);

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
  header.appendChild(moveUpBtn);
  header.appendChild(moveDownBtn);
  header.appendChild(moveToWrap);
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
  awWrap.title = "เปิดเฉพาะวัน: ถ้าไม่เลือกเลยจะถือว่าเปิดได้ทุกวันที่กะเปิด";
  const awLabel = document.createElement("label");
  awLabel.className = "position-active-weekdays-label";
  awLabel.textContent = "เปิดเฉพาะวัน:";
  const awChecks = document.createElement("span");
  awChecks.className = "position-active-weekdays";
  const activeDaySet = new Set(String(activeWeekdays || "")
    .split(",")
    .map((part) => parseInt(part.trim(), 10))
    .filter((day) => !isNaN(day) && day >= 0 && day <= 6));
  ["จ", "อ", "พ", "พฤ", "ศ", "ส", "อา"].forEach((label, day) => {
    const cbLabel = document.createElement("label");
    cbLabel.className = "position-weekday-cb";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.className = "position-active-weekday";
    cb.value = String(day);
    if (activeDaySet.has(day)) cb.checked = true;
    cbLabel.appendChild(cb);
    cbLabel.appendChild(document.createTextNode(" " + label));
    awChecks.appendChild(cbLabel);
  });
  awWrap.appendChild(awLabel);
  awWrap.appendChild(awChecks);

  const holidayWrap = document.createElement("span");
  holidayWrap.className = "position-holiday-mode-wrap";
  holidayWrap.title = "กำหนดว่าตำแหน่งนี้เปิดได้ในวันหยุดราชการหรือไม่";
  const holidayLabel = document.createElement("label");
  holidayLabel.className = "position-holiday-mode-label";
  holidayLabel.textContent = "วันหยุดราชการ:";
  const holidaySel = document.createElement("select");
  holidaySel.className = "position-holiday-mode";
  holidaySel.innerHTML = '<option value="all">ตามกะ</option><option value="non_holiday_only">ไม่ใช่วันหยุดราชการ</option><option value="holiday_only">เฉพาะวันหยุดราชการ</option>';
  holidaySel.value = ["all", "non_holiday_only", "holiday_only"].includes(String(holidayMode || "all")) ? String(holidayMode || "all") : "all";
  holidayWrap.appendChild(holidayLabel);
  holidayWrap.appendChild(holidaySel);

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
  adv.appendChild(holidayWrap);
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
  renumberPositionBadges();
}

function renumberPositionBadges() {
  const cards = document.querySelectorAll("#shift_positions_list .pos-card");
  cards.forEach((card, i) => {
    const badge = card.querySelector(".pos-badge");
    if (badge) badge.textContent = i + 1;
    const moveToSel = card.querySelector(".position-move-to");
    if (moveToSel) {
      const current = i + 1;
      const total = cards.length;
      let options = "";
      for (let n = 1; n <= total; n++) {
        options += "<option value=\"" + n + "\"" + (n === current ? " selected" : "") + ">" + n + "</option>";
      }
      moveToSel.innerHTML = options;
      moveToSel.disabled = total <= 1;
    }
  });
}

function movePositionCardToIndex(card, targetIndex, listEl) {
  const list = listEl || document.getElementById("shift_positions_list");
  if (!card || !list) return;
  const cards = Array.from(list.querySelectorAll(".pos-card"));
  const from = cards.indexOf(card);
  if (from < 0) return;
  const boundedTarget = Math.max(0, Math.min(targetIndex, cards.length - 1));
  if (boundedTarget === from) return;
  if (boundedTarget === cards.length - 1) {
    list.appendChild(card);
    return;
  }
  const ref = cards[boundedTarget];
  if (ref) list.insertBefore(card, ref);
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
    const weekdayChecked = Array.from(card.querySelectorAll(".position-active-weekday:checked"))
      .map((cb) => parseInt(cb.value, 10))
      .filter((day) => !isNaN(day) && day >= 0 && day <= 6)
      .sort((a, b) => a - b);
    const active_weekdays = weekdayChecked.length ? weekdayChecked.join(",") : null;
    const holidayModeEl = card.querySelector(".position-holiday-mode");
    const holiday_mode = holidayModeEl ? ((holidayModeEl.value || "all").trim() || "all") : "all";
    if (name) positions.push({ name, constraint_note: note, regular_only: false, slot_count, time_window_name, required_skill, min_skill_level, allowed_titles, max_per_week, active_weekdays, holiday_mode });
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
    showToast("กรอกชื่อกะ", "error");
    return;
  }
  let positions = collectShiftPositions();
  if (positions.length === 0) positions = [{ name: "ช่อง 1", constraint_note: "", regular_only: false }];
  const active_days = null;
  const active_days_of_month = getShiftActiveDaysOfMonthValues();
  const inclHolEl = document.getElementById("shift_include_holidays");
  const include_holidays = inclHolEl ? inclHolEl.checked : false;
  const isEdit = currentShiftId != null;
  const url = isEdit ? API + "/shifts/" + currentShiftId : API + "/shifts";
  const method = isEdit ? "PUT" : "POST";
  try {
    const r = await fetch(url, {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, positions, active_days, active_days_of_month, include_holidays, title_requirements: collectTitleRequirements() }),
    });
    if (!r.ok) {
      const d = await r.json().catch(() => ({}));
      const errMsg = formatApiError(d) || r.statusText || "บันทึกไม่สำเร็จ";
      alert(errMsg);
      showToast(errMsg, "error");
      return;
    }
  } catch (e) {
    const errMsg = "เกิดข้อผิดพลาด: " + e.message;
    alert(errMsg);
    showToast(errMsg, "error");
    return;
  }
  showToast(isEdit ? "บันทึกกะแล้ว" : "เพิ่มกะแล้ว", "success");
  resetShiftForm();
  await refreshShifts();
});

const shiftEditCancelBtn = document.getElementById("shift_edit_cancel");
if (shiftEditCancelBtn) {
  shiftEditCancelBtn.addEventListener("click", () => {
    resetShiftForm();
  });
}

const shiftIncludeHolidayEl = document.getElementById("shift_include_holidays");
if (shiftIncludeHolidayEl) {
  shiftIncludeHolidayEl.addEventListener("change", () => {
    syncShiftDaysWithHolidaySwitch();
  });
}

renderShiftActiveDaysOfMonthCalendar();

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
document.getElementById("template_6").addEventListener("click", () => applyTemplate(6));
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

  // Pre-validate: check staff and shifts exist before hitting server
  const missing = [];
  if (lastCounts.staff === 0) missing.push("บุคลากร");
  if (lastCounts.shifts === 0) missing.push("กะเวร");
  if (missing.length > 0) {
    const missingLinks = missing.map((m) => {
      const page = m === "บุคลากร" ? "staff" : "shifts";
      return `<a href="#" class="inline-link" data-page="${page}">${m}</a>`;
    }).join(" และ ");
    msg.innerHTML = `⚠ ยังไม่มี ${missingLinks} — กรุณาเพิ่มก่อนสร้างตาราง`;
    msg.className = "message error";
    msg.querySelectorAll(".inline-link").forEach((a) => {
      a.addEventListener("click", (e) => { e.preventDefault(); navigateTo(a.dataset.page); });
    });
    return;
  }
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
  // Use SSE stream for real-time progress
  const q = new URLSearchParams();
  if (num_days != null && num_days !== "") q.set("num_days", String(num_days));
  if (schedule_start_date) q.set("schedule_start_date", schedule_start_date);
  const streamUrl = API + "/schedule/run/stream" + (q.toString() ? "?" + q.toString() : "");

  // Progress bar
  let progressBar = document.getElementById("solver_progress");
  if (!progressBar) {
    progressBar = document.createElement("div");
    progressBar.id = "solver_progress";
    progressBar.style.cssText = "margin:8px 0;background:#e0e0e0;border-radius:6px;height:28px;overflow:hidden;position:relative;display:none;";
    progressBar.innerHTML = '<div id="solver_progress_fill" style="height:100%;background:linear-gradient(90deg,#4f8cff,#6dd5ed);width:0%;transition:width 0.4s;border-radius:6px;"></div>' +
      '<span id="solver_progress_text" style="position:absolute;top:0;left:0;right:0;text-align:center;line-height:28px;font-size:13px;font-weight:600;color:#333;"></span>';
    msg.parentNode.insertBefore(progressBar, msg);
  }
  const fill = document.getElementById("solver_progress_fill");
  const pText = document.getElementById("solver_progress_text");
  progressBar.style.display = "";
  fill.style.width = "0%";
  pText.textContent = "กำลังสร้าง... 0%";

  const es = new EventSource(streamUrl);
  es.addEventListener("progress", (e) => {
    try {
      const d = JSON.parse(e.data);
      const pct = d.percent || 0;
      fill.style.width = pct + "%";
      const secs = d.elapsed != null ? d.elapsed.toFixed(0) : "?";
      const sols = d.solutions || 0;
      if (btnText) btnText.textContent = `กำลังสร้าง... ${pct}%`;
      pText.textContent = `${pct}% — ${secs}s — ชนะไปแล้ว ${sols} วิธี`;
    } catch {}
  });
  es.addEventListener("result", async (e) => {
    es.close();
    fill.style.width = "100%";
    pText.textContent = "เสร็จสิ้น!";
    setTimeout(() => { progressBar.style.display = "none"; }, 2000);
    if (btn) { btn.disabled = false; btn.classList.remove("is-loading"); if (btnText) btnText.textContent = defaultText; }
    try {
      const data = JSON.parse(e.data);
      const slWarnings = data.shift_limits_warnings || [];
      if (data.has_dummy && data.dummy_count > 0) {
        const hints = (data.infeasibility_hints || []).map((h) => "<li>" + escapeHtml(h) + "</li>").join("");
        const slWarnHtml = slWarnings.map((w) => "<li>" + escapeHtml(w) + "</li>").join("");
        msg.innerHTML = `<strong>⚠ สร้างตารางได้บางส่วน — ว่าง ${data.dummy_count} ช่อง</strong> (คนไม่พอหรือมีข้อจำกัด)<br>` +
          (hints ? `<ul class="reasons-list">${hints}</ul>` : "") +
          (slWarnHtml ? `<ul class="reasons-list">${slWarnHtml}</ul>` : "") +
          `<br>ไปที่หน้า "ตารางล่าสุด" แล้วคลิก <strong>ว่าง</strong> เพื่อมอบหมายเอง`;
        msg.className = "message warning";
      } else {
        if (slWarnings.length > 0) {
          const slWarnHtml = slWarnings.map((w) => "<li>" + escapeHtml(w) + "</li>").join("");
          msg.innerHTML = `สร้างตารางเรียบร้อย (Run #${data.run_id})<br><strong>⚠ ตรวจพบปัญหา shift_limits:</strong><ul class="reasons-list">${slWarnHtml}</ul>`;
          msg.className = "message warning";
        } else {
          msg.textContent = "สร้างตารางเรียบร้อย (Run #" + data.run_id + ")";
          msg.className = "message success";
        }
      }
      // เคลียร์ข้อความ multi-shift เก่าก่อน
      document.querySelectorAll(".multi-shift-msg").forEach(el => el.remove());
      if (data.multi_shift_count > 0) {
        const details = (data.multi_shift_details || []);
        const startDateVal = document.getElementById("schedule_start_date")?.value;
        const startDate = startDateVal ? new Date(startDateVal) : null;
        const lines = details.map(d => {
          let dayLabel = "วันที่ " + (d.day + 1);
          if (startDate) {
            const dt = new Date(startDate);
            dt.setDate(dt.getDate() + d.day);
            dayLabel = dt.toLocaleDateString("th-TH", {day:"numeric",month:"short"});
          }
          return `<li>${escapeHtml(d.staff_name)} — ${dayLabel} (${d.shifts_on_day} เวร)</li>`;
        }).join("");
        const multiMsg = document.createElement("div");
        multiMsg.className = "message info multi-shift-msg";
        multiMsg.style.marginTop = "8px";
        multiMsg.innerHTML = `<strong>ℹ มีเจ้าหน้าที่ ${data.multi_shift_count} รายการที่อยู่มากกว่า 1 เวร/วัน</strong> ` +
          `(ระบบจัดให้เพราะคนไม่พอ)` +
          `<details style="margin-top:4px"><summary>ดูรายละเอียด</summary><ul>${lines}</ul></details>`;
        msg.parentNode.insertBefore(multiMsg, msg.nextSibling);
      }
      await refreshSettings();
      await refreshSchedule();
      updateHomeProcessSteps();
      showPage("schedule");
    } catch {}
  });
  es.addEventListener("error", (e) => {
    es.close();
    progressBar.style.display = "none";
    if (btn) { btn.disabled = false; btn.classList.remove("is-loading"); if (btnText) btnText.textContent = defaultText; }
    try {
      const d = JSON.parse(e.data);
      if (d.reasons && Array.isArray(d.reasons)) {
        msg.innerHTML = "<strong>จัดตารางไม่ได้ — สาเหตุที่เป็นไปได้:</strong><ul class=\"reasons-list\">" +
          d.reasons.map((r) => "<li>" + escapeHtml(r) + "</li>").join("") + "</ul>";
      } else {
        msg.textContent = d.message || "เกิดข้อผิดพลาด";
      }
    } catch {
      msg.textContent = "เกิดข้อผิดพลาดในการเชื่อมต่อ";
    }
    msg.className = "message error";
    msg.style.whiteSpace = "pre-wrap";
  });
  es.onerror = () => {
    es.close();
    progressBar.style.display = "none";
    if (btn) { btn.disabled = false; btn.classList.remove("is-loading"); if (btnText) btnText.textContent = defaultText; }
    if (!msg.textContent) {
      msg.textContent = "เกิดข้อผิดพลาดในการเชื่อมต่อ";
      msg.className = "message error";
    }
  };
});

async function showPage(pageId) {
  document.querySelectorAll(".app-page").forEach((el) => {
    const show = el.id === "page-" + pageId;
    el.style.display = show ? "" : "none";
    if (show) { el.style.animation = "none"; el.offsetHeight; el.style.animation = ""; }
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
    closeMobileSidebar();
    await showPage(a.dataset.page);
  });
});

/* ===== Mobile sidebar toggle ===== */
function openMobileSidebar() {
  document.getElementById("app_sidebar").classList.add("open");
  document.getElementById("sidebar_overlay").classList.add("active");
  document.body.style.overflow = "hidden";
}
function closeMobileSidebar() {
  document.getElementById("app_sidebar").classList.remove("open");
  document.getElementById("sidebar_overlay").classList.remove("active");
  document.body.style.overflow = "";
}
document.getElementById("hamburger_btn").addEventListener("click", openMobileSidebar);
document.getElementById("sidebar_close").addEventListener("click", closeMobileSidebar);
document.getElementById("sidebar_overlay").addEventListener("click", closeMobileSidebar);

document.querySelectorAll("input[name='staff_add_month_mode']").forEach((radio) => {
  radio.addEventListener("change", () => {
    switchStaffMonthMode("staff_add", radio.value);
  });
});
updateStaffMonthModeUI("staff_add");
renderStaffMonthCalendar("staff_add");

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
      syncShiftDaysWithHolidaySwitch();
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
    syncShiftDaysWithHolidaySwitch();
  } catch (e) {
    if (msgEl) { msgEl.textContent = "ผิดพลาด: " + e.message; msgEl.style.color = "#c62828"; }
  }
});

document.getElementById("schedule_start_date").addEventListener("change", () => {
  renderHolidayCalendar();
  renderAllStaffMonthCalendars();
  syncShiftDaysWithHolidaySwitch();
});

document.getElementById("num_days").addEventListener("input", () => {
  renderAllStaffMonthCalendars();
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

// --- Print Schedule A4 ---
// Shift color palette — cool tones, light/faded
const SHIFT_COLORS = [
  { bg: "#eff6ff" }, // blue-50
  { bg: "#f0fdfa" }, // teal-50
  { bg: "#eef2ff" }, // indigo-50
  { bg: "#f0f9ff" }, // sky-50
  { bg: "#faf5ff" }, // violet-50
  { bg: "#ecfeff" }, // cyan-50
  { bg: "#f0fdf4" }, // emerald-50
  { bg: "#f5f3ff" }, // purple-50
];

document.getElementById("print_schedule").addEventListener("click", () => {
  const wrap = document.getElementById("schedule_table_wrap");
  const table = wrap ? wrap.querySelector("table") : null;
  if (!table) { alert("ยังไม่มีตาราง"); return; }
  const metaEl = document.getElementById("schedule_meta");
  const metaText = metaEl ? metaEl.textContent : "";

  // Extract date range from meta text (e.g. "1 ม.ค. – 31 ม.ค.")
  const dateRangeMatch = metaText.match(/·\s*(.+)$/);
  const dateRange = dateRangeMatch ? dateRangeMatch[1].trim() : "";
  const wsName = _workspaceName || "";

  const printWin = window.open("", "_blank");

  // Clone table and strip interactive attrs
  const clone = table.cloneNode(true);
  clone.classList.add("schedule");
  clone.querySelectorAll("[data-run],[data-day],[data-shift],[data-pos],[data-slot],[data-name]").forEach(el => {
    ["data-run","data-day","data-shift","data-pos","data-slot","data-name"].forEach(a => el.removeAttribute(a));
    el.style.cursor = "default";
  });
  // Show only day number in first column (e.g. "1 ม.ค. 2568" → "1")
  clone.querySelectorAll("tbody tr td:first-child").forEach(td => {
    const txt = td.textContent.trim();
    const num = txt.match(/^(\d+)/);
    if (num) td.textContent = num[1];
  });

  const thShifts = clone.querySelectorAll("th.th-shift");

  // Color td cells by shift column (headers unchanged)
  const headerRows = clone.querySelectorAll("thead tr");
  let shiftRow = null;
  headerRows.forEach(r => { if (r.querySelector("th.th-shift")) shiftRow = r; });
  if (shiftRow) {
    const colColors = [];
    let colIdx = 1;
    shiftRow.querySelectorAll("th.th-shift").forEach((th, i) => {
      const span = parseInt(th.getAttribute("colspan") || "1");
      const c = SHIFT_COLORS[i % SHIFT_COLORS.length];
      for (let k = 0; k < span; k++) colColors[colIdx++] = c;
    });
    clone.querySelectorAll("tbody tr").forEach(row => {
      let ci = 0;
      row.querySelectorAll("td").forEach(td => {
        if (ci === 0) { ci++; return; }
        const c = colColors[ci];
        if (c && !td.classList.contains("td-has-dummy") && !td.classList.contains("td-inactive")) {
          td.style.background = c.bg;
        }
        ci++;
      });
    });
  }

  const now = new Date();
  const printedAt = now.toLocaleDateString("th-TH", { year: "numeric", month: "long", day: "numeric" });

  printWin.document.write(`<!DOCTYPE html><html><head>
<meta charset="utf-8">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Sarabun:wght@400;600;700&display=swap" rel="stylesheet">
<title>ตารางเวร</title>
<style>
@page { size: A4 landscape; margin: 10mm 8mm 12mm; }
* { box-sizing: border-box; margin: 0; padding: 0; }
body { font-family: "Sarabun", "Noto Sans Thai", sans-serif; font-size: 8pt; color: #1e293b; }

/* ── Header ── */
.print-header { display: flex; align-items: center; justify-content: space-between;
  border-bottom: 3px solid #1d4ed8; padding-bottom: 5px; margin-bottom: 7px; }
.print-header-left { display: flex; flex-direction: column; gap: 1px; }
.print-title { font-size: 14pt; font-weight: 700; color: #1d4ed8; letter-spacing: -0.3px; }
.print-subtitle { font-size: 9pt; color: #475569; }
.print-header-right { text-align: right; font-size: 7.5pt; color: #64748b; line-height: 1.6; }

/* ── Schedule Table ── */
table.schedule { width: 100%; border-collapse: collapse; table-layout: fixed; }
table.schedule th, table.schedule td {
  border: 1px solid #cbd5e1; padding: 2px 3px; text-align: center;
  font-size: 7pt; overflow: hidden; white-space: nowrap; text-overflow: ellipsis;
}
table.schedule thead th { font-weight: 700; }
.th-room { background: #0f172a !important; color: #f8fafc !important; font-size: 8pt; letter-spacing: 0.3px; }
.th-day { background: #f1f5f9 !important; color: #334155; font-weight: 700; width: 52px; min-width: 52px; }
table.schedule td:first-child { background: #f8fafc !important; font-weight: 600; white-space: nowrap; width: 52px; min-width: 52px; }
.td-has-dummy { background: #fee2e2 !important; color: #b91c1c !important; font-weight: 700; }
.td-inactive { background: #f8fafc !important; color: #94a3b8 !important; }
tr.tr-holiday td { background: #fef08a !important; }
tr.tr-holiday .td-has-dummy { background: #fee2e2 !important; }
tr.tr-holiday td:first-child { font-weight: 700; }

/* ── Legend ── */
.legend { display: flex; gap: 10px; flex-wrap: wrap; margin-top: 6px; align-items: center; }
.legend-item { display: flex; align-items: center; gap: 4px; font-size: 7.5pt; color: #334155; }
.legend-dot { width: 10px; height: 10px; border-radius: 2px; flex-shrink: 0; }
.legend-holiday { background: #fef08a; border: 1px solid #ca8a04; }
.legend-dummy { background: #fee2e2; border: 1px solid #f87171; }

/* ── Summary (page 2) ── */
.page-break { page-break-before: always; }
.summary-header { border-bottom: 3px solid #1d4ed8; padding-bottom: 5px; margin-bottom: 10px; }
.summary-title { font-size: 13pt; font-weight: 700; color: #1d4ed8; }
.summary-sub { font-size: 8.5pt; color: #475569; margin-top: 2px; }

/* KPI cards */
.kpi-row { display: flex; gap: 8px; margin-bottom: 12px; flex-wrap: wrap; }
.kpi-card { border: 1px solid #e2e8f0; border-radius: 6px; padding: 6px 12px;
  text-align: center; min-width: 58px; background: #f8fafc; }
.kpi-card.kpi-warn { border-color: #fca5a5; background: #fff1f2; }
.kpi-val { font-size: 14pt; font-weight: 700; color: #1e293b; line-height: 1.2; }
.kpi-label { font-size: 6.5pt; color: #64748b; margin-top: 2px; }

/* Summary table */
table.summary { border-collapse: collapse; width: 100%; }
table.summary th {
  background: #1e293b; color: #f8fafc; font-weight: 700;
  padding: 4px 8px; font-size: 8pt; white-space: nowrap; text-align: center;
}
table.summary th.col-name { text-align: left; }
table.summary td { border-bottom: 1px solid #f1f5f9; padding: 3px 8px; font-size: 8pt; vertical-align: middle; }
table.summary tr.row-even td { background: #f8fafc; }
.col-rank { width: 24px; text-align: center; color: #94a3b8; font-size: 7pt; }
.col-name { text-align: left; font-weight: 600; white-space: nowrap; min-width: 80px; }
.col-bar { width: 160px; padding: 3px 8px; }
.col-shift { width: 40px; text-align: center; }
.col-total { width: 36px; text-align: center; font-weight: 700; color: #1d4ed8; }
.cell-zero { color: #cbd5e1; }
.bar-wrap { position: relative; background: #f1f5f9; border-radius: 3px; height: 12px;
  display: flex; align-items: center; overflow: hidden; }
.bar-fill { position: absolute; left: 0; top: 0; bottom: 0;
  background: linear-gradient(90deg, #3b82f6, #60a5fa); border-radius: 3px; }
.bar-label { position: relative; z-index: 1; font-size: 7pt; font-weight: 700;
  color: #1e293b; padding-left: 5px; }
table.summary tfoot td { border-top: 2px solid #1e293b; font-size: 8pt; text-align: center;
  background: #f8fafc; padding: 3px 8px; }
.foot-label { text-align: left; font-weight: 600; color: #475569; }

/* ── Footer ── */
@page { @bottom-right { content: "หน้า " counter(page) "/" counter(pages); font-size: 7pt; } }
.print-footer { position: fixed; bottom: 0; left: 0; right: 0; text-align: right;
  font-size: 6.5pt; color: #94a3b8; border-top: 1px solid #e2e8f0; padding-top: 3px; }

@media print {
  body { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
}
</style></head><body>

<div class="print-header">
  <div class="print-header-left">
    <span class="print-title">ตารางเวร${wsName ? " — " + wsName.replace(/&/g,"&amp;").replace(/</g,"&lt;") : ""}</span>
    <span class="print-subtitle">${dateRange ? "ประจำเดือน " + dateRange.replace(/&/g,"&amp;").replace(/</g,"&lt;") : ""}</span>
  </div>
  <div class="print-header-right">
    พิมพ์เมื่อ ${printedAt}<br>
    <span style="color:#94a3b8">Shift Optimizer</span>
  </div>
</div>
`);

  printWin.document.write(clone.outerHTML);

  let legendHtml = '<div class="legend">';
  legendHtml += '<div class="legend-item"><div class="legend-dot legend-holiday"></div>วันหยุดราชการ</div>';
  legendHtml += '<div class="legend-item"><div class="legend-dot legend-dummy"></div>ช่องว่าง (จัดไม่ได้)</div>';
  legendHtml += '</div>';
  printWin.document.write(legendHtml);

  // Summary on page 2 — rebuilt from data (not DOM clone)
  if (_lastScheduleData && _lastScheduleData.slots) {
    const slots = _lastScheduleData.slots;
    const realSlots = slots.filter(s => !s.is_dummy);
    const dummyCount = slots.filter(s => s.is_dummy).length;
    const countByStaff = {};
    const shiftSet = new Set();
    const matrix = {};
    realSlots.forEach(s => {
      countByStaff[s.staff_name] = (countByStaff[s.staff_name] || 0) + 1;
      shiftSet.add(s.shift_name);
      const k = s.staff_name + "|||" + s.shift_name;
      matrix[k] = (matrix[k] || 0) + 1;
    });
    const sorted = Object.entries(countByStaff).sort((a, b) => b[1] - a[1]);
    const shiftNames = [...shiftSet];
    const maxC = sorted.length ? sorted[0][1] : 0;
    const minC = sorted.length ? sorted[sorted.length - 1][1] : 0;
    const spread = maxC - minC;
    const avg = sorted.length ? (realSlots.length / sorted.length).toFixed(1) : 0;
    const spreadClass = spread <= 1 ? "#16a34a" : spread <= 2 ? "#d97706" : "#dc2626";
    const esc = s => s.replace(/&/g,"&amp;").replace(/</g,"&lt;");

    printWin.document.write(`<div class="page-break"></div>
<div class="summary-header">
  <div class="summary-title">สรุปเวรต่อคน${wsName ? " — " + esc(wsName) : ""}</div>
  <div class="summary-sub">${dateRange ? "ประจำเดือน " + esc(dateRange) : ""}</div>
</div>

<div class="kpi-row">
  <div class="kpi-card"><div class="kpi-val">${sorted.length}</div><div class="kpi-label">บุคลากร</div></div>
  <div class="kpi-card"><div class="kpi-val">${realSlots.length}</div><div class="kpi-label">เวรทั้งหมด</div></div>
  <div class="kpi-card"><div class="kpi-val">${avg}</div><div class="kpi-label">เฉลี่ย/คน</div></div>
  <div class="kpi-card"><div class="kpi-val">${maxC}</div><div class="kpi-label">สูงสุด</div></div>
  <div class="kpi-card"><div class="kpi-val">${minC}</div><div class="kpi-label">ต่ำสุด</div></div>
  <div class="kpi-card"><div class="kpi-val" style="color:${spreadClass}">${spread}</div><div class="kpi-label">ความต่าง</div></div>
  ${dummyCount > 0 ? `<div class="kpi-card kpi-warn"><div class="kpi-val">${dummyCount}</div><div class="kpi-label">ช่องว่าง</div></div>` : ""}
</div>

<table class="summary">
<thead>
  <tr>
    <th class="col-rank">#</th>
    <th class="col-name">ชื่อ</th>
    <th class="col-bar">จำนวนเวร</th>
    ${shiftNames.map(sn => `<th class="col-shift">${esc(sn)}</th>`).join("")}
    <th class="col-total">รวม</th>
  </tr>
</thead>
<tbody>
${sorted.map(([name, total], i) => {
  const pct = maxC > 0 ? Math.round((total / maxC) * 100) : 0;
  const cells = shiftNames.map(sn => {
    const v = matrix[name + "|||" + sn] || 0;
    return `<td class="col-shift${v === 0 ? " cell-zero" : ""}">${v || "—"}</td>`;
  }).join("");
  const rowClass = i % 2 === 1 ? ' class="row-even"' : '';
  return `<tr${rowClass}>
    <td class="col-rank">${i + 1}</td>
    <td class="col-name">${esc(name)}</td>
    <td class="col-bar"><div class="bar-wrap"><div class="bar-fill" style="width:${pct}%"></div><span class="bar-label">${total}</span></div></td>
    ${cells}
    <td class="col-total">${total}</td>
  </tr>`;
}).join("")}
</tbody>
<tfoot>
  <tr>
    <td colspan="3" class="foot-label">รวม/กะ</td>
    ${shiftNames.map(sn => {
      const t = sorted.reduce((s, [name]) => s + (matrix[name + "|||" + sn] || 0), 0);
      return `<td class="col-shift"><strong>${t}</strong></td>`;
    }).join("")}
    <td class="col-total"><strong>${realSlots.length}</strong></td>
  </tr>
</tfoot>
</table>`);
  }

  printWin.document.write('</body></html>');
  printWin.document.close();
  setTimeout(() => { printWin.focus(); printWin.print(); }, 600);
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
    pairRulesCache = Array.isArray(pairs) ? pairs : [];
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

let _workspaceName = "";
if (WORKSPACE_ID) {
  fetch("/api/workspaces/" + WORKSPACE_ID).then(r => r.ok ? r.json() : null).then(ws => {
    if (ws && ws.name) _workspaceName = ws.name;
  }).catch(() => {});
}

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
