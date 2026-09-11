const devices = require('../data/devices.json');

function normalize(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function exactOrAliasMatch(input) {
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

// ---- Family-level fallback --------------------------------------------
//
// Real-world inputs constantly include trims/variants we haven't seeded
// ("fire tv 4k select", "onn 4k pro 2024", "shield tube 2019 edition").
// Rather than sending every unrecognized variant to admin review, if the
// text carries a strong brand/family signal, resolve it to that family's
// general compatibility profile — flagged as an unrecognized variant so
// the customer knows the exact model wasn't matched. Admin review is
// reserved for input with no recognizable family signal at all.

const GOOGLE_TV_NOTE =
  "Heads up — Google has been tightening sideloading requirements on certified <b>Google TV</b> devices this year, which could affect this device down the line.\n\nThere's nothing you need to do on your end. We're monitoring it, and your onboarding continues as normal.";

function familyNote(familyLabel, extra) {
  const base = `We didn't recognize that exact model, but it looks like a <b>${familyLabel}</b> device, so we've treated it as compatible.\n\nIf it turns out to be an unusual variant, we'll follow up.`;
  return extra ? `${base}\n\n${extra}` : base;
}

function resolveFireTvFamily(input) {
  const isCube = /\bcube\b/.test(input);
  const is4k = /4k/.test(input);

  if (isCube) {
    return {
      id: 'fire_tv_cube',
      display_name: 'Fire TV Cube (unrecognized variant)',
      compatible: true,
      '4k_supported': true,
      platform: 'Fire OS',
      app_to_install: 'IPTV Smarters Pro',
      setup_steps_ref: 'firestick_sideload',
      note: familyNote('Fire TV Cube'),
    };
  }

  return {
    id: is4k ? 'fire_tv_stick_4k' : 'fire_tv_stick_hd',
    display_name: `Fire TV Stick${is4k ? ' 4K' : ''} (unrecognized variant)`,
    compatible: true,
    '4k_supported': is4k,
    platform: 'Fire OS',
    app_to_install: 'IPTV Smarters Pro',
    setup_steps_ref: 'firestick_sideload',
    note: familyNote('Fire TV Stick'),
  };
}

function resolveOnnFamily(input) {
  const isPro = /\bpro\b/.test(input);
  const isPlus = /\bplus\b/.test(input);
  const is4k = /4k/.test(input);
  const fourK = isPro || isPlus || is4k;
  const label = isPro ? 'Onn 4K Pro' : isPlus ? 'Onn 4K Plus' : is4k ? 'Onn 4K' : 'Onn';

  return {
    id: 'onn_family',
    display_name: `${label} (unrecognized variant)`,
    compatible: true,
    '4k_supported': fourK,
    platform: 'Google TV',
    app_to_install: 'IPTV Smarters Pro',
    setup_steps_ref: 'google_tv_sideload',
    note: familyNote('Onn streaming', GOOGLE_TV_NOTE),
  };
}

function resolveShieldFamily() {
  return {
    id: 'nvidia_shield',
    display_name: 'NVIDIA Shield (unrecognized variant)',
    compatible: true,
    '4k_supported': true,
    platform: 'Android TV',
    app_to_install: 'IPTV Smarters Pro',
    setup_steps_ref: 'android_sideload',
    note: familyNote('NVIDIA Shield'),
  };
}

function resolveGoogleTvFamily() {
  return {
    id: 'google_tv_certified_generic',
    display_name: 'Google TV device (unrecognized variant)',
    compatible: true,
    '4k_supported': true,
    platform: 'Google TV',
    app_to_install: 'IPTV Smarters Pro',
    setup_steps_ref: 'google_tv_sideload',
    note: familyNote('Google TV-certified', GOOGLE_TV_NOTE),
  };
}

function resolveRokuFamily() {
  return {
    id: 'roku',
    display_name: 'Roku (unrecognized variant)',
    compatible: false,
    '4k_supported': false,
    platform: 'Roku OS',
    app_to_install: null,
    setup_steps_ref: null,
  };
}

function resolveAppleTvFamily() {
  return {
    id: 'apple_tv',
    display_name: 'Apple TV (unrecognized variant)',
    compatible: false,
    '4k_supported': false,
    platform: 'tvOS',
    app_to_install: null,
    setup_steps_ref: null,
  };
}

function resolveSmartTvFamily() {
  return {
    id: 'generic_smart_tv',
    display_name: 'Smart TV (unrecognized variant)',
    compatible: false,
    '4k_supported': false,
    platform: 'Native Smart TV',
    app_to_install: null,
    setup_steps_ref: null,
  };
}

// Checked in order after the exact/alias pass fails. Only one fires — the
// first whose signal matches.
const FAMILY_SIGNALS = [
  { test: (i) => /\bfire\s*tv\b/.test(i) || /\bfire\s*stick\b/.test(i), resolve: resolveFireTvFamily },
  { test: (i) => /\bonn\b/.test(i), resolve: resolveOnnFamily },
  { test: (i) => /\bshield\b/.test(i), resolve: resolveShieldFamily },
  { test: (i) => /\bchromecast\b/.test(i) || /\bgoogle\s*tv\b/.test(i), resolve: resolveGoogleTvFamily },
  { test: (i) => /\broku\b/.test(i), resolve: resolveRokuFamily },
  { test: (i) => /\bapple\s*tv\b/.test(i), resolve: resolveAppleTvFamily },
  { test: (i) => /\bsmart\s*tv\b/.test(i), resolve: resolveSmartTvFamily },
];

// Free-text device lookup: exact alias match, then longest-substring alias
// match, then a family-level fallback for recognizable brand signals that
// didn't hit a seeded model. Only genuine gibberish or an unknown brand
// falls through to null (admin review).
function lookupDevice(rawInput) {
  const input = normalize(rawInput);
  if (!input) return null;

  const exact = exactOrAliasMatch(input);
  if (exact) return exact;

  for (const signal of FAMILY_SIGNALS) {
    if (signal.test(input)) return signal.resolve(input);
  }

  return null;
}

module.exports = { lookupDevice, normalize };
