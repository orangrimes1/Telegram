# LUMEN Telegram Bots — Project Status

Last updated: 2026-09-10

## Running right now

Both bots are live via `node index.js` (long polling, background process):
- **`@LumenOnboardingBot`** — full onboarding flow
- **`@LumenSupportBot`** — full support triage flow

Restart with `node index.js` (or `node index.js --only=onboard` / `--only=support` for just one) from the project root. Requires `.env` to be populated (see below) — process exits with an error if neither token is set.

## Complete

### Infrastructure
- Node + Telegraf, long polling (no webhook/server yet — deferred until hosting is chosen, per spec)
- SQLite via Node's **built-in `node:sqlite`** module (not `better-sqlite3` — that failed to compile on this machine due to a broken Xcode Command Line Tools install, missing `climits`; `node:sqlite` is functionally equivalent and avoids native compilation, but Node itself flags it "experimental")
  - `onboarding_sessions` table — one row per Telegram user, tracks step/status/device/ISP/plan through the whole flow
  - `admin_handoffs` table — tracks the three kinds of admin reply-to-message handoffs (`device_review`, `trial_credential`, `credential`)
- `data/devices.json` — 18-entry device compatibility DB across 4 categories (compatible+4K, compatible+non-4K, compatible-with-caveat/Google TV, not-compatible). Fuzzy lookup in `lib/deviceLookup.js` uses longest-alias-wins matching (fixed a real bug where a shorter generic alias like "google tv" could shadow a more specific one like "onn google tv"). Tested against 24 realistic inputs across all categories — all passing. The two Google TV entries' `note` field (sideloading/identity-verification risk) is now surfaced to customers automatically as a third message right after the compatibility confirmation, same tone/pattern as the ISP heads-up — doesn't block onboarding.
- `data/isp-flags.json` — known-problem ISP list (currently just AT&T)
- `lib/html.js` — shared HTML formatting helpers (`reply`, `sendHtml` default to `parse_mode: 'HTML'`; `escapeHtml`/`escapeHtmlAttr` for any customer- or admin-typed free text) — used by both bots, tested against adversarial input (`<script>`, raw `&`/`<`/`>`) with no breakage
- `lib/adminGroup.js` — `postToRequestTopic` / `postToSupportTopic` / `postToPaymentTopic` route to the three admin-group forum topics independently

### Onboarding bot (`bots/onboard.js`)
Full flow end-to-end, matching spec section 5 plus later revisions:
1. Welcome sets expectations up front ("this means a Firestick... smart TV apps aren't compatible on their own") before asking Yes/No
2. Device check: compatible+4K, compatible+non-4K (HD/FHD flag), incompatible (→ recommends **Fire TV Stick 4K Max** by name), unmatched (→ pauses as `awaiting_device_review`, admin resolves via reply "compatible"/"incompatible")
3. ISP question, cross-checked against the flag list
4. Device count + **pricing** shown on buttons and repeated in the payment-link message ($110 / $180 / $220, 12-month)
5. If a Firestick was recommended: pause-and-wait for purchase (persistent "continue" button; one nudge at ~2.5 days, marked `abandoned` at ~2 weeks, both resumable indefinitely)
6. **24-hour trial** requested from admin (Request topic) → trial creds forwarded with setup walkthrough → "is everything working okay?"
   - Yes → 12-month PayLio payment link (price repeated, priced per tier)
   - No → directed to `@LumenSupportBot`, admin flagged for context
7. Payment confirmed → paid 12-month credential requested from admin (Request topic) → forwarded to customer with walkthrough + **LUMEN customer group invite link** (join-request approval, per spec — only on the paid message, not the trial one)

All admin-group notifications route to `ADMIN_REQUEST_TOPIC_ID`.

