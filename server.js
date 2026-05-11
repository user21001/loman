const express  = require("express");
const fs       = require("fs/promises");
const fsSync   = require("fs");
const path     = require("path");
const crypto   = require("crypto");

const app = express();
const PORT = process.env.PORT || 4174;
const DATA_FILE   = path.join(__dirname, "data", "store.json");
const BACKUP_DIR  = path.join(__dirname, "data", "backups");
const PUBLIC_DIR  = path.join(__dirname, "public");
const SESSION_COOKIE = "loman_session";
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const SESSION_TOUCH_MS = 15 * 60 * 1000;

app.set("trust proxy", 1);
app.use(express.json({ limit: "10mb" }));

let store;
const sseClients = new Set();
const sessions = new Map();

// ── Login rate limiting ──────────────────────────────────────────
const loginAttempts = new Map(); // key: userId → { count, lockedUntil }
const LOGIN_MAX_ATTEMPTS = 5;
const LOGIN_LOCKOUT_MS   = 60_000; // 1 minúta

function checkLoginRateLimit(userId) {
  const now = Date.now();
  const entry = loginAttempts.get(userId) || { count: 0, lockedUntil: 0 };
  if (entry.lockedUntil > now) {
    const secsLeft = Math.ceil((entry.lockedUntil - now) / 1000);
    return { locked: true, secsLeft };
  }
  return { locked: false, count: entry.count };
}

function recordFailedLogin(userId) {
  const now = Date.now();
  const entry = loginAttempts.get(userId) || { count: 0, lockedUntil: 0 };
  entry.count += 1;
  if (entry.count >= LOGIN_MAX_ATTEMPTS) {
    entry.lockedUntil = now + LOGIN_LOCKOUT_MS;
    entry.count = 0;
  }
  loginAttempts.set(userId, entry);
}

function clearLoginAttempts(userId) {
  loginAttempts.delete(userId);
}

setInterval(cleanExpiredSessions, 10 * 60 * 1000);

// ── SSE heartbeat ────────────────────────────────────────────────
setInterval(() => {
  for (const res of sseClients) {
    try { res.write(":heartbeat\n\n"); } catch { sseClients.delete(res); }
  }
}, 25000);

// ── Daily backup ─────────────────────────────────────────────────
async function runBackup() {
  if (!store) return;
  try {
    await fs.mkdir(BACKUP_DIR, { recursive: true });
    const tag  = new Date().toISOString().slice(0, 10);
    const dest = path.join(BACKUP_DIR, `store-${tag}.json`);
    await fs.writeFile(dest, JSON.stringify(store, null, 2));
    // keep last 30 backups
    const files = (await fs.readdir(BACKUP_DIR))
      .filter(f => f.startsWith("store-") && f.endsWith(".json"))
      .sort();
    for (const old of files.slice(0, -30))
      await fs.unlink(path.join(BACKUP_DIR, old)).catch(() => {});
  } catch (err) { console.error("Backup failed:", err.message); }
}

function scheduleBackup() {
  const now  = new Date();
  const next = new Date(now);
  next.setDate(next.getDate() + 1);
  next.setHours(2, 0, 0, 0); // 02:00 each night
  setTimeout(() => { runBackup(); scheduleBackup(); }, next - now);
}

scheduleBackup();

// ── Routes ───────────────────────────────────────────────────────

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, date: new Date().toISOString() });
});

app.get("/api/events", async (req, res) => {
  await ensureStore();
  const actor = getActor(req);
  if (!actor) return res.status(401).json({ error: "Session vypršala. Prihlás sa znova." });
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();

  sseClients.add(res);
  req.on("close", () => sseClients.delete(res));

  // send current state immediately on connect
  res.write(`data: ${JSON.stringify({ type: "store", store: sanitizeStore(store) })}\n\n`);
});

app.get("/api/bootstrap", async (req, res) => {
  await ensureStore();
  const actor = getActor(req);
  res.json({
    user: sanitizeUser(actor),
    store: actor ? sanitizeStore(store) : buildPublicStore(store),
  });
});

