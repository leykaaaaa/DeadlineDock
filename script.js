"use strict";

/* ==========================================================
   DeadlineDock: Class Schedule and Assignment Planner (prototype)
   Sections: 1 Data & storage | 2 Business logic | 3 Rendering
             4 Dialog handlers | 5 Backup tools | 6 Event listeners
   ========================================================== */

/* ---------- 1. DATA & STORAGE ---------- */
const STORAGE_KEY = "deadlinedock.v1";
const BACKUP_KEY = "deadlinedock.lastBackup";
const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const COLORS = { Blue: "#2f6fdd", Green: "#2e8b57", Orange: "#d9730d", Purple: "#7b4bc2", Red: "#c93a3a", Teal: "#1b8a8f", Gray: "#6b7280" };
const PRIORITY_RANK = { High: 0, Medium: 1, Low: 2 };

let state = { subjects: [], assignments: [], settings: { dueSoonDays: 3 } };
let editingSubjectId = null;
let editingAssignmentId = null;

const $ = (sel) => document.querySelector(sel);
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const plural = (n, word) => n + " " + word + (n === 1 ? "" : "s");
const pad = (n) => String(n).padStart(2, "0");

function dateStr(d) { return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()); }
function todayStr() { return dateStr(new Date()); }
function addDays(n) { const d = new Date(); d.setDate(d.getDate() + n); return dateStr(d); }
function parseDate(s) { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); }
function daysLeft(due) {
  const t = new Date(); t.setHours(0, 0, 0, 0);
  return Math.round((parseDate(due) - t) / 864e5);
}
function todayIndex() { return (new Date().getDay() + 6) % 7; }   // Monday = 0
function toMin(t) { const [h, m] = t.split(":").map(Number); return h * 60 + m; }
function fmt12(t) { const h = Number(t.slice(0, 2)); return (h % 12 || 12) + ":" + t.slice(3, 5) + " " + (h < 12 ? "AM" : "PM"); }
function range(ses) { return fmt12(ses.start) + " - " + fmt12(ses.end); }
function colorOf(subject) { return COLORS[subject && subject.color] || COLORS.Blue; }
function subjectById(id) { return state.subjects.find((s) => s.id === id); }

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
function isValidState(d) {
  return d && Array.isArray(d.subjects) && Array.isArray(d.assignments) &&
    d.subjects.every((s) => s.id && typeof s.name === "string" && Array.isArray(s.sessions) &&
      s.sessions.every((x) => Number.isInteger(Number(x.day)) && x.day >= 0 && x.day <= 6 && TIME_RE.test(x.start) && TIME_RE.test(x.end))) &&
    d.assignments.every((a) => a.id && a.subjectId && typeof a.title === "string" && /^\d{4}-\d{2}-\d{2}$/.test(a.due));
}
function normalizeState(d) {
  const n = Number(d.settings && d.settings.dueSoonDays);
  d.settings = { dueSoonDays: n >= 1 && n <= 7 ? n : 3 };
  d.subjects.forEach((s) => {
    s.place = s.place || "";
    s.color = COLORS[s.color] ? s.color : "Blue";
    s.sessions.forEach((x) => { x.day = Number(x.day); });
  });
  d.assignments.forEach((a) => {
    a.type = a.type || "Assignment";
    a.priority = PRIORITY_RANK[a.priority] !== undefined ? a.priority : "Medium";
    a.notes = a.notes || "";
    a.done = !!a.done;
  });
  return d;
}

function loadData() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const data = JSON.parse(raw);
      if (isValidState(data)) state = normalizeState(data);
    }
  } catch (err) {
    showToast("Saved data could not be read. Starting empty.", true);
  }
}
function saveData() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch (err) {
    showToast("Could not save data in this browser.", true);
  }
}
function commit() { saveData(); render(); }

// Runs a change, saves it, and offers an Undo button
function withUndo(message, change) {
  const snapshot = JSON.stringify(state);
  change();
  commit();
  showToast(message, false, () => { state = JSON.parse(snapshot); commit(); });
}

