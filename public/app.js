const LAST_LOGIN_USER_KEY = "loman-last-login-user-id";
const STATE_LABELS = { machine: "Na stroji", stocked: "Naskladnené", ready: "Pripravené" };
const KANBAN_COLS = [
  { key: "machine", label: "Na stroji" },
  { key: "stocked", label: "Naskladnené" },
  { key: "ready",   label: "Pripravené" },
  { key: "shipped", label: "Expedované dnes" },
];
const ORDER_FILTERS = [
  { id: "all",     label: "Všetky" },
  { id: "machine", label: "Na stroji" },
  { id: "stocked", label: "Naskladnené" },
  { id: "ready",   label: "Pripravené" },
  { id: "overdue", label: "Meškajúce" },
];

// ── Inline SVG icons ──────────────────────────────────────────────
function svg(size, d, sw = 2.5) {
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${sw}"><path stroke-linecap="round" stroke-linejoin="round" d="${d}"/></svg>`;
}
  // Remove unused SVGs.
const IC_PIN  = "";
const IC_CAL  = "";
const IC_USER = "";
const IC_CHECK = svg(9, 'M4.5 12.75l6 6 9-13.5', 4);

// ── State ─────────────────────────────────────────────────────────
let store = { users: [], orders: [], inventory: [], activity: [] };
let ui = {
  activeView: "dashboard",
  orderFilter: "all",
  orderSearch: "",
  inventorySearch: "",
  sessionUserId: "",
  selectedLoginUserId: localStorage.getItem(LAST_LOGIN_USER_KEY) || "",
  loading: true,
  loginMessage: "",
  batchSelected: new Set(),
  dashboardFilter: "all",
  pendingShipId: null,
  modalEditMode: false,
  pendingDeleteId: null,
  kanbanZone: null,
  editingUserId: null,
  invLogOpen: null,
  statsTab: "overview",
};

// ── Offline queue ─────────────────────────────────────────────────
let syncQueue  = [];
let isOnline   = navigator.onLine;
let sseSource  = null;
let sseWasConnected = false;
let pendingShipTimer = null;
class QueuedMutationError extends Error {
  constructor() {
    super("queued");
    this.name = "QueuedMutationError";
    this.queued = true;
  }
}

// ── DOM refs ──────────────────────────────────────────────────────
const $ = id => document.getElementById(id);
const TOPBAR_COLORS = ["#2563EB","#16A34A","#D97706","#7C3AED","#0891B2","#DC2626","#db2777","#059669"];
const metricsEl         = $("metrics");
const sidebarStatsEl    = document.querySelector(".sidebar-stats");
const kanbanEl          = $("kanban");
const ordersListEl      = $("ordersList");
const inventoryListEl   = $("inventoryList");
const installButton     = $("installButton");
const iosHint           = $("iosHint");
const roleBadge         = $("roleBadge");
const currentUserNameEl = $("currentUserName");
const heroText          = $("heroText");
const orderSearchInput  = $("orderSearch");
const inventorySearchInput = $("inventorySearch");
const orderFiltersEl    = $("orderFilters");
const quickOrderForm    = $("quickOrderForm");
const exportCsvBtn      = $("exportCsvBtn");
const orderAssigneeSelect = $("orderAssigneeSelect");
const logoutButton      = $("logoutButton");
const loginOverlay      = $("loginOverlay");
const loginUsersEl      = $("loginUsers");
const loginForm         = $("loginForm");
const pinInput          = $("pinInput");
const loginMessageEl    = $("loginMessage");
const refreshBtn        = $("refreshBtn");
const toastEl           = $("toastEl");
const offlineBar        = $("offlineBar");
const queueCountEl      = $("queueCount");
const batchBar          = $("batchBar");
const batchLabel        = $("batchLabel");
const batchClearBtn     = $("batchClear");
const batchShipBtn      = $("batchShip");
const batchAdvanceBtn   = $("batchAdvance");
const orderModal        = $("orderModal");
const modalClose        = $("modalClose");

boot();

async function boot() {
  bindEvents();
  bindOfflineEvents();
  registerServiceWorker();
  handlePlatformHints();
  syncOfflineUi();
  await refreshStore();
  syncRealtimeConnection();
}

// ── SSE ───────────────────────────────────────────────────────────
function connectSSE() {
  if (sseSource) sseSource.close();
  sseSource = new EventSource("/api/events");

  sseSource.onopen = () => {
    if (sseWasConnected) {
      // reconnected after drop — fetch fresh state
      refreshStore();
    }
    sseWasConnected = true;
  };

  sseSource.onmessage = e => {
    try {
      const msg = JSON.parse(e.data);
      if (msg.type === "store") {
        // only update if this isn't our own change (avoid flash)
        applyStore(msg.store);
        renderAll();
      }
    } catch {}
  };

  sseSource.onerror = () => {
    // EventSource auto-reconnects; onopen will fire again
  };
}

function syncRealtimeConnection() {
  if (!ui.sessionUserId) {
    if (sseSource) sseSource.close();
    sseSource = null;
    sseWasConnected = false;
    return;
  }
  connectSSE();
}

// ── Offline ───────────────────────────────────────────────────────
function bindOfflineEvents() {
  window.addEventListener("offline", () => {
    isOnline = false;
    syncOfflineUi();
  });

  window.addEventListener("online", async () => {
    isOnline = true;
    syncOfflineUi();
    if (syncQueue.length) {
      showToast(`Obnova spojenia — odosielam ${syncQueue.length} zmien...`, "info");
      await flushQueue();
    }
  });
}

function syncOfflineUi() {
  document.body.classList.toggle("offline", !isOnline);
  renderQueueCount();
}

async function flushQueue() {
  while (syncQueue.length) {
    const { url, opts } = syncQueue.shift();
    try {
      await mutate(url, opts, true);
    } catch {
      // skip failed queued items
    }
    renderQueueCount();
  }
  renderAll();
  showToast("Všetky zmeny synchronizované.", "success");
}

function renderQueueCount() {
  if (!queueCountEl) return;
  queueCountEl.textContent = syncQueue.length ? `${syncQueue.length} v poradí` : "";
  queueCountEl.classList.toggle("hidden", !syncQueue.length);
}

// ── Events ────────────────────────────────────────────────────────
function bindEvents() {
  // Navigation (sidebar + bottom nav share class)
  document.querySelectorAll(".nav-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      ui.activeView = btn.dataset.target;
      ui.batchSelected.clear();
      renderNavigation();
      renderViews();
      renderBatchBar();
      if (ui.activeView === "archive") renderArchive();
      // Scroll to top on view change
      const mc = document.querySelector(".main-content");
      if (mc) mc.scrollTop = 0;
      window.scrollTo({ top: 0, behavior: "instant" });
    });
  });

  installButton.addEventListener("click", async () => {
    if (!deferredPrompt) return;
    deferredPrompt.prompt();
    await deferredPrompt.userChoice;
    deferredPrompt = null;
    installButton.classList.add("hidden");
  });

  window.addEventListener("beforeinstallprompt", e => {
    e.preventDefault(); deferredPrompt = e;
    installButton.classList.remove("hidden");
  });
  window.addEventListener("appinstalled", () => installButton.classList.add("hidden"));

  // User menu dropdown
  const userMenuBtn  = $("userMenuBtn");
  const userDropdown = $("userDropdown");

  userMenuBtn?.addEventListener("click", e => {
    e.stopPropagation();
    userDropdown?.classList.toggle("hidden");
  });
  document.addEventListener("click", () => userDropdown?.classList.add("hidden"));

  logoutButton.addEventListener("click", async () => {
    try { await requestJson("/api/logout", { method: "POST" }, { allow401: true }); } catch {}
    clearSessionState();
    userDropdown?.classList.add("hidden");
    renderAll();
    showToast("Odhlásený.", "info");
  });

  loginUsersEl.addEventListener("click", e => {
    const btn = e.target.closest("[data-user-id]");
    if (!btn) return;
    ui.selectedLoginUserId = btn.dataset.userId;
    localStorage.setItem(LAST_LOGIN_USER_KEY, ui.selectedLoginUserId);
    ui.loginMessage = "";
    renderLogin();
    pinInput.focus();
  });

  loginForm.addEventListener("submit", async e => {
    e.preventDefault();
    if (!ui.selectedLoginUserId) { ui.loginMessage = "Najprv vyber používateľa."; renderLogin(); return; }
    const pin = pinInput.value.trim();
    try {
      const payload = await requestJson("/api/login", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId: ui.selectedLoginUserId, pin }),
      });
      setSessionUser(payload.user?.id || "");
      ui.loginMessage = "";
      pinInput.value = "";
      applyStore(payload.store);
      syncRealtimeConnection();
      ui.activeView = "dashboard";
      renderAll();
      showToast(`Vitaj, ${payload.user.name}!`, "success");
    } catch (err) { ui.loginMessage = err.message; renderLogin(); }
  });

  orderSearchInput.addEventListener("input", e => { ui.orderSearch = e.target.value.trim().toLowerCase(); renderOrders(); });
  inventorySearchInput.addEventListener("input", e => { ui.inventorySearch = e.target.value.trim().toLowerCase(); renderInventory(); });

  orderFiltersEl.addEventListener("click", e => {
    const btn = e.target.closest("[data-filter]");
    if (!btn) return;
    ui.orderFilter = btn.dataset.filter;
    renderOrderFilters(); renderOrders();
  });

  // Order actions (event delegation on whole document for kanban + list)
  document.addEventListener("click", e => {
    // Action buttons
    const actionBtn = e.target.closest("[data-action]");
    if (actionBtn && !actionBtn.disabled) { e.stopPropagation(); handleOrderAction(actionBtn); return; }

    // Checkbox toggle
    const checkbox = e.target.closest("[data-check]");
    if (checkbox) { e.stopPropagation(); toggleBatchSelect(checkbox.dataset.check); return; }

    // Open modal (click on card body, not button/checkbox)
    const card = e.target.closest(".order-card[data-order-id], .order-row[data-order-id]");
    if (card && !e.target.closest("button, [data-check]")) openOrderModal(card.dataset.orderId);
  });

  quickOrderForm.addEventListener("submit", async e => {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    try {
      await mutate("/api/orders", { method: "POST", body: JSON.stringify({
        customer: String(fd.get("customer")), item: String(fd.get("item")),
        qty: Number(fd.get("qty")), location: String(fd.get("location")), shipDate: String(fd.get("shipDate")),
        assigneeId: String(fd.get("assigneeId") || ""),
      })});
      e.currentTarget.reset(); renderAll();
      showToast("Objednávka vytvorená.", "success");
    } catch (err) { handleMutationError(err); }
  });

  refreshBtn.addEventListener("click", () => {
    refreshBtn.classList.add("spinning");
    refreshStore().finally(() => refreshBtn.classList.remove("spinning"));
  });

  // Batch bar
  batchClearBtn.addEventListener("click", () => { ui.batchSelected.clear(); renderBatchBar(); renderKanban(); renderOrders(); });
  batchShipBtn.addEventListener("click", handleBatchShip);
  batchAdvanceBtn.addEventListener("click", handleBatchAdvance);

  // Zone filter
  const zf = $("zoneFilter");
  if (zf) zf.addEventListener("click", e => {
    const btn = e.target.closest("[data-zone]");
    if (!btn) return;
    ui.kanbanZone = btn.dataset.zone || null;
    renderZoneFilter();
    renderKanban();
  });

  // Modal close
  modalClose.addEventListener("click", closeOrderModal);
  orderModal.addEventListener("click", e => { if (e.target === orderModal) closeOrderModal(); });
  document.addEventListener("keydown", e => { if (e.key === "Escape") closeOrderModal(); });

  // Dashboard filter toggle
  const dashToggle = $("dashFilterToggle");
  if (dashToggle) {
    dashToggle.addEventListener("click", e => {
      const btn = e.target.closest("[data-dash-filter]");
      if (!btn) return;
      ui.dashboardFilter = btn.dataset.dashFilter;
      dashToggle.querySelectorAll(".toggle-btn").forEach(b =>
        b.classList.toggle("active", b.dataset.dashFilter === ui.dashboardFilter)
      );
      renderKanban();
    });
  }

  // Export CSV
  if (exportCsvBtn) exportCsvBtn.addEventListener("click", () => { exportOrdersCSV(); showToast("CSV stiahnutý.", "success"); });

  // Archive filters — default to current month
  const archiveMonth    = $("archiveMonth");
  const archiveCustomer = $("archiveCustomer");
  if (archiveMonth) archiveMonth.value = new Date().toISOString().slice(0, 7);
  if (archiveMonth)    archiveMonth.addEventListener("change", renderArchive);
  if (archiveCustomer) archiveCustomer.addEventListener("input", renderArchive);
}

