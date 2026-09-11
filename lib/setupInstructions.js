// Setup instructions keyed by device_setup_steps_ref (data/devices.json).
// Sent with parse_mode: 'HTML' — bold marks the exact menu items/app names.

const PLAYLIST_NAME = 'LumenTV';

// The Downloader code can change if Amazon delists it or it needs
// refreshing — kept in .env rather than hardcoded so it's a one-line fix.
const SMARTERS_DOWNLOADER_CODE = process.env.SMARTERS_DOWNLOADER_CODE || '(code not configured — contact the team)';

// Shared template for every sideload-based device (Firestick/Android TV
// Stick, Android TV Box, Google TV-certified): the Downloader + code +
// Smarters Pro APK mechanism is identical across all of them — only the
// "enable unknown sources" menu path differs by device.
function sideloadInstructions(enableUnknownSourcesStep) {
  return [
    enableUnknownSourcesStep,
    'Install <b>Downloader</b> from the app store (orange icon with a "D").',
    `Open Downloader, enter code <b>${SMARTERS_DOWNLOADER_CODE}</b> in the URL bar, and click Go.`,
    'Click Download, scroll to Smarters Pro APK, and install it.',
    'Open <b>IPTV Smarters Pro</b>, select <b>Xtream Codes Login</b>, and enter the server, username, playlist name, and password above.',
  ]
    .map((line, i) => `${i + 1}. ${line}`)
    .join('\n');
}

const INSTRUCTIONS = {
  firestick_sideload: sideloadInstructions(
    'On your Fire TV, go to <b>Settings → My Fire TV → Developer Options</b> and enable <b>Apps from Unknown Sources</b>.'
  ),
  android_sideload: sideloadInstructions(
    'On your Android TV box, go to <b>Settings → Device Preferences → Security & Restrictions</b> and enable <b>Unknown Sources</b>.'
  ),
  google_tv_sideload: sideloadInstructions(
    'On your Google TV device, go to <b>Settings → Apps → Security & Restrictions</b> and enable <b>Unknown Sources</b> for your browser or file manager.'
  ),
  android_app_store_install: [
    '1. Install <b>IPTV Smarters Pro</b> from the Google Play Store, open it, select <b>Xtream Codes Login</b>, and enter the details above.',
  ].join('\n'),
  ios_app_store_install: [
    '1. Install <b>GSE Smart IPTV</b> from the App Store, open it, and add a new playlist using <b>Xtream Codes Login</b>. Enter the details above.',
  ].join('\n'),
  desktop_install: [
    '1. Download <b>IPTV Smarters Pro</b> from the official desktop download, install it, select <b>Xtream Codes Login</b>, and enter the details above.',
  ].join('\n'),
};

// Human-readable section header per platform, used when a multi-device
// order needs one "Setup — X" block per unique platform among the devices.
const LABELS = {
  firestick_sideload: 'Firestick / Android TV Stick',
  android_sideload: 'Android TV Box',
  google_tv_sideload: 'Google TV Device',
  android_app_store_install: 'Android Phone/Tablet',
  ios_app_store_install: 'iPhone/iPad',
  desktop_install: 'Windows/Mac PC',
};

function getSetupInstructions(setupStepsRef) {
  return INSTRUCTIONS[setupStepsRef] || null;
}

function getSetupLabel(setupStepsRef) {
  return LABELS[setupStepsRef] || 'Your Device';
}

module.exports = { getSetupInstructions, getSetupLabel, PLAYLIST_NAME };