/* ---------- 2. BUSINESS LOGIC ---------- */
// Feature 5: deadline flag from date comparison
function computeFlag(a) {
  if (a.done) return { key: "done", text: "Done", detail: "" };
  const days = daysLeft(a.due);
  if (days < 0) return { key: "overdue", text: "Overdue", detail: plural(-days, "day") + " late" };
  if (days === 0) return { key: "today", text: "Due Today", detail: "Today" };
  if (days <= state.settings.dueSoonDays) return { key: "soon", text: "Due Soon", detail: plural(days, "day") + " left" };
  return { key: "upcoming", text: "Upcoming", detail: plural(days, "day") + " left" };
}

function sessionsOn(day) {
  const out = [];
  state.subjects.forEach((s) => s.sessions.forEach((ses, i) => {
    if (ses.day === day) out.push({ subject: s, ses, key: s.id + ":" + i });
  }));
  return out.sort((a, b) => toMin(a.ses.start) - toMin(b.ses.start));
}

// Feature 2: overlapping sessions on the same day
function findOverlaps() {
  const list = [], keys = new Set();
  for (let d = 0; d < 7; d++) {
    const items = sessionsOn(d);
    for (let i = 0; i < items.length; i++) {
      for (let j = i + 1; j < items.length; j++) {
        const a = items[i], b = items[j];
        if (toMin(a.ses.start) < toMin(b.ses.end) && toMin(b.ses.start) < toMin(a.ses.end)) {
          list.push({ day: d, a, b });
          keys.add(a.key); keys.add(b.key);
        }
      }
    }
  }
  return { list, keys };
}

function progressOf(list) {
  const done = list.filter((a) => a.done).length;
  return { done, total: list.length, pct: list.length ? Math.round((done / list.length) * 100) : 0 };
}

// Feature 7: search, filter, sort
function getVisibleAssignments() {
  const q = $("#searchInput").value.trim().toLowerCase();
  const subj = $("#subjectFilter").value, status = $("#statusFilter").value;
  const type = $("#typeFilter").value, pri = $("#priorityFilter").value, sort = $("#sortBy").value;
  const nameOf = (a) => (subjectById(a.subjectId) || { name: "" }).name;
  const rows = state.assignments.filter((a) =>
    (!q || a.title.toLowerCase().includes(q)) &&
    (subj === "all" || a.subjectId === subj) &&
    (status === "all" || computeFlag(a).text === status) &&
    (type === "all" || a.type === type) &&
    (pri === "all" || a.priority === pri));
  const byDue = (a, b) => (a.done - b.done) || a.due.localeCompare(b.due);
  rows.sort((a, b) =>
    sort === "subject" ? nameOf(a).localeCompare(nameOf(b)) || byDue(a, b) :
    sort === "priority" ? (PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority]) || byDue(a, b) :
    byDue(a, b));
  return rows;
}

/* ---------- 3. RENDERING ---------- */
let toastTimer;
// The toast is a popover so it also appears on top of open dialogs
function showToast(msg, isError = false, undoFn = null) {
  const el = $("#toast");
  el.textContent = "";
  const text = document.createElement("span");
  text.textContent = msg;
  el.appendChild(text);
  if (undoFn) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "toast-btn";
    b.textContent = "Undo";
    b.addEventListener("click", () => { hideToast(); undoFn(); });
    el.appendChild(b);
  }
  el.className = "show" + (isError ? " error" : "");
  try { if (el.showPopover && !el.matches(":popover-open")) el.showPopover(); } catch (e) { /* older browsers */ }
  clearTimeout(toastTimer);
  toastTimer = setTimeout(hideToast, undoFn ? 7000 : 3500);
}
function hideToast() {
  const el = $("#toast");
  el.className = "";
  try { if (el.hidePopover && el.matches(":popover-open")) el.hidePopover(); } catch (e) { /* older browsers */ }
}

const barHtml = (pct) => `<div class="bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}"><span style="width:${pct}%"></span></div>`;
const badge = (f) => `<span class="badge f-${f.key}">${f.text}</span>`;

function showView(name) {
  ["today", "schedule", "assignments"].forEach((v) => { $("#view-" + v).hidden = v !== name; });
  document.querySelectorAll(".tab").forEach((b) => {
    if (b.dataset.view === name) b.setAttribute("aria-current", "page"); else b.removeAttribute("aria-current");
  });
}