async function handleOrderAction(btn) {
  const { orderId, action } = btn.dataset;

  function refreshModal() {
    const openId = orderModal.dataset.openId;
    if (openId) openOrderModal(openId);
  }

  try {
    if (action === "advance") {
      await mutate(`/api/orders/${orderId}/advance`, { method: "PATCH" });
      showToast(`${orderId} posunutá.`, "success");

    } else if (action === "ship") {
      if (btn.dataset.inline) {
        // Inline button on kanban row — confirm directly on the button itself
        if (ui.pendingShipId === orderId) {
          // Second tap = confirm
          ui.pendingShipId = null;
          clearTimeout(pendingShipTimer);
          await mutate(`/api/orders/${orderId}/expedition`, { method: "PATCH" });
          showToast(`${orderId} expedovaná.`, "success");
        } else {
          // First tap = ask on button
          ui.pendingShipId = orderId;
          clearTimeout(pendingShipTimer);
          pendingShipTimer = setTimeout(() => {
            if (ui.pendingShipId === orderId) { ui.pendingShipId = null; renderKanban(); renderUrgentSection(); }
          }, 4000);
          renderKanban();
          renderUrgentSection();
          return;
        }
      } else {
        // Modal flow — original 2-step
        ui.pendingShipId = orderId;
        clearTimeout(pendingShipTimer);
        pendingShipTimer = setTimeout(() => {
          if (ui.pendingShipId === orderId) { ui.pendingShipId = null; renderAll(); refreshModal(); }
        }, 5000);
        renderAll();
        refreshModal();
        return;
      }

    } else if (action === "ship-confirm") {
      ui.pendingShipId = null;
      clearTimeout(pendingShipTimer);
      await mutate(`/api/orders/${orderId}/expedition`, { method: "PATCH" });
      showToast(`${orderId} expedovaná.`, "success");

    } else if (action === "ship-cancel") {
      ui.pendingShipId = null;
      clearTimeout(pendingShipTimer);
      renderAll();
      refreshModal();
      return;

    } else if (action === "unship") {
      await mutate(`/api/orders/${orderId}/expedition`, { method: "PATCH" });
      showToast(`${orderId} vrátená späť.`, "info");

    } else if (action === "edit-start") {
      ui.modalEditMode = true;
      refreshModal();
      return;

    } else if (action === "edit-cancel") {
      ui.modalEditMode = false;
      refreshModal();
      return;

    } else if (action === "edit-save") {
      const form = $("modalEditForm");
      if (!form || !form.checkValidity()) { form?.reportValidity(); return; }
      const fd = new FormData(form);
      await mutate(`/api/orders/${orderId}`, { method: "PATCH", body: JSON.stringify({
        customer: fd.get("customer"), item: fd.get("item"),
        qty: Number(fd.get("qty")), location: fd.get("location"), shipDate: fd.get("shipDate"),
      })});
      ui.modalEditMode = false;
      showToast(`${orderId} aktualizovaná.`, "success");

    } else if (action === "delete-start") {
      ui.pendingDeleteId = orderId;
      refreshModal();
      return;

    } else if (action === "delete-cancel") {
      ui.pendingDeleteId = null;
      refreshModal();
      return;

    } else if (action === "delete-confirm") {
      ui.pendingDeleteId = null;
      await mutate(`/api/orders/${orderId}`, { method: "DELETE" });
      closeOrderModal();
      showToast(`${orderId} zmazaná.`, "info");
      return;

    } else if (action === "print-slip") {
      printOrderSlip(orderId);
      return;
    }

    renderAll();
    refreshModal();
  } catch (err) { handleMutationError(err); }
}

async function handleBatchShip() {
  const ids = [...ui.batchSelected];
  if (!ids.length) return;
  try {
    const payload = await mutate("/api/orders/batch-ship", {
      method: "POST", body: JSON.stringify({ orderIds: ids }),
    });
    ui.batchSelected.clear();
    renderAll();
    showToast(`${payload.count} objednávok expedovaných.`, "success");
  } catch (err) { handleMutationError(err); }
}

// ── Data ──────────────────────────────────────────────────────────
let deferredPrompt = null;

async function refreshStore() {
  ui.loading = true;
  try {
    const payload = await requestJson("/api/bootstrap");
    setSessionUser(payload.user?.id || "");
    applyStore(payload.store);
    syncRealtimeConnection();
    ui.loading = false;
    renderAll();
  } catch {
    ui.loading = false;
    showToast("Backend nie je dostupný.", "error");
  }
}

async function mutate(url, opts, isQueued = false) {
  if (!isOnline && !isQueued) {
    syncQueue.push({ url, opts });
    renderQueueCount();
    showToast("Offline — zmena zaznamenaná.", "warn");
    throw new QueuedMutationError();
  }
  const payload = await requestJson(url, {
    ...opts,
    headers: { "Content-Type": "application/json", ...(opts?.headers || {}) },
  });
  applyStore(payload.store);
  return payload;
}

function isQueuedError(err) {
  return Boolean(err?.queued || err?.name === "QueuedMutationError" || err?.message === "queued");
}

function handleMutationError(err) {
  if (isQueuedError(err)) return;
  showToast(err.message, "error");
}

function applyStore(next) {
  invLogCache = {};
  store = next;
  if (!store.users.some(u => u.id === ui.selectedLoginUserId) && store.users.length > 0) {
    ui.selectedLoginUserId = store.users[0].id;
    localStorage.setItem(LAST_LOGIN_USER_KEY, ui.selectedLoginUserId);
  }
  // remove batch-selected orders that no longer exist or are shipped
  for (const id of ui.batchSelected) {
    const order = store.orders.find(o => o.id === id);
    if (!order || order.expeditionDone) ui.batchSelected.delete(id);
  }
}

// ── Render orchestration ──────────────────────────────────────────
function renderAll() {
  renderLogin();
  renderHeader();
  renderRoleUi();
  renderNavigation();
  renderViews();
  renderMetrics();
  renderShiftNote();
  renderKanban();
  renderOrderFilters();
  renderOrders();
  renderInventory();
  renderStats();
  renderArchive();
  renderNavBadges();
  renderHeroText();
  renderBatchBar();
  renderUrgentSection();
}

const AVATAR_COLORS = ["#2563EB","#16A34A","#D97706","#7C3AED","#0891B2","#DC2626","#db2777","#059669"];
let invLogCache = {};
let shiftNoteEditing = false;

