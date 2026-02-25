const API = "/api";
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