// Feature 6: Today dashboard
function renderToday() {
  const idx = todayIndex();
  $("#todayDayName").textContent = DAYS[idx] + ", " + new Date().toLocaleDateString("en-PH", { month: "long", day: "numeric", year: "numeric" });
  const { keys } = findOverlaps();
  const now = new Date().getHours() * 60 + new Date().getMinutes();
  const classes = sessionsOn(idx);
  $("#todayClasses").innerHTML = classes.length ? classes.map(({ subject: s, ses, key }) => {
    const live = toMin(ses.start) <= now && now < toMin(ses.end);
    return `<li class="item" style="border-left-color:${colorOf(s)}"><span class="grow"><strong>${esc(s.name)}</strong>
      <span class="sub">${range(ses)}${s.place ? " | " + esc(s.place) : ""}</span></span>
      ${live ? '<span class="badge f-done">Now</span>' : ""}${keys.has(key) ? '<span class="badge f-overdue">Overlap</span>' : ""}</li>`;
  }).join("") : '<li class="empty-li">No classes today.</li>';

  const pending = state.assignments.filter((a) => !a.done);
  const attention = pending.filter((a) => ["overdue", "today", "soon"].includes(computeFlag(a).key))
    .sort((a, b) => a.due.localeCompare(b.due));
  $("#attentionList").innerHTML = attention.length ? attention.slice(0, 8).map((a) => {
    const f = computeFlag(a), s = subjectById(a.subjectId);
    return `<li class="item" style="border-left-color:${colorOf(s)}">
      <label class="chk"><input type="checkbox" data-action="toggle" data-id="${a.id}" aria-label="Mark ${esc(a.title)} as done"></label>
      <span class="grow"><strong>${esc(a.title)}</strong><span class="sub">${esc(s ? s.name : "Unknown subject")} | due ${esc(a.due)} (${f.detail})</span></span>${badge(f)}</li>`;
  }).join("") : '<li class="empty-li">Nothing urgent. Nice work.</li>';

  $("#statDueToday").textContent = pending.filter((a) => daysLeft(a.due) === 0).length;
  $("#statOverdue").textContent = pending.filter((a) => daysLeft(a.due) < 0).length;

  $("#subjectProgress").innerHTML = state.subjects.length ? state.subjects.map((s) => {
    const p = progressOf(state.assignments.filter((a) => a.subjectId === s.id));
    return `<div class="sp"><strong><span class="dot" style="background:${colorOf(s)}"></span>${esc(s.name)}</strong>
      <span>${p.total ? p.done + " of " + p.total + " done" : "No assignments yet"}</span>${barHtml(p.pct)}</div>`;
  }).join("") : '<p class="note">Add a subject to start tracking progress.</p>';
}

function updateProgress() {   // Feature 4: live progress counter
  const p = progressOf(state.assignments);
  const text = p.done + " of " + p.total + " done";
  $("#statProgress").textContent = text;
  $("#statProgressBar").innerHTML = barHtml(p.pct);
  $("#progressText").textContent = text;
  $("#progressBar").innerHTML = barHtml(p.pct);
}

// Feature 2: weekly schedule view
function renderSchedule() {
  const { list, keys } = findOverlaps();
  const warn = $("#overlapWarn");
  warn.hidden = !list.length;
  warn.innerHTML = list.map(({ day, a, b }) =>
    `<span>Warning: ${esc(a.subject.name)} and ${esc(b.subject.name)} overlap on ${DAYS[day]} (${range(a.ses)} and ${range(b.ses)}).</span>`).join("");
  const today = todayIndex();
  $("#weekGrid").innerHTML = DAYS.map((name, d) => {
    const items = sessionsOn(d);
    return `<div class="day ${d === today ? "today" : ""}"><div class="day-head">${name.slice(0, 3)}${d === today ? " (Today)" : ""}</div>` +
      (items.length ? items.map(({ subject: s, ses, key }) => `<div class="block ${keys.has(key) ? "clash" : ""}" style="border-left-color:${colorOf(s)}">
        <strong>${esc(s.name)}</strong><br>${range(ses)}${s.place ? "<br>" + esc(s.place) : ""}${keys.has(key) ? '<span class="clash-tag">Overlap!</span>' : ""}</div>`).join("")
        : '<div class="note" style="text-align:center">No classes</div>') + "</div>";
  }).join("");

  $("#subjectList").innerHTML = state.subjects.length ? state.subjects.map((s) => {
    const n = state.assignments.filter((a) => a.subjectId === s.id).length;
    const sessions = s.sessions.slice().sort((x, y) => x.day - y.day || toMin(x.start) - toMin(y.start))
      .map((x) => DAYS[x.day].slice(0, 3) + " " + range(x)).join(", ");
    return `<li class="item" style="border-left-color:${colorOf(s)}"><span class="grow"><strong>${esc(s.name)}</strong>
      <span class="sub">${esc(sessions)}${s.place ? " | " + esc(s.place) : ""} | ${plural(n, "assignment")}</span></span>
      <button type="button" class="btn small" data-action="editSubject" data-id="${s.id}">Edit</button>
      <button type="button" class="btn small danger" data-action="deleteSubject" data-id="${s.id}">Delete</button></li>`;
  }).join("") : '<li class="empty-li">No subjects yet. Click + Subject to add one.</li>';
}