app.post("/api/login", async (req, res) => {
  await ensureStore();
  const { userId, pin } = req.body || {};
  const user = store.users.find((u) => u.id === userId);
  if (!user) return res.status(404).json({ error: "Používateľ neexistuje." });

  const limit = checkLoginRateLimit(userId);
  if (limit.locked)
    return res.status(429).json({ error: `Príliš veľa pokusov. Skús znova o ${limit.secsLeft}s.` });

  if (!verifyPin(String(pin || ""), user)) {
    recordFailedLogin(userId);
    const remaining = LOGIN_MAX_ATTEMPTS - ((loginAttempts.get(userId)?.count) || 0);
    const msg = remaining > 0
      ? `Nesprávny PIN. Zostáva ${remaining} ${remaining === 1 ? "pokus" : "pokusy"}.`
      : "Nesprávny PIN.";
    return res.status(401).json({ error: msg });
  }

  clearLoginAttempts(userId);
  const previousSession = getSession(req);
  if (previousSession) destroySession(previousSession.token);
  const token = createSession(user.id);
  setSessionCookie(res, token);
  if (!user.pinHash) {
    user.pinHash = hashPin(String(pin || ""));
    delete user.pin;
    await saveStore();
  }
  res.json({ user: sanitizeUser(user), store: sanitizeStore(store) });
});

app.post("/api/logout", (req, res) => {
  const session = getSession(req);
  if (session) destroySession(session.token);
  clearSessionCookie(res);
  res.json({ ok: true });
});

