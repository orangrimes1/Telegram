// Simple in-memory per-key cooldown. Used to stop a single Telegram user
// from rapid-firing /start (or any other action) to flood the admin group
// with duplicate notifications — not persisted across restarts, and not
// meant to be: the goal is throttling a live spam burst, not tracking
// history.
function createCooldown(windowMs) {
  const lastAt = new Map();

  return {
    isOnCooldown(key) {
      const last = lastAt.get(key);
      return last !== undefined && Date.now() - last < windowMs;
    },
    record(key) {
      lastAt.set(key, Date.now());
    },
  };
}

module.exports = { createCooldown };