function renderFilters() {
  const sel = $("#subjectFilter");
  const current = sel.value || "all";
  sel.innerHTML = '<option value="all">Subject: All</option>' +
    state.subjects.map((s) => `<option value="${s.id}">${esc(s.name)}</option>`).join("");
  sel.value = state.subjects.some((s) => s.id === current) ? current : "all";
  $("#dueSoonDays").value = String(state.settings.dueSoonDays);
}

// Features 3, 4, 5, 7: assignment list
function renderAssignments() {
  const rows = getVisibleAssignments();
  $("#asgBody").innerHTML = rows.map((a) => {
    const f = computeFlag(a), s = subjectById(a.subjectId);
    return `<tr class="r-${f.key}">
      <td data-label="Done"><label class="chk"><input type="checkbox" data-action="toggle" data-id="${a.id}" ${a.done ? "checked" : ""} aria-label="Mark ${esc(a.title)} as done"></label></td>
      <td class="td-title"><strong class="title">${esc(a.title)}</strong><span class="sub">${esc(a.type)} | ${esc(a.priority)} priority${a.notes ? " | " + esc(a.notes) : ""}</span></td>
      <td data-label="Subject"><span><span class="dot" style="background:${colorOf(s)}"></span>${esc(s ? s.name : "Unknown")}</span></td>
      <td data-label="Due date">${esc(a.due)}</td>
      <td data-label="Flag"><span>${badge(f)}${f.detail ? ` <span class="sub">${f.detail}</span>` : ""}</span></td>
      <td class="td-actions"><div class="row-actions">
        <button type="button" class="btn small" data-action="editAssignment" data-id="${a.id}">Edit</button>
        <button type="button" class="btn small danger" data-action="deleteAssignment" data-id="${a.id}">Delete</button></div></td></tr>`;
  }).join("");
  const empty = $("#asgEmpty");
  empty.hidden = rows.length > 0;
  if (!rows.length) {
    empty.textContent = state.assignments.length ? "No assignments match your search or filters."
      : "No assignments yet. Add a subject, then click + Assignment, or load the sample data.";
  }
}

function updateBackupNote() {
  const el = $("#backupNote");
  const last = localStorage.getItem(BACKUP_KEY);
  const hasData = state.subjects.length > 0;
  let text = "", warn = false;
  if (last) {
    const days = Math.floor((Date.now() - new Date(last).getTime()) / 864e5);
    text = "Last backup: " + (days <= 0 ? "today" : plural(days, "day") + " ago") + ".";
    warn = hasData && days > 7;
  } else if (hasData) {
    text = "No backup yet. Use Export Data to save a copy.";
    warn = true;
  }
  el.textContent = text;
  el.classList.toggle("warn", warn);
}

function render() {
  renderFilters();
  renderToday();
  renderSchedule();
  renderAssignments();
  updateProgress();
  updateBackupNote();
}

/* ---------- 4. DIALOG HANDLERS ---------- */
function clearErrors(scope) { scope.querySelectorAll(".err").forEach((e) => { e.textContent = ""; }); }
function showErrors(errs) { Object.entries(errs).forEach(([k, msg]) => { $("#err-" + k).textContent = msg; }); }