app.post("/api/orders", async (req, res) => {
  await ensureStore();
  const actor = getActor(req);
  if (!actor || actor.role !== "admin")
    return res.status(403).json({ error: "Len admin môže vytvárať objednávky." });

  const { customer, item, qty, location, shipDate, assigneeId } = req.body || {};
  if (!customer || !item || !qty || !location || !shipDate)
    return res.status(400).json({ error: "Chýbajú povinné polia." });

  const assignee = assigneeId && store.users.find(u => u.id === assigneeId) ? assigneeId : actor.id;

  const order = {
    id: nextOrderId(),
    customer: String(customer).trim(),
    item: String(item).trim(),
    qty: Number(qty),
    location: String(location).trim(),
    shipDate: String(shipDate),
    state: "machine",
    expeditionDone: false,
    assigneeId: assignee,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  store.orders.unshift(order);
  pushActivity(actor.id, `vytvoril objednávku ${order.id}.`);
  await saveStore();
  res.status(201).json({ store: sanitizeStore(store) });
});

app.patch("/api/orders/:id/advance", async (req, res) => {
  await ensureStore();
  const actor = getActor(req);
  if (!actor) return res.status(401).json({ error: "Chýba aktívny používateľ." });

  const order = store.orders.find((o) => o.id === req.params.id);
  if (!order) return res.status(404).json({ error: "Objednávka neexistuje." });

  const seq = ["machine", "stocked", "ready"];
  const idx = seq.indexOf(order.state);
  if (idx === seq.length - 1)
    return res.status(400).json({ error: "Objednávka je už v poslednom stave." });

  order.state = seq[idx + 1];
  order.updatedAt = new Date().toISOString();
  order.assigneeId = actor.id;
  order.hasProblem = false; // state change resolves any reported problem
  if (order.state === "stocked") upsertInventory(order.item, order.location, order.qty, actor.id, "naskladnené z objednávky");

  pushActivity(actor.id, `zmenil ${order.id} na ${stateLabel(order.state)}.`);
  await saveStore();
  res.json({ store: sanitizeStore(store) });
});

app.patch("/api/orders/:id/expedition", async (req, res) => {
  await ensureStore();
  const actor = getActor(req);
  if (!actor) return res.status(401).json({ error: "Chýba aktívny používateľ." });

  const order = store.orders.find((o) => o.id === req.params.id);
  if (!order) return res.status(404).json({ error: "Objednávka neexistuje." });

  if (order.state !== "ready" && !order.expeditionDone)
    return res.status(400).json({ error: "Expedíciu možno meniť až po stave Pripravené." });

  order.expeditionDone = !order.expeditionDone;
  order.updatedAt = new Date().toISOString();
  order.assigneeId = actor.id;
  adjustInventory(order.item, order.location, order.expeditionDone ? -order.qty : order.qty, actor.id, order.expeditionDone ? "expedícia" : "vrátenie expedície");
  pushActivity(actor.id, `${order.expeditionDone ? "uzavrel" : "vrátil"} expedíciu ${order.id}.`);
  await saveStore();
  res.json({ store: sanitizeStore(store) });
});

// Add note or problem report to an order
app.post("/api/orders/:id/notes", async (req, res) => {
  await ensureStore();
  const actor = getActor(req);
  if (!actor) return res.status(401).json({ error: "Chýba aktívny používateľ." });

  const order = store.orders.find((o) => o.id === req.params.id);
  if (!order) return res.status(404).json({ error: "Objednávka neexistuje." });

  const { text, type } = req.body || {};
  if (!String(text || "").trim()) return res.status(400).json({ error: "Poznámka nesmie byť prázdna." });

  if (!order.notes) order.notes = [];

  const note = {
    id: `NOTE-${Date.now()}`,
    text: String(text).trim(),
    userId: actor.id,
    at: new Date().toISOString(),
    type: type === "problem" ? "problem" : "note",
  };

  order.notes.push(note);

  if (type === "problem") {
    order.hasProblem = true;
    pushActivity(actor.id, `nahlásil problém na ${order.id}: "${note.text.slice(0, 60)}"`);
  } else {
    pushActivity(actor.id, `pridal poznámku k ${order.id}.`);
  }

  await saveStore();
  res.json({ store: sanitizeStore(store) });
});

app.patch("/api/orders/:id", async (req, res) => {
  await ensureStore();
  const actor = getActor(req);
  if (!actor || actor.role !== "admin")
    return res.status(403).json({ error: "Len admin môže upravovať objednávky." });

  const order = store.orders.find((o) => o.id === req.params.id);
  if (!order) return res.status(404).json({ error: "Objednávka neexistuje." });

  const { customer, item, qty, location, shipDate } = req.body || {};
  if (!customer || !item || !qty || !location || !shipDate)
    return res.status(400).json({ error: "Chýbajú povinné polia." });

  const previousOrder = snapshotOrder(order);
  reconcileInventoryForOrder(previousOrder, "remove");

  order.customer = String(customer).trim();
  order.item     = String(item).trim();
  order.qty      = Number(qty);
  order.location = String(location).trim();
  order.shipDate = String(shipDate);
  order.updatedAt = new Date().toISOString();
  order.assigneeId = actor.id;

  reconcileInventoryForOrder(order, "add");
  pushActivity(actor.id, `upravil objednávku ${order.id}.`);
  await saveStore();
  res.json({ store: sanitizeStore(store) });
});

app.delete("/api/orders/:id", async (req, res) => {
  await ensureStore();
  const actor = getActor(req);
  if (!actor || actor.role !== "admin")
    return res.status(403).json({ error: "Len admin môže mazať objednávky." });

  const idx = store.orders.findIndex((o) => o.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: "Objednávka neexistuje." });

  const [removed] = store.orders.splice(idx, 1);
  reconcileInventoryForOrder(removed, "remove");
  pushActivity(actor.id, `zmazal objednávku ${removed.id}.`);
  await saveStore();
  res.json({ store: sanitizeStore(store) });
});

app.post("/api/orders/batch-advance", async (req, res) => {
  await ensureStore();
  const actor = getActor(req);
  if (!actor) return res.status(401).json({ error: "Chýba aktívny používateľ." });

  const { orderIds } = req.body || {};
  if (!Array.isArray(orderIds) || !orderIds.length)
    return res.status(400).json({ error: "Chýbajú ID objednávok." });

  const seq = ["machine", "stocked", "ready"];
  let count = 0;
  for (const id of orderIds) {
    const order = store.orders.find((o) => o.id === id);
    if (!order || order.expeditionDone) continue;
    const idx = seq.indexOf(order.state);
    if (idx < 0 || idx >= seq.length - 1) continue;
    order.state = seq[idx + 1];
    order.updatedAt = new Date().toISOString();
    order.assigneeId = actor.id;
    order.hasProblem = false;
    if (order.state === "stocked") upsertInventory(order.item, order.location, order.qty, actor.id, "naskladnené z objednávky");
    pushActivity(actor.id, `zmenil ${order.id} na ${stateLabel(order.state)}.`);
    count++;
  }

  if (!count) return res.status(400).json({ error: "Žiadna objednávka nebola posunutá." });
  await saveStore();
  res.json({ store: sanitizeStore(store), count });
});