// ── Shift note ────────────────────────────────────────────────────
function renderShiftNote() {
  const el = $("shiftNoteBar");
  if (!el) return;
  const note = store.shiftNote || {};
  const hasText = Boolean(note.text);
  el.className = `shift-note-bar${hasText ? "" : " empty"}`;

  const noteIcon = `<svg class="shift-note-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M16.862 4.487l1.687-1.688a1.875 1.875 0 1 1 2.652 2.652L10.582 16.07a4.5 4.5 0 0 1-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 0 1 1.13-1.897l8.932-8.931zm0 0L19.5 7.125"/></svg>`;
  const editBtn = `<button class="shift-note-edit" id="shiftNoteEditBtn" title="Upraviť poznámku">${noteIcon}</button>`;

  if (shiftNoteEditing) {
    el.innerHTML = `
      ${noteIcon}
      <div class="shift-note-content">
        <div class="shift-note-form">
          <textarea id="shiftNoteInput" placeholder="Napíš poznámku k smene pre celý tím..." rows="2">${escapeHtml(note.text || "")}</textarea>
          <div class="shift-note-actions">
            <button class="btn-primary btn-sm" id="shiftNoteSave">Uložiť</button>
            <button class="btn-ghost btn-sm" id="shiftNoteCancel">Zrušiť</button>
          </div>
        </div>
      </div>`;
    $("shiftNoteSave")?.addEventListener("click", async () => {
      const text = $("shiftNoteInput")?.value || "";
      try {
        await mutate("/api/shift-note", { method: "PATCH", body: JSON.stringify({ text }) });
        shiftNoteEditing = false;
        showToast("Poznámka uložená.", "success");
      } catch (err) { handleMutationError(err); }
    });
    $("shiftNoteCancel")?.addEventListener("click", () => { shiftNoteEditing = false; renderShiftNote(); });
    $("shiftNoteInput")?.focus();
    return;
  }

  el.innerHTML = `
    ${noteIcon}
    <div class="shift-note-content">
      <div class="shift-note-text">${hasText ? escapeHtml(note.text) : "Žiadna poznámka k smene"}</div>
      ${hasText && note.updatedAt ? `<div class="shift-note-meta">${userName(note.userId)} · ${formatDateTime(note.updatedAt)}</div>` : ""}
    </div>
    ${editBtn}`;
  $("shiftNoteEditBtn")?.addEventListener("click", () => { shiftNoteEditing = true; renderShiftNote(); });
}

// ── Login ─────────────────────────────────────────────────────────
function renderLogin() {
  loginUsersEl.innerHTML = store.users.map((u, i) => {
    const color    = AVATAR_COLORS[i % AVATAR_COLORS.length];
    const initials = u.name.split(" ").map(w => w[0]).slice(0, 2).join("").toUpperCase();
    return `
      <button class="login-avatar-btn ${ui.selectedLoginUserId === u.id ? "active" : ""}" type="button" data-user-id="${u.id}">
        <div class="avatar-circle" style="background:${color}">${initials}</div>
        <span class="avatar-name">${u.name}</span>
        <span class="avatar-role">${u.role === "admin" ? "Admin" : "Skladník"}</span>
      </button>`;
  }).join("");

  const sel = store.users.find(u => u.id === ui.selectedLoginUserId);
  const nameEl = $("loginSelectedName");
  if (nameEl) nameEl.textContent = sel ? `Prihlasuje sa: ${sel.name}` : "Vyber používateľa";

  loginMessageEl.textContent = ui.loginMessage;
  loginOverlay.classList.toggle("hidden", ui.loading || Boolean(ui.sessionUserId));
}

function renderHeader() {
  const user = getCurrentUser();
  if (currentUserNameEl) currentUserNameEl.textContent = user?.name ?? "Neprihlásený";
  const avatarEl = $("userAvatarTopbar");
  if (avatarEl && user) {
    const idx      = store.users.findIndex(u => u.id === user.id);
    const color    = TOPBAR_COLORS[idx % TOPBAR_COLORS.length];
    const initials = user.name.split(" ").map(w => w[0]).slice(0, 2).join("").toUpperCase();
    avatarEl.textContent = initials;
    avatarEl.style.background = color;
    const btn = $("userMenuBtn");
    if (btn) btn.style.background = color;
  }
}

function renderRoleUi() {
  const user = getCurrentUser();
  const admin = user?.role === "admin";
  roleBadge.textContent = admin ? "Admin" : "Skladník";
  roleBadge.classList.toggle("admin", admin);
  quickOrderForm.classList.toggle("hidden", !admin);

  // Worker sees only Dashboard — hide all other nav tabs
  const workerHiddenTargets = ["stats", "orders", "inventory", "archive"];
  workerHiddenTargets.forEach(t => {
    document.querySelectorAll(`[data-target="${t}"]`).forEach(b => b.classList.toggle("hidden", !admin));
  });

  // Export CSV, filter toggle and zone filter hidden for workers
  if (exportCsvBtn) exportCsvBtn.classList.toggle("hidden", !admin);
  const filterToggle = $("dashFilterToggle");
  if (filterToggle) filterToggle.classList.toggle("hidden", !admin);
  const zoneFilter = $("zoneFilter");
  if (zoneFilter) zoneFilter.classList.toggle("hidden", !admin);

  // Workers always see their own orders by default
  if (!admin) ui.dashboardFilter = "mine";

  // Redirect worker if they're on a hidden view
  if (!admin && ["stats", "orders", "inventory", "archive"].includes(ui.activeView)) {
    ui.activeView = "dashboard";
  }

  renderAssigneeSelect();
}

function renderAssigneeSelect() {
  if (!orderAssigneeSelect) return;
  const workers = store.users;
  orderAssigneeSelect.innerHTML = workers.map(u =>
    `<option value="${u.id}">${u.name}${u.role === "admin" ? " (Admin)" : ""}</option>`
  ).join("");
}

function renderNavigation() {
  document.querySelectorAll(".nav-btn").forEach(btn => btn.classList.toggle("active", btn.dataset.target === ui.activeView));
}

function renderViews() {
  document.querySelectorAll(".view").forEach(v => v.classList.toggle("active", v.dataset.view === ui.activeView));
}

function renderNavBadges() {
  const overdue = getDelayedOrders().length;
  const myTasks = getUserOpenOrders().length;
  document.querySelectorAll('[data-badge="dashboard"]').forEach(b => { b.textContent = myTasks || ""; b.classList.toggle("hidden", !myTasks); });
  document.querySelectorAll('[data-badge="orders"]').forEach(b => { b.textContent = overdue || ""; b.classList.toggle("hidden", !overdue); });
}

function renderHeroText() {
  if (!heroText) return;
  const user = getCurrentUser();
  const delayed = getDelayedOrders().length;
  const dateStr = new Date().toLocaleDateString("sk-SK", { weekday: "long", day: "numeric", month: "long" });
  if (!user) { heroText.textContent = dateStr; return; }
  const status = delayed > 0
    ? `${delayed} expedíci${delayed === 1 ? "a mešká" : "e meškajú"}`
    : `${getUserOpenOrders().length} otvorených úloh`;
  heroText.textContent = `${dateStr} · ${status}`;
}

// ── Metrics ───────────────────────────────────────────────────────
const STAT_DEFS = [
  { label: "Dnes",       color: "blue",  get: () => getTodayOrders().length },
  { label: "Meškajú",    color: "red",   get: () => getDelayedOrders().length },
  { label: "Pripravené", color: "green", get: () => store.orders.filter(o => o.state === "ready").length },
  { label: "Moje úlohy", color: "amber", get: () => getUserOpenOrders().length },
];

function buildStatsHTML() {
  return STAT_DEFS.map(s => `
    <div class="stat-item" data-c="${s.color}">
      <strong class="stat-num">${s.get()}</strong>
      <span class="stat-label">${s.label}</span>
    </div>`).join("");
}

function renderMetrics() {
  const html = buildStatsHTML();
  if (metricsEl) metricsEl.innerHTML = html;
  if (sidebarStatsEl) sidebarStatsEl.innerHTML = html;
}

// ── Zone filter ───────────────────────────────────────────────────
function renderZoneFilter() {
  const el = $("zoneFilter");
  if (!el) return;
  const zones = [...new Set(
    store.orders.filter(o => !o.expeditionDone && o.location).map(o => o.location[0].toUpperCase())
  )].sort();
  if (zones.length < 2) { el.innerHTML = ""; return; }
  el.innerHTML = `
    <button class="chip ${!ui.kanbanZone ? "active" : ""}" data-zone="">Všetky zóny</button>
    ${zones.map(z => `<button class="chip ${ui.kanbanZone === z ? "active" : ""}" data-zone="${z}">Zóna ${z}</button>`).join("")}`;
}

// ── Urgent section ────────────────────────────────────────────────
function renderUrgentSection() {
  const el = $("urgentSection");
  if (!el) return;

  let overdue = getDelayedOrders().filter(o => !o.expeditionDone);
  if (ui.dashboardFilter === "mine") {
    const cur = getCurrentUser();
    if (cur) overdue = overdue.filter(o => o.assigneeId === cur.id);
  }
  if (ui.kanbanZone) overdue = overdue.filter(o => o.location?.toUpperCase().startsWith(ui.kanbanZone));
  if (!overdue.length) { el.innerHTML = ""; return; }

  const isWorker = !isAdmin(getCurrentUser());

  const rows = overdue.map(o => {
    const action   = getPrimaryAction(o);
    const msLate   = Date.now() - new Date(o.shipDate).getTime();
    const daysLate = Math.ceil(msLate / 86_400_000);
    const isPendingShip = action?.type === "ship" && ui.pendingShipId === o.id;
    let actionBtn = "";
    if (isWorker && action) {
      const lbl = isPendingShip ? "Potvrdiť?" : action.label;
      const cls = `or-action-btn${action.type === "ship" ? " or-action-ship" : ""}${isPendingShip ? " or-action-confirm" : ""}`;
      actionBtn = `<button class="${cls}" data-action="${action.type}" data-order-id="${o.id}" data-inline="1" type="button">${lbl}</button>`;
    } else if (action) {
      actionBtn = `<button class="${action.cls}" data-action="${action.type}" data-order-id="${o.id}" type="button" style="font-size:.7rem;padding:3px 6px;border-radius:0;border:1px solid var(--blue-m);background:transparent;color:var(--blue-d);">${action.label}</button>`;
    }
    return `
      <article class="urgent-row" data-order-id="${o.id}">
        <div style="flex:1;min-width:0;">
          <span class="or-name">${escapeHtml(o.customer)}</span>
          <span class="or-sub">${escapeHtml(o.item)} · ${escapeHtml(o.location)}</span>
        </div>
        <span class="urgent-days">+${daysLate}d</span>
        ${actionBtn}
      </article>`;
  }).join("");

  el.innerHTML = `
    <div class="urgent-section">
      <div class="urgent-label">
        <span class="urgent-dot"></span>
        Meškajú
        <span class="urgent-count">${overdue.length}</span>
      </div>
      <div class="urgent-rows">${rows}</div>
    </div>`;
}