/* Subjects (Feature 1) */
function sessionRowHtml(s = { day: 0, start: "", end: "" }) {
  return `<div class="session-row">
    <label>Day<select class="s-day">${DAYS.map((d, i) => `<option value="${i}" ${i === s.day ? "selected" : ""}>${d}</option>`).join("")}</select></label>
    <label>Start<input type="time" class="s-start" value="${s.start}"></label>
    <label>End<input type="time" class="s-end" value="${s.end}"></label>
    <button type="button" class="btn small danger" data-action="removeSession">Remove</button>
    <span class="err row-err"></span></div>`;
}
function addSession() {
  const rows = $("#sessionRows");
  const last = rows.lastElementChild;
  rows.insertAdjacentHTML("beforeend", sessionRowHtml({ day: last ? Number(last.querySelector(".s-day").value) : 0, start: "", end: "" }));
}
function readSessions() {
  return [...document.querySelectorAll("#sessionRows .session-row")].map((r) => ({
    day: Number(r.querySelector(".s-day").value), start: r.querySelector(".s-start").value, end: r.querySelector(".s-end").value,
  }));
}

function openSubjectForm(id = null) {
  editingSubjectId = id;
  const s = subjectById(id);
  $("#subjectDialogTitle").textContent = s ? "Edit Subject" : "Add Subject";
  clearErrors($("#subjectForm"));
  $("#sName").value = s ? s.name : "";
  $("#sPlace").value = s ? s.place : "";
  $("#sColor").innerHTML = Object.keys(COLORS).map((c) => `<option>${c}</option>`).join("");
  $("#sColor").value = s ? s.color : "Blue";
  $("#sessionRows").innerHTML = (s ? s.sessions : [{ day: 0, start: "", end: "" }]).map(sessionRowHtml).join("");
  $("#subjectDialog").showModal();
}

function validateSubjectForm(d, id) {
  const errs = {}, rowErrs = [];
  if (d.name.length < 2) errs.sName = "Subject name is required (at least 2 characters).";
  else if (state.subjects.some((s) => s.id !== id && s.name.toLowerCase() === d.name.toLowerCase())) errs.sName = "A subject with this name already exists.";
  if (!d.sessions.length) errs.sessions = "Add at least one class session.";
  d.sessions.forEach((x, i) => {
    if (!x.start || !x.end) rowErrs[i] = "Enter both a start and an end time.";
    else if (toMin(x.end) <= toMin(x.start)) rowErrs[i] = "End time must be later than start time.";
    else if (d.sessions.some((y, j) => j < i && y.day === x.day && y.start === x.start && y.end === x.end)) rowErrs[i] = "Duplicate session.";
  });
  return { errs, rowErrs };
}

function saveSubject(ev) {
  ev.preventDefault();
  clearErrors($("#subjectForm"));
  const d = { name: $("#sName").value.trim().replace(/\s+/g, " "), place: $("#sPlace").value.trim(), color: $("#sColor").value, sessions: readSessions() };
  const { errs, rowErrs } = validateSubjectForm(d, editingSubjectId);
  const rows = document.querySelectorAll("#sessionRows .session-row");
  rowErrs.forEach((msg, i) => { if (msg) rows[i].querySelector(".row-err").textContent = msg; });
  if (Object.keys(errs).length || rowErrs.some(Boolean)) { showErrors(errs); return; }
  let id = editingSubjectId;
  if (id) Object.assign(subjectById(id), d);
  else { id = uid(); state.subjects.push({ id, ...d }); }
  $("#subjectDialog").close();
  commit();
  const clash = [...findOverlaps().keys].some((k) => k.startsWith(id + ":"));
  showToast(clash ? "Subject saved. Warning: one of its classes overlaps another class." : "Subject saved.", clash);
}

function deleteSubject(id) {
  const s = subjectById(id);
  if (!s) return;
  const n = state.assignments.filter((a) => a.subjectId === id).length;
  if (!confirm("Delete " + s.name + (n ? " and its " + plural(n, "assignment") : "") + "?")) return;
  withUndo("Subject deleted.", () => {
    state.subjects = state.subjects.filter((x) => x.id !== id);
    state.assignments = state.assignments.filter((a) => a.subjectId !== id);
  });
}