app.post("/api/orders/:id/photos", async (req, res) => {
  await ensureStore();
  const actor = getActor(req);
  if (!actor) return res.status(401).json({ error: "Chýba aktívny používateľ." });

  const order = store.orders.find((o) => o.id === req.params.id);
  if (!order) return res.status(404).json({ error: "Objednávka neexistuje." });

  const { data } = req.body || {};
  if (!data || !String(data).startsWith("data:image/"))
    return res.status(400).json({ error: "Neplatná fotka." });
  if (!order.photos) order.photos = [];
  if (order.photos.length >= 5)
    return res.status(400).json({ error: "Maximum 5 fotiek na objednávku." });

  order.photos.push({ id: `PHOTO-${Date.now()}`, data: String(data), userId: actor.id, at: new Date().toISOString() });
  pushActivity(actor.id, `pridal foto k ${order.id}.`);
  await saveStore();
  res.json({ store: sanitizeStore(store) });
});

app.post("/api/users", async (req, res) => {
  await ensureStore();
  const actor = getActor(req);
  if (!actor || actor.role !== "admin")
    return res.status(403).json({ error: "Len admin môže pridávať používateľov." });

  const { name, role, pin } = req.body || {};
  if (!String(name || "").trim()) return res.status(400).json({ error: "Chýba meno." });
  const pinStr = String(pin || "");
  const isAdmin = role === "admin";
  const pinValid = isAdmin ? /^\d{6,}$/.test(pinStr) : /^\d{4}$/.test(pinStr);
  if (!pinValid) return res.status(400).json({ error: isAdmin ? "Admin PIN musí mať aspoň 6 číslic." : "PIN musí byť 4 číslice." });

  const id = `u-${Date.now()}`;
  store.users.push({ id, name: String(name).trim(), role: isAdmin ? "admin" : "worker", pinHash: hashPin(pinStr) });
  pushActivity(actor.id, `pridal používateľa ${name}.`);
  await saveStore();
  res.status(201).json({ store: sanitizeStore(store) });
});

app.patch("/api/users/:id", async (req, res) => {
  await ensureStore();
  const actor = getActor(req);
  if (!actor || actor.role !== "admin")
    return res.status(403).json({ error: "Len admin môže upravovať používateľov." });

  const user = store.users.find((u) => u.id === req.params.id);
  if (!user) return res.status(404).json({ error: "Používateľ neexistuje." });

  const { name, role, pin } = req.body || {};
  const previousRole = user.role;
  if (name) user.name = String(name).trim();
  if (role) user.role = role === "admin" ? "admin" : "worker";
  if (role && user.role !== previousRole) destroyUserSessions(user.id);
  if (pin !== undefined) {
    const pinStr = String(pin || "");
    const targetRole = (role || user.role);
    const isAdminRole = targetRole === "admin";
    const pinValid = isAdminRole ? /^\d{6,}$/.test(pinStr) : /^\d{4}$/.test(pinStr);
    if (!pinValid) return res.status(400).json({ error: isAdminRole ? "Admin PIN musí mať aspoň 6 číslic." : "PIN musí byť 4 číslice." });
    user.pinHash = hashPin(pinStr);
    delete user.pin;
    destroyUserSessions(user.id);
  }
  pushActivity(actor.id, `upravil používateľa ${user.name}.`);
  await saveStore();
  res.json({ store: sanitizeStore(store) });
});

app.delete("/api/users/:id", async (req, res) => {
  await ensureStore();
  const actor = getActor(req);
  if (!actor || actor.role !== "admin")
    return res.status(403).json({ error: "Len admin môže mazať používateľov." });
  if (req.params.id === actor.id)
    return res.status(400).json({ error: "Nemôžeš zmazať vlastný účet." });

  const idx = store.users.findIndex((u) => u.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: "Používateľ neexistuje." });

  const [removed] = store.users.splice(idx, 1);
  destroyUserSessions(removed.id);
  pushActivity(actor.id, `zmazal používateľa ${removed.name}.`);
  await saveStore();
  res.json({ store: sanitizeStore(store) });
});