// ── Kanban ────────────────────────────────────────────────────────

function renderKanban() {
  if (!kanbanEl) return;
  renderZoneFilter();
  const today = toDateOnly(new Date().toISOString());

  kanbanEl.innerHTML = KANBAN_COLS.map(col => {
    let items;
    if (col.key === "shipped") {
      items = store.orders.filter(o => o.expeditionDone && toDateOnly(o.updatedAt || o.shipDate) === today);
    } else {
      items = store.orders.filter(o => !o.expeditionDone && o.state === col.key);
    }
    if (ui.dashboardFilter === "mine") {
      const cur = getCurrentUser();
      if (cur) items = items.filter(o => o.assigneeId === cur.id);
    }
    if (ui.kanbanZone) items = items.filter(o => o.location?.toUpperCase().startsWith(ui.kanbanZone));
    items.sort((a, b) => {
      const od = Number(isDelayed(b)) - Number(isDelayed(a));
      return od !== 0 ? od : new Date(a.shipDate) - new Date(b.shipDate);
    });

    const cards = items.length
      ? `<div class="order-rows">${items.map(o => renderOrderCard(o, { compact: true })).join("")}</div>`
      : `<div class="empty">Žiadne</div>`;

    return `
      <div class="kanban-col" data-col="${col.key}">
        <div class="kanban-col-head">
          <span class="col-head-label">${col.label}</span>
          <span class="col-count">${items.length}</span>
        </div>
        <div class="kanban-col-body">${cards}</div>
      </div>`;
  }).join("");
}

// ── Orders list ───────────────────────────────────────────────────
function renderOrderFilters() {
  orderFiltersEl.innerHTML = ORDER_FILTERS.map(f =>
    `<button class="chip ${ui.orderFilter === f.id ? "active" : ""}" type="button" data-filter="${f.id}">${f.label}</button>`
  ).join("");
}

function renderOrders() {
  const orders = getSortedOrders().filter(o => {
    const s = `${o.id} ${o.customer} ${o.item} ${o.location}`.toLowerCase();
    return (!ui.orderSearch || s.includes(ui.orderSearch)) &&
      (ui.orderFilter === "all" || o.state === ui.orderFilter || (ui.orderFilter === "overdue" && isDelayed(o)));
  });
  ordersListEl.innerHTML = orders.length
    ? orders.map(o => renderOrderCard(o, { compact: false })).join("")
    : `<div class="empty">Žiadne objednávky pre tento filter.</div>`;
}

// ── Inventory ─────────────────────────────────────────────────────
let invEditingSku = null;

function renderInventory() {
  const admin = getCurrentUser()?.role === "admin";

  // Toggle add form button
  const addToggle = $("invAddToggle");
  const addForm   = $("invAddForm");
  if (addToggle) addToggle.classList.toggle("hidden", !admin);

  // Bind add-form toggle
  if (addToggle && !addToggle._bound) {
    addToggle._bound = true;
    addToggle.addEventListener("click", () => {
      addForm?.classList.toggle("hidden");
    });
  }

  // Bind add-form submit
  if (addForm && !addForm._bound) {
    addForm._bound = true;
    addForm.addEventListener("submit", async e => {
      e.preventDefault();
      const fd = new FormData(e.currentTarget);
      try {
        await mutate("/api/inventory", { method: "POST", body: JSON.stringify({
          name: String(fd.get("name")), sku: String(fd.get("sku")),
          location: String(fd.get("location")), qty: Number(fd.get("qty")),
        })});
        e.currentTarget.reset();
        addForm.classList.add("hidden");
        showToast("Položka pridaná.", "success");
      } catch (err) { handleMutationError(err); }
    });
  }

  const items = store.inventory.filter(it => {
    const s = `${it.sku} ${it.name} ${it.location}`.toLowerCase();
    return !ui.inventorySearch || s.includes(ui.inventorySearch);
  });

  inventoryListEl.innerHTML = items.length
    ? items.map(it => {
        const editing = invEditingSku === it.sku;
        if (editing) {
          return `
            <article class="inventory-card">
              <form class="inv-edit-form" data-sku="${it.sku}" style="display:grid;gap:7px;">
                <div style="display:grid;grid-template-columns:1fr 1fr;gap:7px;">
                  <input name="name"     type="text"   value="${escapeHtml(it.name)}"     placeholder="Názov" required style="font-size:.82rem;" />
                  <input name="location" type="text"   value="${escapeHtml(it.location)}" placeholder="Pozícia" required style="font-size:.82rem;" />
                </div>
                <div style="display:flex;gap:7px;align-items:center;">
                  <input name="qty" type="number" min="0" value="${it.qty}" style="font-size:.82rem;width:90px;" />
                  <button class="btn-primary btn-sm" type="submit">Uložiť</button>
                  <button class="btn-ghost btn-sm" type="button" data-inv-cancel="${it.sku}">Zrušiť</button>
                  <button class="btn-ghost btn-delete-ghost btn-sm" type="button" data-inv-delete="${it.sku}" style="margin-left:auto;">Zmazať</button>
                </div>
              </form>
            </article>`;
        }
        const log = invLogCache[it.sku] || [];
        const logOpen = ui.invLogOpen === it.sku;
        return `
          <article class="inventory-card">
            <div class="inv-head">
              <div><strong>${it.name}</strong><p class="inv-sku">${it.sku}</p></div>
              <div style="display:flex;align-items:center;gap:6px;">
                <span class="badge stocked">${it.qty} ks</span>
                ${admin ? `<button class="btn-ghost btn-sm" data-inv-edit="${it.sku}">Upraviť</button>` : ""}
              </div>
            </div>
            <div class="inv-meta">
              <span class="pill">${IC_PIN}${it.location}</span>
              <span class="pill">${IC_CAL}${formatDateTime(it.updatedAt)}</span>
              <button class="btn-ghost btn-sm" data-inv-log="${it.sku}" style="margin-left:auto;">
                ${logOpen ? "Skryť" : "História"}
              </button>
            </div>
            <div class="inv-log${logOpen ? " visible" : ""}" id="invlog-${it.sku}">
              ${log.length ? log.slice(0,15).map(e => `
                <div class="inv-log-row">
                  <span class="inv-log-reason">${e.reason}</span>
                  <span class="inv-log-delta ${e.delta > 0 ? "pos" : "neg"}">${e.delta > 0 ? "+" : ""}${e.delta} ks</span>
                  <span class="inv-log-meta">${userName(e.actorId)} · ${formatDateTime(e.at)}</span>
                </div>`).join("") : '<p class="muted" style="font-size:.78rem;padding:4px 0;">Žiadna história.</p>'}
            </div>
          </article>`;
      }).join("")
    : `<div class="empty">Nič sa nenašlo.</div>`;

  // Bind inventory action buttons
  inventoryListEl.querySelectorAll("[data-inv-log]").forEach(btn => {
    btn.addEventListener("click", async () => {
      const sku = btn.dataset.invLog;
      if (ui.invLogOpen === sku) { ui.invLogOpen = null; renderInventory(); return; }
      ui.invLogOpen = sku;
      if (!invLogCache[sku]) {
        try {
          const data = await requestJson(`/api/inventory-log?sku=${encodeURIComponent(sku)}`);
          invLogCache[sku] = data.log || [];
        } catch { invLogCache[sku] = []; }
      }
      renderInventory();
    });
  });

  inventoryListEl.querySelectorAll("[data-inv-edit]").forEach(btn => {
    btn.addEventListener("click", () => { invEditingSku = btn.dataset.invEdit; renderInventory(); });
  });
  inventoryListEl.querySelectorAll("[data-inv-cancel]").forEach(btn => {
    btn.addEventListener("click", () => { invEditingSku = null; renderInventory(); });
  });
  inventoryListEl.querySelectorAll("[data-inv-delete]").forEach(btn => {
    btn.addEventListener("click", async () => {
      if (!confirm("Zmazať túto položku?")) return;
      try {
        await mutate(`/api/inventory/${btn.dataset.invDelete}`, { method: "DELETE" });
        invEditingSku = null;
        showToast("Položka zmazaná.", "info");
      } catch (err) { handleMutationError(err); }
    });
  });
  inventoryListEl.querySelectorAll(".inv-edit-form").forEach(form => {
    form.addEventListener("submit", async e => {
      e.preventDefault();
      const sku = form.dataset.sku;
      const fd  = new FormData(form);
      try {
        await mutate(`/api/inventory/${sku}`, { method: "PATCH", body: JSON.stringify({
          name: String(fd.get("name")), location: String(fd.get("location")), qty: Number(fd.get("qty")),
        })});
        invEditingSku = null;
        showToast("Položka aktualizovaná.", "success");
      } catch (err) { handleMutationError(err); }
    });
  });
}

// ── Archive ───────────────────────────────────────────────────────
let archiveData = [];