/* Assignments (Feature 3) */
function openAssignmentForm(id = null, subjectId = null) {
  if (!state.subjects.length) {
    showToast("Add a subject first.", true);
    openSubjectForm();
    return;
  }
  editingAssignmentId = id;
  const a = state.assignments.find((x) => x.id === id);
    $("#assignmentDialogTitle").textContent = a ? "Edit Assignment" : "Add Assignment";
  clearErrors($("#assignmentForm"));
  $("#aSubject").innerHTML = '<option value="">Select a subject</option>' +
    state.subjects.map((s) => `<option value="${s.id}">${esc(s.name)}</option>`).join("");
  $("#aSubject").value = a ? a.subjectId : (subjectId || "");
  $("#aTitle").value = a ? a.title : "";
  $("#aType").value = a ? a.type : "Assignment";
  $("#aPriority").value = a ? a.priority : "Medium";
  $("#aDue").value = a ? a.due : "";
  $("#aDue").min = a ? "" : todayStr();
  $("#aNotes").value = a ? a.notes : "";
  $("#assignmentDialog").showModal();
}

function validateAssignmentForm(d, id) {
  const e = {};
  const old = state.assignments.find((a) => a.id === id);
  if (!d.subjectId || !subjectById(d.subjectId)) e.aSubject = "Select a subject.";
  if (d.title.length < 2) e.aTitle = "Title is required (at least 2 characters).";
  if (!d.due) e.aDue = "Select a due date.";
  else if (d.due < todayStr() && (!old || old.due !== d.due)) e.aDue = "Due date cannot be in the past.";
  else if (d.due > "2100-12-31") e.aDue = "Enter a realistic due date.";
  if (!e.aTitle && !e.aSubject && !e.aDue && state.assignments.some((a) => a.id !== id && a.subjectId === d.subjectId && a.due === d.due && a.title.toLowerCase() === d.title.toLowerCase())) {
    e.aTitle = "This assignment already exists for that subject and date.";
  }
  return e;
      }


function saveAssignment(ev) {
  ev.preventDefault();
  clearErrors($("#assignmentForm"));
  const d = {
    subjectId: $("#aSubject").value, title: $("#aTitle").value.trim().replace(/\s+/g, " "), type: $("#aType").value,
    priority: $("#aPriority").value, due: $("#aDue").value, notes: $("#aNotes").value.trim(),
  };
  const errs = validateAssignmentForm(d, editingAssignmentId);
  if (Object.keys(errs).length) { showErrors(errs); return; }
  if (editingAssignmentId) {
    Object.assign(state.assignments.find((a) => a.id === editingAssignmentId), d);
    showToast("Assignment updated.");
  } else {
    state.assignments.push({ id: uid(), ...d, done: false });
    showToast("Assignment added.");
  }
  $("#assignmentDialog").close();
  commit();
}

function toggleDone(id, checked) {   // Feature 4
  const a = state.assignments.find((x) => x.id === id);
  if (!a) return;
  a.done = checked;
  commit();
}
function deleteAssignment(id) {
  withUndo("Assignment deleted.", () => { state.assignments = state.assignments.filter((a) => a.id !== id); });
}
function updateDueSoonDays() {
  state.settings.dueSoonDays = Number($("#dueSoonDays").value);
  commit();
}

/* ---------- 5. BACKUP TOOLS (Feature 8) ---------- */
function exportData() {
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "deadlinedock-backup-" + todayStr() + ".json";
  a.click();
  URL.revokeObjectURL(a.href);
  try { localStorage.setItem(BACKUP_KEY, new Date().toISOString()); } catch (e) { /* ignore */ }
  updateBackupNote();
  showToast("Backup downloaded.");
}

function importData(ev) {
  const file = ev.target.files[0];
  ev.target.value = "";
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const data = JSON.parse(reader.result);
      if (!isValidState(data)) throw new Error("bad format");
      if (!confirm("Importing will replace all current records. Continue?")) return;
      state = normalizeState(data);
      commit();
      showToast("Data imported.");
    } catch (err) {
      showToast("Import failed: not a valid DeadlineDock backup file.", true);
    }
  };
  reader.onerror = () => showToast("Could not read that file.", true);
  reader.readAsText(file);
}

function clearAll() {
  if (!confirm("This will delete all subjects and assignments. Continue?")) return;
  withUndo("All data cleared.", () => { state = { subjects: [], assignments: [], settings: { dueSoonDays: state.settings.dueSoonDays } }; });
}
 