### Support bot (`bots/support.js`)
- Category menu: Server down / Buffering / Login issue / Billing / Other
- Server down / Buffering are **ISP-aware**: if the customer's onboarding session has a flagged ISP, skips the generic device+restart diagnostic and asks a targeted "consistently or on and off?" question instead, going straight to a ticket (restarting doesn't fix a known ISP issue)
- All other categories: 1-2 diagnostic questions → resolved, or ticket
- Tickets pull Plan/Device/ISP from the customer's onboarding session automatically when it exists (so the team isn't re-asking basics, per spec §6)
- All tickets route to `ADMIN_SUPPORT_TOPIC_ID`

### Style pass (both bots)
HTML formatting throughout: bold on device names/plan labels/key terms, short lines with blank-line breaks, credentials/server URL in monospace (tap-to-copy), payment link as a clickable "Pay now" instead of a raw URL, consistent tone (periods over exclamation points except genuine good news), emoji restricted to status tags (🆓 💳 ⚠️ ✅ 🎫 ℹ️) — no decorative emoji.

### Admin group wiring
- Group: `AdminLumen` (chat id `-1003905162486`)
- Three forum topics, currently: Request = `22`, Support = `23`, Payment = `64` (Request/Support topics were deleted and recreated once already mid-project — IDs updated accordingly; if this happens again, the temporary debug-logging pattern used each time is: add a `bot.use()` middleware in `bots/onboard.js` logging `ctx.chat.id` / `ctx.message.message_thread_id`, restart, read a test message from each topic in the log, then remove it)
- **Payment link handoff**: replaced the static per-tier PayLio links entirely with a manual per-order flow, same reply-to-message pattern as credentials. When a customer's trial works, the bot posts a request to the Payment topic (plan + price); the admin replies with the actual PayLio link; the bot validates it looks like a URL and forwards it to the customer as a clickable "Pay now" link. `admin_handoffs` now has a fourth `kind`: `payment_link` (alongside `device_review`, `trial_credential`, `credential`).

## Incomplete / outstanding

- ~~`XTREAM_SERVER_URL` empty~~ — set to `cf.ocean1738.com`. Credential messages now show the real server address.
- **Live end-to-end test in a real Telegram chat** — not yet completed successfully. A first attempt (replying to a trial-credential request in the Request topic) silently failed to forward — root cause was **data loss, not a code bug**: my own test-cleanup commands (`rm -f data/lumen.sqlite3*`) deleted the live bot's database while the live process was still running against it, wiping the pending `admin_handoffs` row before the reply could match it. Fixed: `db/index.js` now supports a `LUMEN_DB_PATH` env override so test scripts use an isolated throwaway path (or `:memory:`) and never touch the live file again; `handleAdminHandoffReply` now logs a `console.warn` on any unmatched reply instead of returning silently, so this class of issue is visible going forward. Live test needs to be redone from scratch since the prior session data is gone.
- **Support bot "known issue" auto-reply flag** (spec §6: a flippable flag/pinned message so confirmed outages auto-reply instead of opening duplicate tickets) — not built. Scoped out as beyond "basic" for v1.
- **Support bot ISP list / category-routing config** — explicitly deferred by the user this session ("don't touch it this round"). Still just AT&T in `data/isp-flags.json`.
- ~~Git: no commits~~ — initial commit `20e46f8` made. Note: `.gitignore` originally only excluded the exact `data/lumen.sqlite3` filename, missing its `-shm`/`-wal` sidecar files (which can hold session/credential fragments) — fixed to `data/lumen.sqlite3*` before this commit.
- **Deferred per spec §9 (not v1)**: concurrent-stream enforcement on the Xtream panel, automated credential creation via panel API, AT&T/Cloudflare ISP block workaround, automated PayLio payment confirmation (webhook-equivalent).
- **Webhooks / hosting**: still long polling only, as planned — switch to webhooks once a host (Railway/Render/Fly.io, or a VPS) is chosen.

## Known environment quirk

`better-sqlite3` cannot currently be installed on this machine (Xcode Command Line Tools are missing `climits` and other C++ standard headers). The project uses `node:sqlite` instead, which works but is Node's own "experimental" module. If the CLT install gets fixed later, switching to `better-sqlite3` would be a drop-in-ish replacement (same synchronous prepare/run/get/all shape, minor param-binding differences already isolated to `db/index.js`).