async function renderArchive() {
  const el = $("archiveList");
  if (!el) return;
  if (ui.activeView !== "archive") return;

  const month    = ($("archiveMonth")?.value    || "").trim();
  const customer = ($("archiveCustomer")?.value || "").trim();

  el.innerHTML = `<div class="empty">Načítavam…</div>`;
  try {
    const params = new URLSearchParams();
    if (month)    params.set("month", month);
    if (customer) params.set("customer", customer);
    const data = await requestJson(`/api/archive?${params}`);
    archiveData = data.orders || [];
  } catch { el.innerHTML = `<div class="empty">Chyba načítania.</div>`; return; }

  if (!archiveData.length) {
    el.innerHTML = `<div class="empty">Žiadne expedované objednávky pre tento filter.</div>`;
    return;
  }

  el.innerHTML = archiveData.map(o => `
    <article class="order-card" data-order-id="${o.id}" style="cursor:pointer;">
      <div class="order-head">
        <div style="flex:1;min-width:0;">
          <strong style="color: var(--ink); font-size: 0.95rem;">${o.customer}</strong>
          <p class="order-id" style="margin-top: 2px;">${o.id} · ${o.item}</p>
        </div>
        <span class="badge shipped">Expedované</span>
      </div>
      <div class="order-meta">
        <span class="meta-item">${o.qty} ks</span>
        <span class="meta-item">${o.location}</span>
        <span class="meta-item">${formatDate(o.shipDate)}</span>
        <span class="meta-item">${userName(o.assigneeId)}</span>
      </div>
    </article>`).join("");
}

// ── Stats ─────────────────────────────────────────────────────────
const expandedUsers = new Set();

function renderStats() {
  const el = $("statsContent");
  if (!el) return;

  const isAdminUser = isAdmin(getCurrentUser());
  const tab = ui.statsTab;

  const tabs = [
    { id: "overview", label: "Prehľad" },
    { id: "team",     label: "Tím" },
    { id: "activity", label: "Aktivita" },
    ...(isAdminUser ? [{ id: "settings", label: "Nastavenia" }] : []),
  ];

  const tabNav = `
    <div class="stats-tabs">
      ${tabs.map(t => `<button class="stats-tab-btn${tab === t.id ? " active" : ""}" data-stats-tab="${t.id}" type="button">${t.label}</button>`).join("")}
    </div>`;

  let content = "";

  if (tab === "overview") {
    const totalOrders    = store.orders.length;
    const expeditedToday = store.orders.filter(o => o.expeditionDone && isToday(o.updatedAt || o.shipDate)).length;
    const overdueCount   = getDelayedOrders().length;
    const readyNow       = store.orders.filter(o => o.state === "ready" && !o.expeditionDone).length;
    const machineCount   = store.orders.filter(o => !o.expeditionDone && o.state === "machine").length;
    const stockedCount   = store.orders.filter(o => !o.expeditionDone && o.state === "stocked").length;
    content = `
      <div class="stats-kpi">
        <div class="kpi-item" data-kpi="blue"><strong>${totalOrders}</strong><span>Všetky objednávky</span></div>
        <div class="kpi-item" data-kpi="green"><strong>${expeditedToday}</strong><span>Expedované dnes</span></div>
        <div class="kpi-item" data-kpi="red"><strong>${overdueCount}</strong><span>Meškajú</span></div>
        <div class="kpi-item" data-kpi="amber"><strong>${readyNow}</strong><span>Pripravené</span></div>
      </div>
      <div class="charts-row">
        ${buildDonut([
          { label: "Na stroji",   value: machineCount,   color: "var(--slate)", cls: "machine" },
          { label: "Naskladnené", value: stockedCount,   color: "var(--blue)",  cls: "stocked" },
          { label: "Pripravené",  value: readyNow,       color: "var(--amber)", cls: "ready"   },
          { label: "Expedované",  value: expeditedToday, color: "var(--green)", cls: "shipped" },
        ], totalOrders)}
        <div class="chart-card">
          <p class="chart-title">Aktivita za 7 dní</p>
          <div class="day-bars">${buildDayBars()}</div>
        </div>
      </div>`;

  } else if (tab === "team") {
    content = `<div class="stats-users" id="statsUsers">${buildUserRows()}</div>`;

  } else if (tab === "activity") {
    content = `
      <div class="feed">
        ${store.activity.slice(0, 40).map(e => `
          <div class="feed-row">
            <div>
              <strong>${userName(e.userId)}</strong>
              <p class="muted">${e.message}</p>
            </div>
            <span class="feed-time">${formatDateTime(e.at)}</span>
          </div>`).join("")}
        ${store.activity.length === 0 ? `<div class="empty">Žiadna aktivita.</div>` : ""}
      </div>`;

  } else if (tab === "settings" && isAdminUser) {
    content = buildUserMgmt();
  }

  el.innerHTML = tabNav + content;

  // Bind tab switching
  el.querySelectorAll("[data-stats-tab]").forEach(btn => {
    btn.addEventListener("click", () => {
      ui.statsTab = btn.dataset.statsTab;
      renderStats();
    });
  });

  // Bind user expand (team tab)
  bindUserExpand();

  // Bind user management events (settings tab)
  el.querySelector("#addUserForm")?.addEventListener("submit", async e => {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    try {
      await mutate("/api/users", { method: "POST", body: JSON.stringify({
        name: fd.get("name"), role: fd.get("role"), pin: fd.get("pin"),
      })});
      e.currentTarget.reset();
      showToast("Používateľ pridaný.", "success");
    } catch (err) { showToast(err.message, "error"); }
  });

  el.querySelectorAll("[data-edit-user]").forEach(btn => btn.addEventListener("click", () => {
    ui.editingUserId = ui.editingUserId === btn.dataset.editUser ? null : btn.dataset.editUser;
    renderStats();
  }));

  el.querySelectorAll("[data-save-user]").forEach(btn => btn.addEventListener("click", async () => {
    const uid = btn.dataset.saveUser;
    const row = el.querySelector(`[data-user-row="${uid}"]`);
    if (!row) return;
    const name = row.querySelector("[name=uname]")?.value?.trim();
    const role = row.querySelector("[name=urole]")?.value;
    const pin  = row.querySelector("[name=upin]")?.value?.trim();
    try {
      await mutate(`/api/users/${uid}`, { method: "PATCH", body: JSON.stringify({ name, role, pin: pin || undefined }) });
      ui.editingUserId = null;
      showToast("Používateľ aktualizovaný.", "success");
    } catch (err) { showToast(err.message, "error"); }
  }));

  el.querySelectorAll("[data-delete-user]").forEach(btn => btn.addEventListener("click", async () => {
    if (!confirm(`Zmazať používateľa ${btn.dataset.deleteUser}?`)) return;
    try {
      await mutate(`/api/users/${btn.dataset.deleteUser}`, { method: "DELETE" });
      showToast("Používateľ zmazaný.", "info");
    } catch (err) { showToast(err.message, "error"); }
  }));

}

function bindUserExpand() {
  const el = $("statsContent");
  if (!el) return;
  el.querySelectorAll("[data-user-expand]").forEach(card => {
    card.querySelector(".stat-card-head").addEventListener("click", () => {
      const uid = card.dataset.userExpand;
      expandedUsers.has(uid) ? expandedUsers.delete(uid) : expandedUsers.add(uid);
      const usersEl = $("statsUsers");
      if (usersEl) usersEl.innerHTML = buildUserRows();
      bindUserExpand();
    });
  });
}

function buildUserRows() {
  const maxCount = Math.max(...store.users.map(u => store.activity.filter(e => e.userId === u.id).length), 1);
  return store.users.map(u => {
    const acts = store.activity.filter(e => e.userId === u.id);
    const count      = acts.length;
    const expCount   = acts.filter(e => e.message.includes("expedíciu") || e.message.includes("Expedov")).length;
    const readyCount = acts.filter(e => e.message.includes("Pripravené")).length;
    const stockCount = acts.filter(e => e.message.includes("Naskladnené")).length;
    const pct        = Math.round(count / maxCount * 100);
    const expanded   = expandedUsers.has(u.id);
    const recent     = acts.slice(0, 6);

    return `
      <article class="stat-card stat-card--user ${expanded ? "expanded" : ""}" data-user-expand="${u.id}">
        <div class="stat-card-head" style="cursor:pointer;">
          <div style="display:flex;align-items:center;gap:10px;">
            <div class="user-avatar">${u.name[0]}</div>
            <div>
              <strong style="font-size:.9rem;">${u.name}</strong>
              <div style="margin-top:3px;">
                <span class="role-badge ${u.role === "admin" ? "admin" : ""}">${u.role === "admin" ? "Admin" : "Skladník"}</span>
              </div>
            </div>
          </div>
          <div style="display:flex;align-items:center;gap:8px;">
            <span class="badge machine">${count} úkonov</span>
            <svg class="expand-chevron" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
              <path stroke-linecap="round" stroke-linejoin="round" d="m19.5 8.25-7.5 7.5-7.5-7.5"/>
            </svg>
          </div>
        </div>
        <div class="stat-bar-wrap" style="margin:9px 0 7px;">
          <div class="stat-bar" style="width:${pct}%"></div>
        </div>
        <div class="inv-meta">
          <span class="pill">Expedície: ${expCount}</span>
          <span class="pill">Pripravené: ${readyCount}</span>
          <span class="pill">Naskladnené: ${stockCount}</span>
        </div>
        <div class="stat-detail">
          ${recent.length ? recent.map(e => `
            <div class="stat-act-row">
              <span class="stat-act-msg">${e.message}</span>
              <span class="feed-time">${formatDateTime(e.at)}</span>
            </div>`).join("") : '<p class="muted" style="padding:8px 0;font-size:.78rem;">Žiadna aktivita.</p>'}
        </div>
      </article>`;
  }).join("");
}