// Batch ship multiple ready orders at once
app.post("/api/orders/batch-ship", async (req, res) => {
  await ensureStore();
  const actor = getActor(req);
  if (!actor) return res.status(401).json({ error: "Chýba aktívny používateľ." });

  const { orderIds } = req.body || {};
  if (!Array.isArray(orderIds) || !orderIds.length)
    return res.status(400).json({ error: "Chýbajú ID objednávok." });

  let count = 0;
  for (const id of orderIds) {
    const order = store.orders.find((o) => o.id === id);
    if (!order || order.state !== "ready" || order.expeditionDone) continue;
    order.expeditionDone = true;
    order.updatedAt = new Date().toISOString();
    order.assigneeId = actor.id;
    adjustInventory(order.item, order.location, -order.qty, actor.id, "expedícia");
    pushActivity(actor.id, `uzavrel expedíciu ${order.id}.`);
    count++;
  }

  if (!count) return res.status(400).json({ error: "Žiadna objednávka nebola v stave Pripravené." });
  await saveStore();
  res.json({ store: sanitizeStore(store), count });
});

app.post("/api/inventory", async (req, res) => {
  await ensureStore();
  const actor = getActor(req);
  if (!actor || actor.role !== "admin")
    return res.status(403).json({ error: "Len admin môže pridávať položky." });

  const { name, sku, location, qty } = req.body || {};
  if (!String(name || "").trim() || !String(sku || "").trim() || !String(location || "").trim())
    return res.status(400).json({ error: "Chýbajú povinné polia." });
  if (store.inventory.some(i => i.sku === String(sku).trim()))
    return res.status(400).json({ error: "SKU už existuje." });

  store.inventory.unshift({
    sku: String(sku).trim(),
    name: String(name).trim(),
    location: String(location).trim(),
    qty: Math.max(0, Number(qty) || 0),
    updatedAt: new Date().toISOString(),
  });
  pushActivity(actor.id, `pridal skladovú položku ${sku}.`);
  await saveStore();
  res.status(201).json({ store: sanitizeStore(store) });
});

app.patch("/api/inventory/:sku", async (req, res) => {
  await ensureStore();
  const actor = getActor(req);
  if (!actor || actor.role !== "admin")
    return res.status(403).json({ error: "Len admin môže upravovať sklad." });

  const item = store.inventory.find(i => i.sku === req.params.sku);
  if (!item) return res.status(404).json({ error: "Položka neexistuje." });

  const { name, location, qty } = req.body || {};
  if (name)     item.name     = String(name).trim();
  if (location) item.location = String(location).trim();
  if (qty !== undefined) item.qty = Math.max(0, Number(qty) || 0);
  item.updatedAt = new Date().toISOString();

  pushActivity(actor.id, `upravil skladovú položku ${item.sku}.`);
  await saveStore();
  res.json({ store: sanitizeStore(store) });
});

app.delete("/api/inventory/:sku", async (req, res) => {
  await ensureStore();
  const actor = getActor(req);
  if (!actor || actor.role !== "admin")
    return res.status(403).json({ error: "Len admin môže mazať položky." });

  const idx = store.inventory.findIndex(i => i.sku === req.params.sku);
  if (idx === -1) return res.status(404).json({ error: "Položka neexistuje." });

  const [removed] = store.inventory.splice(idx, 1);
  pushActivity(actor.id, `zmazal skladovú položku ${removed.sku}.`);
  await saveStore();
  res.json({ store: sanitizeStore(store) });
});

app.get("/api/inventory-log", async (req, res) => {
  await ensureStore();
  const actor = getActor(req);
  if (!actor) return res.status(401).json({ error: "Session vypršala. Prihlás sa znova." });
  const { sku } = req.query;
  let log = store.inventoryLog || [];
  if (sku) log = log.filter(e => e.sku === sku);
  res.json({ log: log.slice(0, 100) });
});

app.patch("/api/shift-note", async (req, res) => {
  await ensureStore();
  const actor = getActor(req);
  if (!actor) return res.status(401).json({ error: "Chýba aktívny používateľ." });
  const { text } = req.body || {};
  store.shiftNote = { text: String(text || "").trim(), updatedAt: new Date().toISOString(), userId: actor.id };
  await saveStore();
  res.json({ store: sanitizeStore(store) });
});

