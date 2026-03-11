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
const DAY_NAMES = ["จันทร์", "อังคาร", "พุธ", "พฤหัสบดี", "ศุกร์", "เสาร์", "อาทิตย์"];

function escapeHtml(s) {
  const div = document.createElement("div");
  div.textContent = s;
  return div.innerHTML;
}

function getQueryId() {
  const params = new URLSearchParams(window.location.search);
  const id = params.get("id");
  return id ? parseInt(id, 10) : null;
}

function renderStaffDetail(staff) {
  const typeLabel = staff.type === "fulltime" ? "เต็มเวลา" : "พาร์ทไทม์";
  const offLabel =
    staff.off_days && staff.off_days.length
      ? staff.off_days.map((d) => (DAY_NAMES[d] != null ? DAY_NAMES[d] : "วัน " + d)).join(", ")
      : "ไม่มี";
  const skillsLabel =
    staff.skills && staff.skills.length ? staff.skills.join(", ") : "—";

  return (
    "<dl class=\"staff-detail-dl\">" +
    "<dt>ชื่อ</dt><dd>" + escapeHtml(staff.name) + "</dd>" +
    "<dt>ประเภท</dt><dd>" + escapeHtml(typeLabel) + "</dd>" +
    "<dt>วันหยุด (0–6)</dt><dd>" + escapeHtml(offLabel) + "</dd>" +
    "<dt>Skills</dt><dd>" + escapeHtml(skillsLabel) + "</dd>" +
    "</dl>"
  );
}

async function loadStaffDetail() {
  const id = getQueryId();
  const loadingEl = document.getElementById("staff_loading");
  const contentEl = document.getElementById("staff_content");
  const errorEl = document.getElementById("staff_error");

  loadingEl.style.display = "block";
  contentEl.style.display = "none";
  errorEl.style.display = "none";

  if (!id || isNaN(id)) {
    loadingEl.style.display = "none";
    errorEl.textContent = "ไม่ได้ระบุ ID บุคลากร หรือ ID ไม่ถูกต้อง";
    errorEl.style.display = "block";
    return;
  }

  try {
    const r = await fetch(API + "/staff/" + id);
    if (!r.ok) {
      if (r.status === 404) {
        errorEl.textContent = "ไม่พบบุคลากรนี้";
      } else {
        errorEl.textContent = "โหลดข้อมูลไม่สำเร็จ (" + r.status + ")";
      }
      errorEl.style.display = "block";
      contentEl.style.display = "none";
      loadingEl.style.display = "none";
      return;
    }
    const staff = await r.json();
    contentEl.innerHTML = renderStaffDetail(staff);
    contentEl.style.display = "block";
    errorEl.style.display = "none";
  } catch (e) {
    errorEl.textContent = "เกิดข้อผิดพลาด: " + e.message;
    errorEl.style.display = "block";
    contentEl.style.display = "none";
  }
  loadingEl.style.display = "none";
}

loadStaffDetail();