function buildUserMgmt() {
  const rows = store.users.map(u => {
    const editing = ui.editingUserId === u.id;
    return `
      <div class="user-mgmt-row ${editing ? "editing" : ""}" data-user-row="${u.id}">
        <div class="user-avatar">${u.name[0]}</div>
        ${editing ? `
          <div class="umr-edit-form">
            <input name="uname" type="text" value="${escapeHtml(u.name)}" placeholder="Meno" style="font-size:.82rem;" />
            <select name="urole" style="font-size:.82rem;">
              <option value="worker" ${u.role === "worker" ? "selected" : ""}>Skladník</option>
              <option value="admin"  ${u.role === "admin"  ? "selected" : ""}>Admin</option>
            </select>
            <input name="upin" type="text" inputmode="numeric" maxlength="12" placeholder="Nový PIN" style="font-size:.82rem;" />
            <button class="btn-primary btn-sm" data-save-user="${u.id}" type="button">Uložiť</button>
            <button class="btn-ghost btn-sm" data-edit-user="${u.id}" type="button">Zrušiť</button>
          </div>
        ` : `
          <div class="umr-info">
            <strong>${u.name}</strong>
            <span class="role-badge ${u.role === "admin" ? "admin" : ""}" style="margin-left:6px;">${u.role === "admin" ? "Admin" : "Skladník"}</span>
          </div>
          <div class="umr-actions">
            <button class="btn-ghost btn-sm" data-edit-user="${u.id}" type="button">Upraviť</button>
            <button class="btn-ghost btn-delete-ghost btn-sm" data-delete-user="${u.id}" type="button">Zmazať</button>
          </div>
        `}
      </div>`;
  }).join("");

  return `
    <p class="stats-section-label">Správa tímu</p>
    <div class="user-mgmt-list">${rows}</div>
    <form id="addUserForm" class="add-user-form">
      <input name="name" type="text" placeholder="Meno" required style="font-size:.82rem;" />
      <select name="role" style="font-size:.82rem;">
        <option value="worker">Skladník</option>
        <option value="admin">Admin</option>
      </select>
      <input name="pin" type="text" inputmode="numeric" maxlength="12" placeholder="PIN" required style="font-size:.82rem;" />
      <button class="btn-primary btn-sm" type="submit">Pridať</button>
    </form>`;
}

function buildDonut(segments, total) {
  const r = 36;
  const circ = 2 * Math.PI * r;
  const activeTotal = segments.reduce((s, seg) => s + seg.value, 0) || 1;
  let offset = 0;

  const circles = segments.filter(s => s.value > 0).map(seg => {
    const dash = (seg.value / activeTotal) * circ;
    const c = `<circle cx="50" cy="50" r="${r}" fill="none"
      stroke="${seg.color}" stroke-width="11"
      stroke-dasharray="${dash.toFixed(2)} ${(circ - dash).toFixed(2)}"
      stroke-dashoffset="${(-offset).toFixed(2)}"
      transform="rotate(-90 50 50)"/>`;
    offset += dash;
    return c;
  }).join("");

  const legend = segments.map(s => `
    <div class="donut-legend-item">
      <span class="badge ${s.cls}" style="font-size:.62rem;">${s.label}</span>
      <strong>${s.value}</strong>
    </div>`).join("");

  return `
    <div class="chart-card">
      <p class="chart-title">Stav objednávok</p>
      <div class="donut-row">
        <div class="donut-wrap">
          <svg viewBox="0 0 100 100" width="110" height="110">
            <circle cx="50" cy="50" r="${r}" fill="none" stroke="var(--line)" stroke-width="11"/>
            ${circles}
          </svg>
          <div class="donut-center">
            <strong>${total}</strong>
            <span>celkom</span>
          </div>
        </div>
        <div class="donut-legend">${legend}</div>
      </div>
    </div>`;
}

function buildDayBars() {
  const todayKey = toDateOnly(new Date().toISOString());
  const days = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const key   = d.toISOString().slice(0, 10);
    const count = store.activity.filter(e => e.at.slice(0, 10) === key).length;
    const label = d.toLocaleDateString("sk-SK", { weekday: "short" }).slice(0, 2);
    days.push({ key, count, label, isToday: key === todayKey });
  }
  const max = Math.max(...days.map(d => d.count), 1);
  return days.map(d => `
    <div class="day-bar-col" title="${d.count} úkonov — ${d.label}">
      <div class="day-bar-track">
        <div class="day-bar${d.isToday ? " today" : ""}"
          style="height:${d.count ? Math.max(Math.round(d.count / max * 100), 6) : 0}%"></div>
      </div>
      <span class="day-bar-label${d.isToday ? " today" : ""}">${d.label}</span>
    </div>`).join("");
}

// ── Order card ────────────────────────────────────────────────────
function renderOrderCard(order, { compact }) {
  const stateKey  = order.expeditionDone ? "shipped" : order.state;
  const badgeText = order.expeditionDone ? "Expedované" : STATE_LABELS[order.state];
  const isOverdue = isDelayed(order);
  const isSelected = ui.batchSelected.has(order.id);
  const stuck = isStuck(order);

  // ── Slim kanban row ────────────────────────────────────────────
  if (compact) {
    const redDot   = (isOverdue || order.hasProblem) ? `<span class="row-dot red"></span>` : "";
    const amberDot = stuck                           ? `<span class="row-dot amber"></span>` : "";
    const isWorker = !isAdmin(getCurrentUser());
    const action   = getPrimaryAction(order);

    // Worker: inline action button instead of checkbox + date
    if (isWorker && action) {
      const isPendingShip = action.type === "ship" && ui.pendingShipId === order.id;
      const btnLabel = isPendingShip ? "Potvrdiť?" : action.label;
      const btnClass = (action.type === "ship") ? "or-action-btn or-action-ship" : "or-action-btn";
      return `
        <article class="order-row${isSelected ? " selected" : ""}${isOverdue ? " overdue-row" : ""}" data-order-id="${order.id}">
          <div style="flex:1;min-width:0;">
            <span class="or-name">${order.customer}</span>
            <span class="or-sub">${order.item} · ${order.location}</span>
          </div>
          <div class="or-right">${redDot}${amberDot}</div>
          <button class="${btnClass}${isPendingShip ? " or-action-confirm" : ""}" type="button"
            data-action="${action.type}" data-order-id="${order.id}"
            data-inline="1">${btnLabel}</button>
        </article>`;
    }

    // Admin: original layout with checkbox + date
    const checkbox = !order.expeditionDone
      ? `<div class="card-check" data-check="${order.id}" title="Vybrať">${IC_CHECK}</div>` : "";
    return `
      <article class="order-row${isSelected ? " selected" : ""}" data-order-id="${order.id}">
        <div style="flex:1;min-width:0;">
          <span class="or-name">${order.customer}</span>
          <span class="or-sub">${order.item} · ${order.location}</span>
        </div>
        <div class="or-right">${redDot}${amberDot}${checkbox}<span class="or-date">${formatDate(order.shipDate)}</span></div>
      </article>`;
  }

  const overdueBadge = isOverdue        ? `<span class="badge overdue">Mešká</span>`   : "";
  const problemBadge = order.hasProblem ? `<span class="badge problem">Problém</span>` : "";
  const stuckBadge   = stuck            ? `<span class="badge stuck">Zaseknuté</span>` : "";

  const checkbox = (order.state === "ready" && !order.expeditionDone) ? `
    <div class="card-check" data-check="${order.id}" title="Vybrať pre hromadnú expedíciu">${IC_CHECK}</div>` : "";

  const action = getPrimaryAction(order);
  let actionBtn = "";
  if (!compact && action) {
    if (action.type === "ship" && ui.pendingShipId === order.id) {
      actionBtn = `
        <div class="ship-confirm-row">
          <p>Potvrdiť expedíciu?</p>
          <button class="btn-ghost" type="button" data-action="ship-cancel" data-order-id="${order.id}" style="font-size:.78rem;padding:5px 9px;">Nie</button>
          <button class="ship-btn" type="button" data-action="ship-confirm" data-order-id="${order.id}" style="font-size:.78rem;padding:5px 9px;">Áno</button>
        </div>`;
    } else {
      actionBtn = `<div class="actions"><button class="${action.cls}" type="button" data-action="${action.type}" data-order-id="${order.id}">${action.label}</button></div>`;
    }
  }

  return `
    <article class="order-card${isSelected ? " selected" : ""}" data-order-id="${order.id}">
      <div class="order-head">
        <div style="flex:1;min-width:0;">
          <strong style="color: var(--ink); font-size: 0.95rem;">${order.customer}</strong>
          <p class="order-id" style="margin-top: 2px;">${order.id} · ${order.item}</p>
        </div>
        <div class="order-badges" style="display:flex;align-items:center;gap:5px;flex-wrap:wrap;">
          ${checkbox}
          <span class="badge ${stateKey}">${badgeText}</span>
          ${overdueBadge}${problemBadge}${stuckBadge}
        </div>
      </div>
      <div class="order-meta">
        <span class="meta-item">${order.qty} ks</span>
        <span class="meta-item">${order.location}</span>
        <span class="meta-item">${formatDate(order.shipDate)}</span>
        <span class="meta-item">${userName(order.assigneeId)}</span>
      </div>
      ${actionBtn}
    </article>`;
}

function getPrimaryAction(order) {
  if (order.expeditionDone && isAdmin(getCurrentUser()))
    return { type: "unship", label: "Vrátiť", cls: "btn-ghost" };
  if (order.expeditionDone) return null;
  if (order.state === "machine") return { type: "advance", label: "Naskladniť", cls: "state-btn" };
  if (order.state === "stocked") return { type: "advance", label: "Pripraviť",  cls: "state-btn" };
  if (order.state === "ready")   return { type: "ship",    label: "Expedovať",  cls: "ship-btn" };
  return null;
}