app.get("/api/archive", async (req, res) => {
  await ensureStore();
  const actor = getActor(req);
  if (!actor || actor.role !== "admin")
    return res.status(403).json({ error: "Len admin má prístup do archívu." });
  const { month, customer } = req.query;
  let orders = store.orders.filter(o => o.expeditionDone);
  if (month)    orders = orders.filter(o => (o.updatedAt || o.shipDate).slice(0, 7) === month);
  if (customer) orders = orders.filter(o => o.customer.toLowerCase().includes(customer.toLowerCase()));
  orders = [...orders].sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
  res.json({ orders });
});

app.get("/api/backups", async (req, res) => {
  await ensureStore();
  const actor = getActor(req);
  if (!actor || actor.role !== "admin")
    return res.status(403).json({ error: "Len admin má prístup k zálohám." });
  try {
    await fs.mkdir(BACKUP_DIR, { recursive: true });
    const files = (await fs.readdir(BACKUP_DIR))
      .filter(f => f.startsWith("store-") && f.endsWith(".json"))
      .sort().reverse();
    res.json({ backups: files });
  } catch { res.json({ backups: [] }); }
});


app.use(express.static(PUBLIC_DIR));
app.get("*", (_req, res) => res.sendFile(path.join(PUBLIC_DIR, "index.html")));

app.listen(PORT, async () => {
  await ensureStore();
  console.log(`Loman running on http://localhost:${PORT}`);
});

// ── Store helpers ────────────────────────────────────────────────

async function ensureStore() {
  if (store) return;
  try {
    store = JSON.parse(await fs.readFile(DATA_FILE, "utf8"));
  } catch {
    store = buildSeedStore();
    await saveStore();
    return;
  }
  const migrated = migrateStoreForSecurity(store);
  if (migrated) await saveStore();
}

async function saveStore() {
  await fs.mkdir(path.dirname(DATA_FILE), { recursive: true });
  await fs.writeFile(DATA_FILE, JSON.stringify(store, null, 2));
  broadcastStore();
}

function broadcastStore() {
  if (!sseClients.size) return;
  const data = JSON.stringify({ type: "store", store: sanitizeStore(store) });
  for (const res of sseClients) {
    try { res.write(`data: ${data}\n\n`); } catch { sseClients.delete(res); }
  }
}

function getActor(req) {
  const session = getSession(req);
  if (!session) return null;
  return store.users.find((u) => u.id === session.userId) || null;
}

function sanitizeUser(u) { return u ? { id: u.id, name: u.name, role: u.role } : null; }
function sanitizeStore(s) { return { ...s, users: s.users.map(sanitizeUser) }; }
function buildPublicStore(s) {
  return {
    users: s.users.map(sanitizeUser),
    orders: [],
    inventory: [],
    activity: [],
    inventoryLog: [],
    shiftNote: { text: "", updatedAt: "", userId: "" },
  };
}

function parseCookies(req) {
  const raw = req.headers.cookie || "";
  return raw.split(";").reduce((acc, part) => {
    const idx = part.indexOf("=");
    if (idx === -1) return acc;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (key) acc[key] = decodeURIComponent(value);
    return acc;
  }, {});
}

function getSession(req) {
  const token = parseCookies(req)[SESSION_COOKIE];
  if (!token) return null;
  const session = sessions.get(token);
  if (!session) return null;
  if (session.expiresAt <= Date.now()) {
    sessions.delete(token);
    return null;
  }
  if (session.expiresAt - Date.now() < SESSION_TOUCH_MS)
    session.expiresAt = Date.now() + SESSION_TTL_MS;
  return { token, ...session };
}

function createSession(userId) {
  const token = crypto.randomBytes(32).toString("hex");
  sessions.set(token, { userId, expiresAt: Date.now() + SESSION_TTL_MS });
  return token;
}

function destroySession(token) {
  sessions.delete(token);
}

function destroyUserSessions(userId) {
  for (const [token, session] of sessions) {
    if (session.userId === userId) sessions.delete(token);
  }
}