function loadSampleData() {
  if (state.subjects.length && !confirm("Replace your current records with sample data?")) return;
  const ids = [uid(), uid(), uid(), uid()];
  const sub = (id, name, place, color, sessions) => ({ id, name, place, color, sessions: sessions.map(([day, start, end]) => ({ day, start, end })) });
  const asg = (i, title, type, priority, due, done = false, notes = "") => ({ id: uid(), subjectId: ids[i], title, type, priority, due, notes, done });
  state = {
    settings: { dueSoonDays: 3 },
    subjects: [
      
sub(ids[0], "Event-Driven Programming", "Computer Lab 2", "Blue", [[0, "08:00", "10:00"], [3, "08:00", "10:00"]]),
      sub(ids[1], "Data Structures", "Room 204", "Green", [[1, "09:00", "11:00"], [4, "09:00", "11:00"]]),
      sub(ids[2], "Web Systems", "Room 305", "Purple", [[0, "09:30", "11:00"], [2, "13:00", "15:00"]]),   // overlaps Monday class
      sub(ids[3], "Ethics in IT", "Room 101", "Orange", [[2, "10:00", "11:30"]]),
    ],
    assignments: [
      asg(0, "Final project proposal", "Project", "High", addDays(0), false, "Submit the PDF"),
      asg(0, "Prototype demo", "Project", "High", addDays(10)),
      asg(1, "Linked list exercise", "Assignment", "Medium", addDays(-2)),
      asg(1, "Quiz 2: Stacks and queues", "Quiz", "Medium", addDays(2)),
      asg(2, "Wireframe submission", "Assignment", "Low", addDays(5)),
      asg(3, "Reflection paper", "Assignment", "Low", addDays(-5), true),
      asg(3, "Midterm exam", "Exam", "High", addDays(14)),
    ],

    };
  commit();
  showToast("Sample data loaded.");
}
 
/* ---------- 6. EVENT LISTENERS ---------- */
function init() {
  loadData();
  render();

// Click events (buttons)
  document.querySelectorAll(".tab").forEach((b) => b.addEventListener("click", () => showView(b.dataset.view)));
  $("#btnAddSubject").addEventListener("click", () => openSubjectForm());
  $("#btnAddAssignment").addEventListener("click", () => openAssignmentForm());
  $("#btnAddSession").addEventListener("click", addSession);
  $("#btnExport").addEventListener("click", exportData);
  $("#btnImport").addEventListener("click", () => $("#importFile").click());
  $("#btnSample").addEventListener("click", loadSampleData);
  $("#btnClear").addEventListener("click", clearAll);
  document.querySelectorAll("[data-close]").forEach((b) => b.addEventListener("click", () => b.closest("dialog").close()));

// Event delegation for buttons and checkboxes created dynamically
  document.addEventListener("click", (ev) => {
    const btn = ev.target.closest("button[data-action]");
    if (!btn) return;
    const { action, id } = btn.dataset;
    if (action === "editSubject") openSubjectForm(id);
    else if (action === "deleteSubject") deleteSubject(id);
    else if (action === "editAssignment") openAssignmentForm(id);
    else if (action === "deleteAssignment") deleteAssignment(id);
    else if (action === "removeSession") btn.closest(".session-row").remove();
  });
  document.addEventListener("change", (ev) => {
    if (ev.target.matches('input[data-action="toggle"]')) toggleDone(ev.target.dataset.id, ev.target.checked);
  });

  // Submit events (forms)
  $("#subjectForm").addEventListener("submit", saveSubject);
  $("#assignmentForm").addEventListener("submit", saveAssignment);
 
  // Input / change events (search, filters, settings)
  $("#searchInput").addEventListener("input", renderAssignments);
  ["#subjectFilter", "#statusFilter", "#typeFilter", "#priorityFilter", "#sortBy"].forEach((s) => $(s).addEventListener("change", renderAssignments));
  $("#dueSoonDays").addEventListener("change", updateDueSoonDays);
  $("#importFile").addEventListener("change", importData);
 
  // Keep flags and "Now" labels current while the page stays open
  document.addEventListener("visibilitychange", () => { if (!document.hidden) render(); });
  setInterval(render, 60000);
}
 
document.addEventListener("DOMContentLoaded", init);
