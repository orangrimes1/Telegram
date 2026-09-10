const devices = require('../data/devices.json');

function normalize(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Free-text device lookup: exact alias match first, then substring match
// in either direction. Not fuzzy/typo-tolerant on purpose — an uncertain
// match is worse than "not found, flag to admin" per the spec.
function lookupDevice(rawInput) {
  const input = normalize(rawInput);
  if (!input) return null;

  for (const device of devices) {
    if (device.aliases.some((alias) => normalize(alias) === input)) {
      return device;
    }
  }

  // Substring pass: pick the longest matching alias across all devices, so
  // a more specific alias (e.g. "onn google tv") wins over a shorter, more
  // generic one (e.g. "google tv") regardless of which device comes first
  // in the JSON file.
  let best = null;
  let bestLength = 0;
  for (const device of devices) {
    for (const alias of device.aliases) {
      const a = normalize(alias);
      if (input.includes(a) || a.includes(input)) {
        if (a.length > bestLength) {
          best = device;
          bestLength = a.length;
        }
      }
    }
  }

  return best;
}

module.exports = { lookupDevice, normalize };