function cleanExpiredSessions() {
  const now = Date.now();
  for (const [token, session] of sessions) {
    if (session.expiresAt <= now) sessions.delete(token);
  }
}

function setSessionCookie(res, token) {
  const parts = [
    `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`,
  ];
  if (process.env.NODE_ENV === "production") parts.push("Secure");
  res.setHeader("Set-Cookie", parts.join("; "));
}

function clearSessionCookie(res) {
  const parts = [
    `${SESSION_COOKIE}=`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    "Max-Age=0",
  ];
  if (process.env.NODE_ENV === "production") parts.push("Secure");
  res.setHeader("Set-Cookie", parts.join("; "));
}

function hashPin(pin) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(pin, salt, 64).toString("hex");
  return `scrypt:${salt}:${hash}`;
}

function verifyPin(pin, user) {
  if (!user) return false;
  if (user.pinHash) {
    const [algo, salt, hash] = String(user.pinHash).split(":");
    if (algo !== "scrypt" || !salt || !hash) return false;
    const candidate = crypto.scryptSync(pin, salt, 64);
    const target = Buffer.from(hash, "hex");
    return candidate.length === target.length && crypto.timingSafeEqual(candidate, target);
  }
  return String(user.pin || "") === pin;
}

function migrateStoreForSecurity(nextStore) {
  let changed = false;
  for (const user of nextStore.users || []) {
    if (user.pinHash) continue;
    if (typeof user.pin === "string" && user.pin) {
      user.pinHash = hashPin(user.pin);
      delete user.pin;
      changed = true;
      continue;
    }
    delete user.pin;
  }
  return changed;
}

function snapshotOrder(order) {
  return {
    item: order.item,
    location: order.location,
    qty: Number(order.qty),
    state: order.state,
    expeditionDone: order.expeditionDone,
  };
}

function orderContributesToInventory(order) {
  return !order.expeditionDone && (order.state === "stocked" || order.state === "ready");
}

function reconcileInventoryForOrder(order, direction) {
  if (!orderContributesToInventory(order)) return;
  const sign = direction === "remove" ? -1 : 1;
  adjustInventory(order.item, order.location, sign * Number(order.qty));
}

function nextOrderId() {
  const nums = store.orders.map((o) => Number(o.id.replace("OBJ-", ""))).filter(Number.isFinite);
  return `OBJ-${String(nums.length ? Math.max(...nums) + 1 : 101).padStart(3, "0")}`;
}

function pushActivity(userId, message) {
  store.activity.unshift({ id: `ACT-${Date.now()}`, userId, message, at: new Date().toISOString() });
}

function pushInventoryLog(actorId, sku, name, delta, reason) {
  if (!store.inventoryLog) store.inventoryLog = [];
  store.inventoryLog.unshift({ id: `IL-${Date.now()}`, sku, name, delta, reason, actorId, at: new Date().toISOString() });
  if (store.inventoryLog.length > 300) store.inventoryLog = store.inventoryLog.slice(0, 300);
}

function upsertInventory(name, location, qty, actorId = null, reason = "naskladnené") {
  const item = store.inventory.find((e) => e.name === name && e.location === location);
  if (item) {
    item.qty += qty;
    item.updatedAt = new Date().toISOString();
    pushInventoryLog(actorId, item.sku, name, qty, reason);
    return;
  }
  const nums = store.inventory.map((e) => Number(e.sku.replace("SKU-", ""))).filter(Number.isFinite);
  const sku = `SKU-${nums.length ? Math.max(...nums) + 1 : 200}`;
  store.inventory.unshift({ sku, name, location, qty, updatedAt: new Date().toISOString() });
  pushInventoryLog(actorId, sku, name, qty, reason);
}

function adjustInventory(name, location, delta, actorId = null, reason = null) {
  const item = store.inventory.find((e) => e.name === name && e.location === location);
  if (!item) {
    if (delta > 0) upsertInventory(name, location, delta, actorId, reason || "naskladnené");
    return;
  }
  item.qty = Math.max(item.qty + delta, 0);
  item.updatedAt = new Date().toISOString();
  const label = reason || (delta > 0 ? "príjem" : "expedícia");
  pushInventoryLog(actorId, item.sku, name, delta, label);
  if (item.qty === 0) store.inventory = store.inventory.filter((e) => e !== item);
}

