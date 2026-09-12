const path = require('path');
const { DatabaseSync } = require('node:sqlite'); // built-in, experimental as of Node 22+

// LUMEN_DB_PATH override exists so test/simulation scripts can point at a
// throwaway file (or ':memory:') instead of ever touching the live bot's
// database — set it before requiring this module, never delete
// data/lumen.sqlite3 directly while the live bot might be running against it.
const DB_PATH = process.env.LUMEN_DB_PATH || path.join(__dirname, '..', 'data', 'lumen.sqlite3');

const db = new DatabaseSync(DB_PATH);
if (DB_PATH !== ':memory:') {
  db.exec('PRAGMA journal_mode = WAL');
}

db.exec(`
  CREATE TABLE IF NOT EXISTS onboarding_sessions (
    telegram_user_id       INTEGER PRIMARY KEY,
    telegram_username      TEXT,
    step                   TEXT NOT NULL DEFAULT 'new',
    status                 TEXT NOT NULL DEFAULT 'active',
    device_input           TEXT,
    device_key             TEXT,
    device_display_name    TEXT,
    device_compatible      INTEGER,
    device_4k_supported    INTEGER,
    device_platform        TEXT,
    device_app_to_install  TEXT,
    device_setup_steps_ref TEXT,
    device_unmatched       INTEGER NOT NULL DEFAULT 0,
    recommend_firestick    INTEGER NOT NULL DEFAULT 0,
    devices_json           TEXT, -- JSON array of resolved devices, only populated for 2+ device orders (device 1 stays in the columns above for single-device orders)
    pending_device_index   INTEGER, -- which device (2 or 3) is currently being asked about, while collecting a multi-device order
    isp_input              TEXT,
    isp_flagged            INTEGER NOT NULL DEFAULT 0,
    plan_tier              INTEGER,
    awaiting_device_since  TEXT,
    device_nudge_sent_at   TEXT,
    admin_message_id       INTEGER,
    created_at             TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at             TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS admin_handoffs (
    admin_message_id  INTEGER PRIMARY KEY,
    kind              TEXT NOT NULL DEFAULT 'credential', -- 'credential' | 'trial_credential' | 'payment_link' | 'support_fix'
    telegram_user_id  INTEGER NOT NULL,
    plan_tier         INTEGER,
    device_key        TEXT,
    device_display_name TEXT,
    raw_device_input  TEXT,
    device_slot_index INTEGER, -- unused (no more device-review handoffs); kept for schema stability
    needs_walkthrough INTEGER NOT NULL DEFAULT 0,
    status            TEXT NOT NULL DEFAULT 'pending',
    created_at        TEXT NOT NULL DEFAULT (datetime('now')),
    fulfilled_at      TEXT
  );
`);

