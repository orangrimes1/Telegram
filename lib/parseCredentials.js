// Parses the admin-group reply for Xtream credentials.
// Expected format (case-insensitive), one per line:
//   username: john123
//   password: xk29fa
// Also accepts "user:" / "pass:" / "pwd:" as labels.
function parseCredentials(text) {
  if (!text) return null;

  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  let username = null;
  let password = null;

  for (const line of lines) {
    const match = line.match(/^(username|user|password|pass|pwd)\s*:\s*(.+)$/i);
    if (!match) continue;
    const label = match[1].toLowerCase();
    const value = match[2].trim();
    if (label === 'username' || label === 'user') username = value;
    if (label === 'password' || label === 'pass' || label === 'pwd') password = value;
  }

  if (!username || !password) return null;
  return { username, password };
}

module.exports = { parseCredentials };