// ── Batch selection ───────────────────────────────────────────────
function toggleBatchSelect(orderId) {
  if (ui.batchSelected.has(orderId)) ui.batchSelected.delete(orderId);
  else ui.batchSelected.add(orderId);
  renderBatchBar();
  renderKanban();
  renderOrders();
}

function renderBatchBar() {
  const n = ui.batchSelected.size;
  batchBar.classList.toggle("visible", n > 0);
  batchLabel.textContent = `${n} vybraných`;
  const sel = [...ui.batchSelected].map(id => store.orders.find(o => o.id === id)).filter(Boolean);
  const hasReady       = sel.some(o => o.state === "ready" && !o.expeditionDone);
  const hasAdvanceable = sel.some(o => !o.expeditionDone && (o.state === "machine" || o.state === "stocked"));
  batchShipBtn.classList.toggle("hidden", !hasReady);
  batchAdvanceBtn.classList.toggle("hidden", !hasAdvanceable);
}

async function handleBatchAdvance() {
  const ids = [...ui.batchSelected].filter(id => {
    const o = store.orders.find(x => x.id === id);
    return o && !o.expeditionDone && (o.state === "machine" || o.state === "stocked");
  });
  if (!ids.length) return;
  try {
    const payload = await mutate("/api/orders/batch-advance", { method: "POST", body: JSON.stringify({ orderIds: ids }) });
    ui.batchSelected.clear();
    renderAll();
    showToast(`${payload.count} objednávok posunutých.`, "success");
  } catch (err) { showToast(err.message, "error"); }
}

// ── Order modal ───────────────────────────────────────────────────
function openOrderModal(orderId) {
  const order = store.orders.find(o => o.id === orderId);
  if (!order) return;

  orderModal.dataset.openId = orderId;

  // Header
  $("modalOrderId").textContent = `${order.id} · ${order.item}`;
  $("modalCustomer").textContent = order.customer;

  const badge = $("modalBadge");
  const stateKey = order.expeditionDone ? "shipped" : order.state;
  badge.textContent = order.expeditionDone ? "Expedované" : STATE_LABELS[order.state];
  badge.className = `badge ${stateKey}`;

  const overdueEl = $("modalOverdue");
  overdueEl.classList.toggle("hidden", !isDelayed(order));

  // Details grid or edit form
  const editMode = ui.modalEditMode;
  if (editMode) {
    $("modalDetails").innerHTML = `
      <form id="modalEditForm" class="modal-edit-form">
        <div class="edit-field">
          <label>Odberateľ</label>
          <input name="customer" type="text" value="${escapeHtml(order.customer)}" required />
        </div>
        <div class="edit-field">
          <label>Tovar</label>
          <input name="item" type="text" value="${escapeHtml(order.item)}" required />
        </div>
        <div class="edit-field">
          <label>Množstvo</label>
          <input name="qty" type="number" min="1" value="${order.qty}" required />
        </div>
        <div class="edit-field">
          <label>Pozícia</label>
          <input name="location" type="text" value="${escapeHtml(order.location)}" required />
        </div>
        <div class="edit-field" style="grid-column:1/-1;">
          <label>Termín expedície</label>
          <input name="shipDate" type="date" value="${order.shipDate.slice(0, 10)}" required />
        </div>
      </form>`;
  } else {
    $("modalDetails").innerHTML = [
      { label: "Množstvo",      val: `${order.qty} ks` },
      { label: "Pozícia",       val: order.location },
      { label: "Expedícia",     val: formatDate(order.shipDate) },
      { label: "Zodpovedný",    val: userName(order.assigneeId) },
      { label: "Vytvorené",     val: formatDateTime(order.createdAt) },
      { label: "Aktualizované", val: formatDateTime(order.updatedAt) },
    ].map(d => `
      <div class="detail-cell">
        <div class="dc-label">${d.label}</div>
        <div class="dc-val">${d.val}</div>
      </div>`).join("");
  }

  // Hide timeline in edit mode
  const tlSection = $("modalTimeline")?.closest(".modal-section");
  if (tlSection) tlSection.style.display = editMode ? "none" : "";

  // Timeline
  const orderActivity = store.activity.filter(e => e.message.includes(order.id)).reverse();
  const steps = [
    { label: "Objednávka vytvorená", done: true },
    { label: "Na stroji → Naskladnené", done: ["stocked","ready"].includes(order.state) || order.expeditionDone },
    { label: "Naskladnené → Pripravené", done: order.state === "ready" || order.expeditionDone },
    { label: "Expedované", done: order.expeditionDone },
  ];

  // Build timeline from activity + pending steps
  const tlItems = [];

  orderActivity.forEach(e => {
    tlItems.push({ label: e.message, who: userName(e.userId), at: formatDateTime(e.at), done: true });
  });

  if (!order.expeditionDone) {
    const remaining = steps.filter(s => !s.done);
    if (remaining.length) {
      tlItems.push({ label: `Čaká: ${remaining[0].label.split("→").pop().trim()}`, pending: true });
    }
  }

  $("modalTimeline").innerHTML = tlItems.map((item, i) => `
    <div class="tl-row">
      <div class="tl-spine">
        <div class="tl-dot ${item.pending ? "pending" : "done"}"></div>
        ${i < tlItems.length - 1 ? '<div class="tl-line"></div>' : ""}
      </div>
      <div class="tl-content">
        <div class="tl-label">${item.label}</div>
        ${item.who ? `<div class="tl-meta"><span>${item.who}</span><span>${item.at}</span></div>` : ""}
      </div>
    </div>`).join("");

  // Photos
  const photos = order.photos || [];
  const photoSection = $("modalPhotos");
  if (photoSection) {
    const thumbs = photos.map(p => `<img class="photo-thumb" src="${p.data}" title="${formatDateTime(p.at)}" />`).join("");
    const addBtn = photos.length < 5
      ? `<label class="photo-add-btn" for="photoFileInput">
           <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M6.827 6.175A2.31 2.31 0 0 1 5.186 7.23c-.38.054-.757.112-1.134.175C2.999 7.58 2.25 8.507 2.25 9.574V18a2.25 2.25 0 0 0 2.25 2.25h15A2.25 2.25 0 0 0 21.75 18V9.574c0-1.067-.75-1.994-1.802-2.169a47.865 47.865 0 0 0-1.134-.175 2.31 2.31 0 0 1-1.64-1.055l-.822-1.316a2.192 2.192 0 0 0-1.736-1.039 48.774 48.774 0 0 0-5.232 0 2.192 2.192 0 0 0-1.736 1.039l-.821 1.316Z"/><path stroke-linecap="round" stroke-linejoin="round" d="M16.5 12.75a4.5 4.5 0 1 1-9 0 4.5 4.5 0 0 1 9 0ZM18.75 10.5h.008v.008h-.008V10.5Z"/></svg>
           Foto
         </label>` : "";
    photoSection.innerHTML = `<div class="photo-grid">${thumbs}${addBtn}</div>`;

    // click to view full size
    photoSection.querySelectorAll(".photo-thumb").forEach((img, i) => {
      img.onclick = () => {
        const a = document.createElement("a"); a.href = photos[i].data; a.target = "_blank"; a.click();
      };
    });

    const fileInput = $("photoFileInput");
    if (fileInput) fileInput.onchange = async e => {
      const file = e.target.files[0];
      if (!file) return;
      try {
        const data = await resizePhoto(file, 1200, 0.82);
        await mutate(`/api/orders/${orderId}/photos`, { method: "POST", body: JSON.stringify({ data }) });
        showToast("Foto pridané.", "success");
        openOrderModal(orderId);
      } catch (err) { showToast(err.message, "error"); }
      fileInput.value = "";
    };
  }

  // Notes
  const notes = order.notes || [];
  $("modalNotesList").innerHTML = notes.length
    ? notes.map(n => `
      <div class="note-item ${n.type === "problem" ? "problem" : ""}">
        ${n.type === "problem" ? `<div class="note-type-label">Problém</div>` : ""}
        <p class="note-text">${escapeHtml(n.text)}</p>
        <div class="note-meta">
          <span>${userName(n.userId)}</span>
          <span>${formatDateTime(n.at)}</span>
        </div>
      </div>`).join("")
    : `<p class="muted" style="font-size:.78rem;padding:2px 0 8px;">Žiadne poznámky.</p>`;

  const noteForm = $("modalNoteForm");
  const noteTextEl = $("modalNoteText");
  const reportBtn = $("modalReportProblem");

  async function submitNote(type) {
    const text = noteTextEl.value.trim();
    if (!text) { showToast("Zadaj text poznámky.", "warn"); noteTextEl.focus(); return; }
    try {
      await mutate(`/api/orders/${orderId}/notes`, { method: "POST", body: JSON.stringify({ text, type }) });
      noteTextEl.value = "";
      showToast(type === "problem" ? "Problém nahlásený." : "Poznámka pridaná.", "success");
      openOrderModal(orderId);
    } catch (err) { handleMutationError(err); }
  }

  if (noteForm)   noteForm.onsubmit = e => { e.preventDefault(); submitNote("note"); };
  if (reportBtn)  reportBtn.onclick = () => submitNote("problem");

  // Action area
  const admin = isAdmin(getCurrentUser());
  const action = getPrimaryAction(order);
  let actionHtml = "";

  if (ui.pendingDeleteId === order.id) {
    actionHtml = `
      <span style="flex:1;font-size:.82rem;font-weight:600;color:var(--red);">Naozaj zmazať ${order.id}?</span>
      <button class="btn-ghost" type="button" data-action="delete-cancel" data-order-id="${order.id}">Nie</button>
      <button class="btn-danger" type="button" data-action="delete-confirm" data-order-id="${order.id}">Zmazať</button>`;
  } else if (editMode) {
    actionHtml = `
      <button class="btn-ghost" style="flex:1;" type="button" data-action="edit-cancel" data-order-id="${order.id}">Zrušiť</button>
      <button class="btn-primary" style="flex:1;" type="button" data-action="edit-save" data-order-id="${order.id}">Uložiť zmeny</button>`;
  } else {
    if (admin) {
      actionHtml += `
        <button class="btn-ghost btn-delete-ghost" type="button" data-action="delete-start" data-order-id="${order.id}">Zmazať</button>
        <button class="btn-ghost" type="button" data-action="edit-start" data-order-id="${order.id}">Upraviť</button>`;
    }
    if (admin) {
      actionHtml += `<button class="btn-ghost" type="button" data-action="print-slip" data-order-id="${order.id}" title="Tlačiť slipku">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path stroke-linecap="round" stroke-linejoin="round" d="M6.72 13.829c-.24.03-.48.062-.72.096m.72-.096a42.415 42.415 0 0 1 10.56 0m-10.56 0L6.34 18m10.94-4.171c.24.03.48.062.72.096m-.72-.096L17.66 18m0 0 .229 2.523a1.125 1.125 0 0 1-1.12 1.227H7.231c-.662 0-1.18-.568-1.12-1.227L6.34 18m11.318 0h1.091A2.25 2.25 0 0 0 21 15.75V9.456c0-1.081-.768-2.015-1.837-2.175a48.055 48.055 0 0 0-1.913-.247M6.34 18H5.25A2.25 2.25 0 0 1 3 15.75V9.456c0-1.081.768-2.015 1.837-2.175a48.041 48.041 0 0 1 1.913-.247m10.5 0a48.536 48.536 0 0 0-10.5 0m10.5 0V3.375c0-.621-.504-1.125-1.125-1.125h-8.25c-.621 0-1.125.504-1.125 1.125v3.659M18 10.5h.008v.008H18V10.5Zm-3 0h.008v.008H15V10.5Z"/></svg>
      </button>`;
    }
    if (action && action.type === "ship" && ui.pendingShipId === order.id) {
      actionHtml += `
        <button class="btn-ghost" type="button" data-action="ship-cancel" data-order-id="${order.id}">Zrušiť</button>
        <button class="ship-btn" style="flex:1;" type="button" data-action="ship-confirm" data-order-id="${order.id}">Potvrdiť expedíciu</button>`;
    } else if (action) {
      actionHtml += `<button class="${action.cls}" style="flex:1;" type="button" data-action="${action.type}" data-order-id="${order.id}">${action.label}</button>`;
    }
  }
  $("modalAction").innerHTML = actionHtml;

  orderModal.classList.remove("hidden");
  document.body.style.overflow = "hidden";
}