// Lightweight migration for columns added after a database already exists —
// CREATE TABLE IF NOT EXISTS is a no-op on an existing table, so new columns
// need to be added explicitly rather than assuming a fresh DB.
function ensureColumn(table, column, definition) {
  const existing = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!existing.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

ensureColumn('onboarding_sessions', 'devices_json', 'TEXT');
ensureColumn('onboarding_sessions', 'pending_device_index', 'INTEGER');
ensureColumn('admin_handoffs', 'device_slot_index', 'INTEGER');

function getSession(telegramUserId) {
  return db.prepare('SELECT * FROM onboarding_sessions WHERE telegram_user_id = ?').get(telegramUserId);
}

function ensureSession(telegramUserId, telegramUsername) {
  const existing = getSession(telegramUserId);
  if (existing) {
    if (telegramUsername && telegramUsername !== existing.telegram_username) {
      db.prepare('UPDATE onboarding_sessions SET telegram_username = ? WHERE telegram_user_id = ?')
        .run(telegramUsername, telegramUserId);
    }
    return getSession(telegramUserId);
  }
  db.prepare(`
    INSERT INTO onboarding_sessions (telegram_user_id, telegram_username, step, status)
    VALUES (?, ?, 'new', 'active')
  `).run(telegramUserId, telegramUsername || null);
  return getSession(telegramUserId);
}

// Plain /start always begins a brand new onboarding session — wipes any
// prior in-progress state (device picks, plan tier, ISP, etc.) for this
// Telegram user ID rather than resuming it. Only the support-bot resume
// deep link (/start?start=resume) should pick up where a session left off,
// via ensureSession/getSession instead of this.
function resetSession(telegramUserId, telegramUsername) {
  db.prepare(`
    INSERT INTO onboarding_sessions (
      telegram_user_id, telegram_username, step, status,
      device_input, device_key, device_display_name, device_compatible,
      device_4k_supported, device_platform, device_app_to_install,
      device_setup_steps_ref, device_unmatched, recommend_firestick,
      devices_json, pending_device_index, isp_input, isp_flagged,
      plan_tier, awaiting_device_since, device_nudge_sent_at, admin_message_id
    ) VALUES (?, ?, 'new', 'active', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 0, 0, NULL, NULL, NULL, 0, NULL, NULL, NULL, NULL)
    ON CONFLICT(telegram_user_id) DO UPDATE SET
      telegram_username = excluded.telegram_username,
      step = 'new',
      status = 'active',
      device_input = NULL,
      device_key = NULL,
      device_display_name = NULL,
      device_compatible = NULL,
      device_4k_supported = NULL,
      device_platform = NULL,
      device_app_to_install = NULL,
      device_setup_steps_ref = NULL,
      device_unmatched = 0,
      recommend_firestick = 0,
      devices_json = NULL,
      pending_device_index = NULL,
      isp_input = NULL,
      isp_flagged = 0,
      plan_tier = NULL,
      awaiting_device_since = NULL,
      device_nudge_sent_at = NULL,
      admin_message_id = NULL,
      updated_at = datetime('now')
  `).run(telegramUserId, telegramUsername || null);
  return getSession(telegramUserId);
}

function updateSession(telegramUserId, fields) {
  const keys = Object.keys(fields);
  if (keys.length === 0) return;
  const setClause = keys.map((k) => `${k} = ?`).join(', ');
  const values = keys.map((k) => {
    const v = fields[k];
    return v === undefined ? null : v;
  });
  db.prepare(`
    UPDATE onboarding_sessions
    SET ${setClause}, updated_at = datetime('now')
    WHERE telegram_user_id = ?
  `).run(...values, telegramUserId);
}

function findStaleAwaitingDevicePurchase({ nudgeThresholdHours, abandonThresholdHours }) {
  const nudgeCandidates = db.prepare(`
    SELECT * FROM onboarding_sessions
    WHERE status = 'awaiting_device_purchase'
      AND device_nudge_sent_at IS NULL
      AND awaiting_device_since <= datetime('now', ?)
  `).all(`-${nudgeThresholdHours} hours`);

  const abandonCandidates = db.prepare(`
    SELECT * FROM onboarding_sessions
    WHERE status = 'awaiting_device_purchase'
      AND awaiting_device_since <= datetime('now', ?)
  `).all(`-${abandonThresholdHours} hours`);

  return { nudgeCandidates, abandonCandidates };
}

function createAdminHandoff({
  adminMessageId,
  kind = 'credential',
  telegramUserId,
  planTier,
  deviceKey,
  deviceDisplayName,
  rawDeviceInput,
  deviceSlotIndex,
  needsWalkthrough,
}) {
  db.prepare(`
    INSERT INTO admin_handoffs (admin_message_id, kind, telegram_user_id, plan_tier, device_key, device_display_name, raw_device_input, device_slot_index, needs_walkthrough, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')
  `).run(
    adminMessageId,
    kind,
    telegramUserId,
    planTier || null,
    deviceKey || null,
    deviceDisplayName || null,
    rawDeviceInput || null,
    deviceSlotIndex || null,
    needsWalkthrough ? 1 : 0
  );
}

function getAdminHandoffByMessageId(adminMessageId) {
  return db.prepare('SELECT * FROM admin_handoffs WHERE admin_message_id = ?').get(adminMessageId);
}

// Used to dedup admin-group notifications: if this user already has a
// pending handoff of this kind, reuse it instead of posting a duplicate
// (e.g. from rapidly restarting onboarding to re-trigger a trial request).
function getPendingHandoff(telegramUserId, kind) {
  return db
    .prepare(
      `SELECT * FROM admin_handoffs WHERE telegram_user_id = ? AND kind = ? AND status = 'pending' ORDER BY created_at DESC LIMIT 1`
    )
    .get(telegramUserId, kind);
}

function markAdminHandoffFulfilled(adminMessageId) {
  db.prepare(`
    UPDATE admin_handoffs SET status = 'fulfilled', fulfilled_at = datetime('now')
    WHERE admin_message_id = ?
  `).run(adminMessageId);
}

module.exports = {
  db,
  getSession,
  ensureSession,
  resetSession,
  updateSession,
  findStaleAwaitingDevicePurchase,
  createAdminHandoff,
  getAdminHandoffByMessageId,
  getPendingHandoff,
  markAdminHandoffFulfilled,
};