function stateLabel(s) {
  return s === "machine" ? "Na stroji" : s === "stocked" ? "Naskladnené" : "Pripravené";
}

function buildSeedStore() {
  const today = new Date();
  const d = (n) => { const x = new Date(today); x.setDate(today.getDate() + n); return x.toISOString(); };
  return {
    users: [
      { id: "u-admin", name: "Admin",  role: "admin",  pinHash: hashPin("000000") },
      { id: "u-sk1",   name: "Skladník 1", role: "worker", pinHash: hashPin("1111") },
      { id: "u-sk2",   name: "Skladník 2", role: "worker", pinHash: hashPin("2222") },
    ],
    orders: [
      { id: "OBJ-101", customer: "Stavmat",    item: "Hliníkový profil 40x40", qty: 24, location: "A-01-03", shipDate: d(0),  state: "ready",   expeditionDone: false, assigneeId: "u-marek", createdAt: d(-3), updatedAt: d(0),  notes: [], hasProblem: false },
      { id: "OBJ-102", customer: "DekorSteel", item: "Montážna sada S12",       qty: 8,  location: "B-02-01", shipDate: d(1),  state: "stocked", expeditionDone: false, assigneeId: "u-jana",  createdAt: d(-2), updatedAt: d(-1), notes: [], hasProblem: false },
      { id: "OBJ-103", customer: "Kovo Max",   item: "Kryt linky M8",           qty: 12, location: "C-05-02", shipDate: d(-1), state: "ready",   expeditionDone: false, assigneeId: "u-peter", createdAt: d(-4), updatedAt: d(-1), notes: [{ id: "NOTE-1", text: "Zákazník potrebuje dodať pred 14:00!", userId: "u-marek", at: d(-1), type: "note" }], hasProblem: false },
      { id: "OBJ-104", customer: "Intermont",  item: "Nosník R45",              qty: 5,  location: "D-01-04", shipDate: d(0),  state: "machine", expeditionDone: false, assigneeId: "u-ivana", createdAt: d(-3), updatedAt: d(-3), notes: [{ id: "NOTE-2", text: "Tovar sa nenachádza na pozícii D-01-04, hľadám.", userId: "u-ivana", at: d(-1), type: "problem" }], hasProblem: true },
      { id: "OBJ-105", customer: "Ferona SK",  item: "Plech 2mm",               qty: 50, location: "A-03-01", shipDate: d(2),  state: "machine", expeditionDone: false, assigneeId: "u-jana",  createdAt: d(-1), updatedAt: d(-1), notes: [], hasProblem: false },
    ],
    inventory: [
      { sku: "SKU-210", name: "Hliníkový profil 40x40", location: "A-01-03", qty: 72, updatedAt: d(-1) },
      { sku: "SKU-347", name: "Montážna sada S12",       location: "B-02-01", qty: 18, updatedAt: d(-1) },
      { sku: "SKU-511", name: "Kryt linky M8",           location: "C-05-02", qty: 12, updatedAt: d(-2) },
    ],
    shiftNote: { text: "", updatedAt: "", userId: "" },
    inventoryLog: [],
    activity: [
      { id: "ACT-1", userId: "u-marek", message: "vytvoril objednávku OBJ-101.", at: d(-3) },
      { id: "ACT-2", userId: "u-marek", message: "zmenil OBJ-101 na Naskladnené.",  at: d(-2) },
      { id: "ACT-3", userId: "u-marek", message: "zmenil OBJ-101 na Pripravené.", at: d(0)  },
      { id: "ACT-4", userId: "u-jana",  message: "vytvoril objednávku OBJ-102.", at: d(-2) },
      { id: "ACT-5", userId: "u-jana",  message: "zmenil OBJ-102 na Naskladnené.", at: d(-1) },
      { id: "ACT-6", userId: "u-peter", message: "vytvoril objednávku OBJ-103.", at: d(-4) },
      { id: "ACT-7", userId: "u-peter", message: "zmenil OBJ-103 na Naskladnené.", at: d(-3) },
      { id: "ACT-8", userId: "u-peter", message: "zmenil OBJ-103 na Pripravené.", at: d(-1) },
    ],
  };
}