function closeOrderModal() {
  orderModal.classList.add("hidden");
  orderModal.dataset.openId = "";
  document.body.style.overflow = "";
  ui.modalEditMode = false;
  ui.pendingDeleteId = null;
}

function exportOrdersCSV() {
  const orders = getSortedOrders().filter(o => {
    const s = `${o.id} ${o.customer} ${o.item} ${o.location}`.toLowerCase();
    return (!ui.orderSearch || s.includes(ui.orderSearch)) &&
      (ui.orderFilter === "all" || o.state === ui.orderFilter || (ui.orderFilter === "overdue" && isDelayed(o)));
  });
  const header = ["ID", "Zákazník", "Tovar", "Množstvo", "Pozícia", "Termín", "Stav", "Zodpovedný", "Aktualizované"];
  const rows = orders.map(o => [
    o.id, o.customer, o.item, o.qty, o.location,
    o.shipDate.slice(0, 10),
    o.expeditionDone ? "Expedované" : (STATE_LABELS[o.state] || o.state),
    userName(o.assigneeId),
    o.updatedAt.slice(0, 10),
  ].map(v => `"${String(v).replace(/"/g, '""')}"`).join(","));
  const csv = [header.join(","), ...rows].join("\r\n");
  const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `loman-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function printOrderSlip(orderId) {
  const order = store.orders.find(o => o.id === orderId);
  if (!order) return;

  let slip = document.getElementById("printSlip");
  if (!slip) { slip = document.createElement("div"); slip.id = "printSlip"; document.body.appendChild(slip); }

  const noteLines = (order.notes || []).map(n =>
    `<div class="${n.type === "problem" ? "ps-note-problem" : ""}">${n.type === "problem" ? "! " : "· "}${escapeHtml(n.text)}</div>`
  ).join("");

  slip.innerHTML = `
    <div class="ps-top">
      <div class="ps-id">${order.id}</div>
      <div class="ps-date">
        Termín: <strong>${order.shipDate.slice(0, 10)}</strong><br>
        Stav: ${order.expeditionDone ? "Expedované" : (STATE_LABELS[order.state] || order.state)}
      </div>
    </div>
    <div class="ps-customer">${escapeHtml(order.customer)}</div>
    <div class="ps-item">${escapeHtml(order.item)}</div>
    <div class="ps-meta">
      <div class="ps-meta-block">
        <label>Množstvo</label>
        <strong>${order.qty} ks</strong>
      </div>
      <div class="ps-meta-block ps-loc">
        <label>Pozícia</label>
        <strong>${escapeHtml(order.location)}</strong>
      </div>
      <div class="ps-meta-block">
        <label>Zodpovedný</label>
        <strong>${userName(order.assigneeId)}</strong>
      </div>
    </div>
    ${noteLines ? `<div class="ps-notes">${noteLines}</div>` : ""}
    <div class="ps-footer">Loman Sklad · ${new Date().toLocaleString("sk-SK")}</div>`;

  window.print();
}

// ── Toast ─────────────────────────────────────────────────────────
let toastTimer = null;
function showToast(msg, type = "info") {
  toastEl.textContent = msg;
  toastEl.className = `toast ${type}`;
  requestAnimationFrame(() => requestAnimationFrame(() => toastEl.classList.add("visible")));
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove("visible"), 3200);
}

// ── Helpers ───────────────────────────────────────────────────────
async function requestJson(url, opts = {}, { allow401 = false } = {}) {
  const res = await fetch(url, opts);
  const payload = await res.json().catch(() => ({}));
  if (res.status === 401 && !allow401) {
    clearSessionState();
    renderAll();
    throw new Error(payload.error || "Session vypršala. Prihlás sa znova.");
  }
  if (!res.ok) throw new Error(payload.error || "Operácia zlyhala.");
  return payload;
}

function setSessionUser(userId) {
  ui.sessionUserId = userId || "";
  if (ui.sessionUserId) {
    ui.selectedLoginUserId = ui.sessionUserId;
    localStorage.setItem(LAST_LOGIN_USER_KEY, ui.sessionUserId);
  }
}

function clearSessionState() {
  ui.sessionUserId = "";
  ui.loginMessage = "";
  ui.batchSelected.clear();
  pinInput.value = "";
  store = {
    users: store.users || [],
    orders: [],
    inventory: [],
    activity: [],
    inventoryLog: [],
    shiftNote: { text: "", updatedAt: "", userId: "" },
  };
  syncRealtimeConnection();
}

function getCurrentUser() { return store.users.find(u => u.id === ui.sessionUserId) || null; }
function isAdmin(user) { return user?.role === "admin"; }

function getUserOpenOrders() {
  const user = getCurrentUser();
  if (!user) return [];
  if (isAdmin(user)) return getSortedOrders().filter(o => !o.expeditionDone);
  return getSortedOrders().filter(o => !o.expeditionDone && (o.assigneeId === user.id || o.state !== "ready"));
}

function getSortedOrders() {
  const cur = getCurrentUser();
  return [...store.orders].sort((a, b) => {
    const od = Number(isDelayed(b)) - Number(isDelayed(a));
    if (od) return od;
    const md = Number(b.assigneeId === cur?.id) - Number(a.assigneeId === cur?.id);
    if (md) return md;
    return new Date(a.shipDate) - new Date(b.shipDate);
  });
}

function getTodayOrders()   { return store.orders.filter(o => isToday(o.shipDate) && !o.expeditionDone); }
function getDelayedOrders() { return store.orders.filter(o => isDelayed(o)); }

function isDelayed(o) {
  if (o.expeditionDone) return false;
  return toDateOnly(o.shipDate) < toDateOnly(new Date().toISOString()) && o.state === "ready";
}

function isStuck(o) {
  if (o.expeditionDone || o.state === "ready") return false;
  return (Date.now() - new Date(o.updatedAt).getTime()) > 8 * 36e5;
}

function userName(id) { return store.users.find(u => u.id === id)?.name || "—"; }
function isToday(v)   { return toDateOnly(v) === toDateOnly(new Date().toISOString()); }
function toDateOnly(v){ return new Date(v).toISOString().slice(0, 10); }

function formatDate(v) {
  return new Intl.DateTimeFormat("sk-SK", { day: "numeric", month: "numeric" }).format(new Date(v));
}
function formatDateTime(v) {
  return new Intl.DateTimeFormat("sk-SK", { day: "numeric", month: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(v));
}

function resizePhoto(file, maxPx, quality) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(url);
      const scale = Math.min(1, maxPx / Math.max(img.width, img.height));
      const canvas = document.createElement("canvas");
      canvas.width  = Math.round(img.width  * scale);
      canvas.height = Math.round(img.height * scale);
      canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
      resolve(canvas.toDataURL("image/jpeg", quality));
    };
    img.onerror = reject;
    img.src = url;
  });
}

function escapeHtml(str) {
  return String(str).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return;
  navigator.serviceWorker.register("./sw.js").catch(() => {});
}

function handlePlatformHints() {
  const ua = navigator.userAgent.toLowerCase();
  const isIos = /iphone|ipad|ipod/.test(ua);
  const isStandalone = window.matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
  if (isIos && !isStandalone) iosHint.classList.remove("hidden");
}
