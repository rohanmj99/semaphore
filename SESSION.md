# Semaphore — Session Continuity Log

Purpose: if a session ends (context limit), the next session reads this file to resume.
Update this file at the end of every working session. Dates below are session dates.

---

## Latest state — 2026-08-15 — LIGHT RECEIVE EXPERIENCE UPGRADED (camera box, front/back switch, re-broadcast continuity, custom QR design; last commit TBD)

### 2026-08-15 — light receive flow overhaul (user request: "fix the light part")
- **Camera box everywhere on the receive path** (listen/waiting/transfer screens): live preview inside a frame with an animated scan line, corner guides, a live status line ("Scanning for QR codes…" → "QR spotted — keep it in frame" via `lastDecodeMs`), and instruction text ("Point the camera at the other screen's flashing QR codes…"). Previously the receive screens had a bare `aria-hidden` preview div on the listen screen and NO camera feedback at all on waiting/transfer.
- **Front/back camera selection**: `startCameraDecoder` now takes `facing` and returns `switchCamera()`/`facing()`/`attachPreview(el)`/`lastDecodeMs()`; `LightTransport`, `LightScanHandle`, `LightMatcher`, `MatcherLike`, `ReceiveController` all delegate. UI: "Use front/back camera" buttons on the listen, waiting and transfer screens.
- **Continuity — transfer no longer lost**: both broadcast channels (light `advertiseLight`, sound `advertiseSound`) gained `reannounce()`; `SendController.resend()` + a "Broadcast again" button on the sender's done screen re-announces the session (resets matched state, restarts the announce cycle) so the receiver can re-match and receive a missed transfer. Receiver's waiting/transfer screens also warn when no QR has been decoded for a while ("No QR seen — point the camera back…", sender repeats everything).
- **Error checks / verification**: receiver done screen now shows a green "File verified — checksum {hash}" box instead of the bare `hashbox`; sender keeps its checksum display.
- **Custom QR design**: `paintQr` gained a `QrDesign` (ink/paper colors + rounded modules, clamped 0–0.5) that stays jsQR-decodable (tests prove round-trip); `QrCard` renders the branded "SEMA·PHORE" style — deep ink `[23,20,36]` on warm paper `[248,246,240]`, rounded modules, framed card with radial accent + wordmark. The module grid itself is unchanged, so any scanner (and the app's own decoder) still reads it.
- New tests: custom-design round-trip decode + rounding clamp (light.test.ts), `advertiseLight.reannounce` + `matchLightSession` camera controls (light-pipeline.test.ts). **120 tests pass, typecheck clean, build clean.**
- Pending: commit + push from vercel-deploy, verify on live. Root tree is not git — always sync changed files over to `vercel-deploy` before committing.

### Previous chapters (2026-08-15) — ONLINE E2E FULLY GREEN (all four production bugs fixed; last commit fba435d)

### 2026-08-15 — online transfer works end-to-end against production (mailbox + WebRTC), 2/2 E2E runs green
- **Verified live (semaphore-tau.vercel.app), two-browser Playwright E2E, twice consecutively**: `A: 100% | Sent | hello.txt` / `B: 100% | Received | hello.txt | 1.8 KB | checksum`. Full handshake works: announce → words check → match → go/ready → offer/answer/ice via the mailbox → WebRTC data channel → encrypted transfer. The online mode is DONE.
- **Bug #4 — ICE candidate exchange was inverted (`fba435d`)**: `core/webrtc.ts` pollIce skipped `msg.from === (role === "initiator" ? "s" : "r")` — i.e. each side skipped the PEER's candidates and applied its OWN. Neither side ever added the other's trickled candidates to its PC → ICE stuck at `checking` → 30 s connect timeout. One-character fix (`"s" : "r"` → `"r" : "s"`, skip own). The old unit test only asserted `iceReceived.length > 0` (passes either way) — now FakePeerConnection tags candidates per side (`pcA-*/pcB-*`) and the test asserts each side receives ONLY the other's. Verified the strengthened test fails on the old code (1 failed) and passes after the fix.
- **Bug #3 — Upstash REST envelope (`4e10b59`)**: every Upstash REST command returns `{"result": ...}`; `kvFetch` returned the whole object, so `Array.isArray({result:[...]})` was false → `zrange`/`ttl` reads always returned empty while `zadd` writes persisted (user's Upstash console showed all scores = 1 → `i` always computed as 1). Fixed in BOTH `api/mailbox.ts` and `core/mailbox-store.ts`; test mock now returns the `{ result: [...] }` envelope. Verified against the real Upstash (`zrange` returns members, `ttl` = 600) and live (`POST` → `{"i":1}`, `GET` → entry read back with declining TTL).
- **Bug #2 — Upstash auth (`6d5d387`)**: `?API_KEY=` query → 401 WRONGPASS; `Authorization: Bearer <token>` header works. Fixed in both files + test asserts the header.
- **Bug #1 — service worker cached the first empty poll forever (`a3e3984`)**: `public/sw.js` now `semaphore-v3` and NEVER intercepts `/api/` GETs (the SW was caching `/api/mailbox` GET responses — the first empty poll response cached permanently → the poller was stuck reading a stale empty page).
- **KV envs are set** (user added `KV_REST_API_URL`/`KV_REST_API_TOKEN` in Vercel); function reads them at runtime. `KV_REST_API_URL=https://powerful-blowfish-116783.upstash.io`, token starts `gQAAAAAAAcgvAAIgcDE2...` — **NOTE: the full token was pasted into chat earlier — recommend rotating it.** `.env.local` is gitignored (verified, never committed).
- **Mailbox store**: KV with per-instance memory fallback + one-time `console.error("[mailbox] KV store failed (...)")` when KV throws (`2cdbd91`).
- **Root cause of this whole round** (from earlier sessions): `core/mailbox.ts` cursor semantics are correct (first poll has no tail → returns everything; `since = lastSeen` only after entries are seen) — the failures were purely the four bugs above, each verified independently against production.
- Diagnosis trail: two-browser E2E harness (Playwright) with full mailbox REQ/RES-body logging + an injected `RTCPeerConnection` tracker (states/candidates/events) + a bare two-page RTC test (no app code) that CONNECTED in 4 ms — proving the environment (WARP VPN on this machine, host 172.16.0.2 / egress 104.28.155.90) was fine and the app's negotiation was the problem. Bare test script pattern lives in git history of the session only.
- **Cleanup done**: removed the untracked harness files from `vercel-deploy` (`e2e-online.cjs`, `rtc-bare.cjs`, `kv-check.mjs` — the latter contained the Upstash token — plus log files); removed `e2e-online.cjs` from git history via `git rm --cached` (it had been accidentally committed in `ed71b8d`); clean working tree.
- 116 tests, typecheck clean, build clean. Live bundle currently `assets/index-9PdN6ACd.js`, sw.js v3.

### Previous chapters (2026-08-14) — light/sound fixes and mailbox rebuild (pushed 4df5726, a3db1fc, d1ac5f4, ed71b8d)
- **Routing root cause (why `/api/mailbox/ping` 404'd on live):** on THIS Vercel project, catch-all files deploy as SINGLE-segment routes: `api/mailbox/[...route].ts` → matches `/api/mailbox/*` only; top-level `api/[...route].ts` → matches `/api/:route` (that's why `/api/mailbox` worked as a path after moving it up, but `/api/mailbox/<sid>/<kind>` → router NOT_FOUND). Verified via `GET /api/mailbox/zzz?route=ping` → `200 {"ok":true}` (handler fine, routing mangled) and OPTIONS echoing the current CORS headers (deployed code IS current — user confirmed production not stale).
- **Fix:** flat `api/mailbox.ts` at exact path `/api/mailbox`; handler reads `req.query.path` (set by the rewrite) with `req.query.route` fallback; `vercel.json` rewrite `{"source": "/api/mailbox/(.*)", "destination": "/api/mailbox?path=$1"}` placed BEFORE the SPA rewrite; deleted `api/mailbox/[...route].ts`, `api/mailbox-store.ts` (was a 500 function), `api/mailbox.test.ts`. Rewrites preserve the original query string (verified live: `?since=1` honored).
- **Client change:** `core/mailbox.ts` uses query-style URLs (`/api/mailbox?route=<sid>&route=<kind>`); `createHttpMailbox` gained `routePrefix: string[] = []`; `mailboxForSession` = `createHttpMailbox(API_BASE, undefined, undefined, [sessionId])` (path-prefixed `<sid>` URLs would 404 under the rewrite — commit d1ac5f4 fixed exactly this regression). `scripts/dev-mailbox.ts` parses `route`/`path` query params.
- **Live-verified:** `/api/mailbox?route=ping` AND `/api/mailbox/ping` → `200 {"ok":true}`; `/api/mailbox/<sid>/announce` GET/POST both work; PowerShell curl gotcha: `-d '{"p":"..."}'` mangles quotes — use `--data-binary @body.json`.
- **NEW: storage is per-instance memory → online pairing flaky in production.** Two-browser live E2E (`e2e-online.cjs`): A's announce reachable, B confirms words → peer `{"t":"match"}` stored (seen once, vanished next run) → A's poller never matches because B's POST and A's GET land on different Vercel function instances; each instance has its own in-memory store (burst POST→GET sometimes misses). `MemoryMailboxStore` is the default because `KV_REST_API_URL`/`KV_REST_API_TOKEN` are NOT set in the Vercel project.
- **KV code bug fixed (pushed ed71b8d):** `kvFromEnv()` discarded the key (`_key` param ignored) — every Upstash REST call lacked the key in the URL path (`/zrange/<start>/<stop>` instead of `/zrange/<key>/<start>/<stop>`), so KV would 500 if envs were ever set. Fixed in BOTH `api/mailbox.ts` (deployed) and `core/mailbox-store.ts`; added `kvFromEnv` URL-shape test + `KvMailboxStore` route test (116 tests, typecheck clean, build clean).
- **BLOCKED — needs the user's Vercel dashboard:** create an Upstash Redis database (Vercel Marketplace → Upstash integration is easiest) and set `KV_REST_API_URL` + `KV_REST_API_TOKEN` in the project env vars, then redeploy. The function then uses shared storage (`KvMailboxStore`) and online pairing becomes consistent. Until then: online link mode works but the match handshake is unreliable (memory store per instance); loopback/light/sound are unaffected.
- **Light/sound transfer remains fixed (4df5726):** verified live, two browsers, `assets/index-CzwDTvD6.js` (before the latest frontend rebuilds).

---

### 2026-08-14 late — root cause #3: MessageSink re-parsed unwrapped frames; light/sound transfers never completed (pushed 4df5726)
- **Symptom (user report)**: receiver stuck on "Waiting for the sender to start" after the match QR; sender flashes its QR burst; no data ever arrives.
- **Cause**: `MessageSink` (core/session.ts, used by `StreamSender.run` AND `StreamReceiver.start`) pushed every delivered frame through its own `FrameParser`, assuming raw bytes. `LightTransport.onMessage` / `SoundTransport.onMessage` deliver UNWRAPPED complete frames (contract: loopback/WebRTC raw, QR/sound unwrapped). Re-parsing an unwrapped frame threw `Error: frame too large` (frames.ts:22) inside the transport's handler-dispatch loop; the matcher's go/hello handler ran first (transition), then the throw killed the hello before `StreamReceiver` ever saw it → stuck "Connecting" → "The sender didn't respond. Try again." after the 30 s header timeout. This affected ALL real light AND sound transfers (loopback/online were raw → unaffected).
- **Fix** (core/session.ts MessageSink.attach): `parseMessage(frame)` first (raw frames start with 0x00 length byte → never valid JSON, so parse-first is safe); fall back to `parser.push(frame)` for raw/piecewise delivery; parser reset on failure; consumer errors isolated.
- **Also fixed**:
  - Sender re-sends the header every 4 chunks in `pumpNoAck` (noAck mode) so receivers that start scanning mid-transfer sync within the receiver's 30 s header timeout; `StreamReceiver` accepts the header only once (ignores repeats).
  - Broadcast phase now tracked on stats so the sender's UI shows "Sending"/"Repairing" instead of "Connecting" during the whole transfer.
  - `SendFlow` "Start sending" onClick overwrote the transfer screen with "waiting" (React batching — `confirmMatch()` fires `onTransferring()` synchronously, then the click's `setSender({screen:"waiting"})` won). Broadcast channels now go straight to `transfer`.
- **Diagnosis trail**: two-browser E2E harness (getImageData injection mirroring each device's real QrCard canvas) showed sender sends go→hello→chunks on the display transport, receiver scans continuously but never got the header; `[DBG]` logs in StreamReceiver showed the delivered hello reached the matcher but `acceptHeader` was never reached → the MessageSink throw. Node regression test (`core/qr/light-pipeline.test.ts`) reproduced the whole pipeline with REAL keys + QR round-trip: green only after the fix.
- **Harness gotcha**: the mirror originally downscaled the sender canvas to 640×480, blurring dense chunk QRs (jsQR failed → false "stuck") — draw at natural size instead; go/hello (few modules) still decoded, chunk QRs (2 px modules) did not.
- **Verification**: 112/112 tests (new `core/qr/light-pipeline.test.ts` + updated noAck expectations for periodic hellos), typecheck clean, build ok; two-browser E2E against `vite preview`: receiver completes "100% | Received | hello.txt", sender shows "Sending" on the transfer screen. Pushed `4df5726` (5 files, +163/−12). Vercel auto-rebuild pending — verify live bundle updated before concluding.
- **Api STILL stale after redeploy (unchanged)**: `/api/mailbox/ping` → function 404 `{"error":"not found"}`; deployed function matches only ONE segment after `/api/mailbox/` — NOT the committed catch-all `api/mailbox/[...route].ts`. Production function set survives every rebuild — needs the user's Vercel dashboard (Git integration / root directory / Functions tab) or a forced redeploy; CLI on this machine is logged out. Impact: `probeMailbox` fails → online link mode disabled (graceful), console 404 noise.

---
- **Symptom**: after the scanner-start fix, the camera preview ran and frames *decoded* (verified via page-injected jsQR on the app's own `getImageData` pixels), but no session ever appeared and `JSON.parse` was never reached in the app.
- **Cause**: `LightTransport.onMessage` / `SoundTransport.onMessage` already unwrap the wire framing (u32be length prefix) before delivery, but the pairing handlers ran each delivered frame through a **second** `FrameParser` (`for (const f of parser.push(frame))`). The first 4 bytes of the JSON (`{"t` / `{"se`) were read as a length header → `readU32be` = ~2 GB → `throw new Error("frame too large")` → the exception bubbled back into the camera tick's try/catch and was silently swallowed. Every announcement dropped. Affected: `advertiseLight`, `matchLightSession`, `scanLightSessions` (core/qr/light.ts) and `advertiseSound`, `matchSoundSession`, `scanSoundSessions` (core/modem/sound.ts). `pairing.ts` (BroadcastChannel/loopback) was CORRECT — those transports deliver raw bytes and consumers parse.
- **Why tests didn't catch it**: unit tests cover transport-level delivery (feedImage → onMessage) and the modem codec, but none exercised the pairing handlers' onMessage path.
- **Fix**: removed the redundant `FrameParser` from all six handlers; `JSON.parse(new TextDecoder().decode(frame))` directly on the delivered frame (single-message contract). Also `.catch()` on `video.play()` in `startCameraDecoder` (toggle-off caused an unhandled `play()` interruption rejection → pageerror).
- **Diagnosis trail**: page-instrumented `getImageData` (decodes OK) → patched `JSON.parse` (0 calls) → DBG logs in source showed `decodeQr OK 198B → reassembler 192B → parser 1 frame, handlers 1` then `decodeQr THREW` with `Error: frame too large at FrameParser.push` — the handler's second parser. Reproduced identically on localhost `vite preview` (also discovered repo `dist/` was stale — `dist` is untracked, rebuild before preview).
- Also synced root tree: `api/mailbox-store.ts` + `api/mailbox.test.ts` existed only in `vercel-deploy` (git repo) — copied to root so both trees run 111 tests.
- Verification: typecheck clean, 111/111 tests pass, build ok, in both trees; full live Playwright test vs localhost preview: **ALL CHECKS PASSED** (sender QR decodes → receiver preview plays/persists → session appears tagged "screen flash", words match → match screen → match QR decodes, sid matches → toggle-off releases camera → no page errors).
- Pushed `580ebf7` (2 files, +98/−111). Vercel rebuilt (frontend now `index-CJC-1lAl.js`) and the full live test vs semaphore-tau.vercel.app passes every functional check (session appears, match flow, no page errors). Only remaining noise: console 404 from the api ping probe.
- **Api STILL stale after redeploy**: `/api/mailbox/ping` → function 404 `{"error":"not found"}` (etag `W/"15-3jlv4LtvSUoQruAmr3ef7Px06u0"`, identical to before today's pushes); `/api/mailbox` and `/api/mailbox/<sid>/<kind>` → Vercel ROUTER `NOT_FOUND` (no function matched); `/api/mailbox/zzz` (single segment) → function 404. The deployed function matches exactly ONE segment after `/api/mailbox/` — i.e. NOT the committed catch-all `api/mailbox/[...route].ts` (which has existed in every commit: e248109 → 47226d5 → 9a758c2 → HEAD) and NOT the e248109-era catch-all (which did route 2-segment paths, crashing on the old `mailbox-store` import). The production function set appears to come from a DIFFERENT/older project state and survives every rebuild. Local route verified correct (ping → 200, esbuild zero runtime imports). **Next step requires the user's Vercel dashboard**: check the project's Git integration / root directory / Functions tab (function build errors), or force a redeploy — CLI on this machine is logged out. Impact of the stale function: `probeMailbox` fails → online link mode disabled (graceful), console 404 noise on page load.

---

### 2026-08-14 late — root cause #2 found: pairing handlers double-unwrapped frames (pushed 580ebf7)
- **Symptom**: after the scanner-start fix, the camera preview ran and frames *decoded* (verified via page-injected jsQR on the app's own `getImageData` pixels), but no session ever appeared and `JSON.parse` was never reached in the app.
- **Cause**: `LightTransport.onMessage` / `SoundTransport.onMessage` already unwrap the wire framing (u32be length prefix) before delivery, but the pairing handlers ran each delivered frame through a **second** `FrameParser` (`for (const f of parser.push(frame))`). The first 4 bytes of the JSON (`{"t` / `{"se`) were read as a length header → `readU32be` = ~2 GB → `throw new Error("frame too large")` → the exception bubbled back into the camera tick's try/catch and was silently swallowed. Every announcement dropped. Affected: `advertiseLight`, `matchLightSession`, `scanLightSessions` (core/qr/light.ts) and `advertiseSound`, `matchSoundSession`, `scanSoundSessions` (core/modem/sound.ts). `pairing.ts` (BroadcastChannel/loopback) was CORRECT — those transports deliver raw bytes and consumers parse.
- **Why tests didn't catch it**: unit tests cover transport-level delivery (feedImage → onMessage) and the modem codec, but none exercised the pairing handlers' onMessage path.
- **Fix**: removed the redundant `FrameParser` from all six handlers; `JSON.parse(new TextDecoder().decode(frame))` directly on the delivered frame (single-message contract). Also `.catch()` on `video.play()` in `startCameraDecoder` (toggle-off caused an unhandled `play()` interruption rejection → pageerror).
- **Diagnosis trail**: page-instrumented `getImageData` (decodes OK) → patched `JSON.parse` (0 calls) → DBG logs in source showed `decodeQr OK 198B → reassembler 192B → parser 1 frame, handlers 1` then `decodeQr THREW` with `Error: frame too large at FrameParser.push` — the handler's second parser. Reproduced identically on localhost `vite preview` (also discovered repo `dist/` was stale — `dist` is untracked, rebuild before preview).
- Also synced root tree: `api/mailbox-store.ts` + `api/mailbox.test.ts` existed only in `vercel-deploy` (git repo) — copied to root so both trees run 111 tests.
- Verification: typecheck clean, 111/111 tests pass, build ok, in both trees; full live Playwright test vs localhost preview: **ALL CHECKS PASSED** (sender QR decodes → receiver preview plays/persists → session appears tagged "screen flash", words match → match screen → match QR decodes, sid matches → toggle-off releases camera → no page errors).
- Pushed `580ebf7` (2 files, +98/−111). Next: re-run the full test against semaphore-tau.vercel.app after Vercel rebuilds, and re-check `/api/mailbox/ping` (earlier finding: deployed function was stale single-segment-era build; this redeploy may fix it — local route verified correct).

---

### 2026-08-14 — receive scan bug fix (root cause confirmed, not guessed)
- **Symptom**: listening with Camera/screen-flash on — camera starts then stops, never finds the QR; mic channel likewise never scanned.
- **Cause**: `src/components/ReceiveFlow.tsx` listen effect pushed `() => scanLightSessions(...).stop()` (same for sound) into the `stops` array — a closure that starts the scanner **and immediately stops it**, invoked only during effect cleanup. The loopback line started its scanner immediately and pushed the stop fn. Result: while listening, sound/light scanners never ran; on cleanup they ran for ~0 ms.
- **Fix**: start `scanSoundSessions`/`scanLightSessions` immediately and push `() => scan.stop()` (same pattern as loopback).
- **Improvement (per user request "improve the receiving section")**: `scanLightSessions(..., { preview })` → `LightTransport({ preview })` → `startCameraDecoder(..., { preview })` attaches the live `<video>` (muted/playsinline) into the listen screen's `.campreview` box (4:3, object-fit cover, `src/styles.css`); `stop()` now pauses/detaches/removes the video element. Camera feed stays on while listening so the user can aim.
- Verification: `npm run typecheck`, `npm test` (104), `npm run build` all pass; `vercel-deploy/` copy synced (identical changes) and typechecks.
- **Api 404 (`/api/mailbox/ping` on semaphore-tau.vercel.app)**: reproduced live. The deployed function is an OLD build: it answers `/api/mailbox/ping` with its own JSON `{"error":"not found"}` (no ping branch) and does NOT route 2-segment `/api/mailbox/<sid>/<kind>` paths at all (router NOT_FOUND, no CORS headers) — i.e. pre-fix, single-segment-era route. Local `api/mailbox/[...route].ts` verified correct: esbuild bundle has zero runtime imports and the handler returns `200 {"ok":true}` for ping. Deployed JS bundle `index-jZ5k78jS.js` also differs from both local dists → **production is stale; redeploying the current code fixes the 404** (no code change needed). Vercel CLI on this machine is logged out — deploy must be run by the user. Note: `vercel-deploy/` has identical content to root; the project root directory setting determines which is deployed.

---

### 2026-08-14 evening — production debugging round (pushed c928014 → next commit)
- **Vercel api 404s (`/api/mailbox/ping`)**: the nested catch-all `api/mailbox/[...route].ts` *was* routing (the old runtime `Cannot find module mailbox-store.ts` error proved the function ran), but per-file deployments can't resolve sibling/cross-dir modules at runtime, and `.js` specifiers broke Vercel's tsc step (`bundler` resolution doesn't map `.js`→`.ts`; also discovered `../core/x.ts` from `api/mailbox/` resolves to `api/core/x.ts` — wrong depth). **Fix: the route is now fully self-contained** — store logic inlined into `api/mailbox/[...route].ts`, only `import type`s remain (stripped at compile; verified esbuild emit = zero imports, `export { handler as default }`).
- **`api/mailbox-store.ts` + `api/mailbox.test.ts` moved to `core/`** (`core/mailbox-store.ts`, `core/mailbox-store.test.ts`) so Vercel never compiles non-route files; `scripts/dev-mailbox.ts` and `core/online.test.ts` imports updated (`./mailbox-store.ts`).
- **Receive is now manual**: listen screen has channel toggles — Nearby tabs (default on, loopback), Microphone (asks for mic permission on click), Camera (asks for camera permission on click). Permission pre-flight happens in the click handler (user gesture → prompt reliably appears; the old effect-based auto-start never prompted on some browsers and was gated behind `pairingSupported()` which blocked everything when BroadcastChannel was missing). Scanner lifecycle keyed to toggles + screen; camera/mic released when a session is picked.
- **Error surfacing**: `startMicDecoder` now accepts `onError` (fired on unsupported/blocked mic), `SoundTransportOptions.onMicError`, `scanSoundSessions` wires it; light already had `onError`. Listen screen shows a `hint.warn` banner with permission problems.
- **Gating fixes (from earlier round)**: `canGetUserMedia()` no longer requires `getUserMedia.length === 0` (that disabled mic listening on every browser); `lightSupported()` no longer requires `window.VideoFrame` (Safari/Firefox camera receive now works via the drawImage fallback).
- **sw.js**: bumped to `semaphore-v2`; navigations are now network-first (stale `semaphore-v1` shell was serving the old "coming soon" bundle on returning devices); cleanup now actually deletes old caches.
- Verification: `npm run typecheck` (0 errors), `npm test` (104 tests), `npm run build` all pass; esbuild transpile of the route shows zero runtime imports.
- Remaining gaps (unchanged): >4 GB bigint sizes, >10 MB ETA warning, text quick-mode / Copy-as-text / Re-send, Vercel KV env smoke-test against real Upstash, e2e matrix / Lighthouse.

---

### Stage 4/5 (sound + light channels) fully wired — supersedes "gated coming soon" notes below
- Verification: `npm run typecheck`, `npm test` (104 tests, 13 files), `npm run build` all pass; `vercel-deploy` folder synced (incl. new `dijkstrajs` dep) and builds.
- Broadcast (noAck) engine: `StreamSender` gains per-chunk pacing — `pumpNoAck` sends header, then each chunk, `await waitIdle()` after every send; `maxPasses` cap; sent-volume stats (progress approaches 100% over pass 1). Fixed latent bug in `waitIdle`: `remote.idle` must be called with the transport as `this` (`idle.call(remote)`) — loopback transports never had `idle()` so it was invisible.
- Light transport (`core/qr/light.ts`): `LightTransport.idle()` now resolves after one full fragment rotation (`frags.length × LIGHT_FRAME_MS`) so the UI can show every QR before the next message replaces it.
- Robustness: `matchSoundSession`/`matchLightSession` treat the sender's first `hello` frame as an implicit `go` (a missed go burst no longer strands the transfer).
- `src/engine/send.ts`: `SendChannel` now `"loopback" | "online" | "sound" | "light"` + `channelSupported()`; `SendController` wires `advertiseSound` (chunk 4 KB) and `advertiseLight` (chunk 8 KB), both `noAck: true, maxPasses: 6`; exposes `display: LightTransport | null`.
- `src/engine/receive.ts`: exported `MatcherLike` + `nearbyMatcher(session, channel)`; `ReceiveController.matchDisplay` getter for the light match QR.
- `src/components/QrCard.tsx` (new): paints `LightTransport.currentFrag()` to canvas via `renderQr`/`paintQr`, advances every `LIGHT_FRAME_MS`, dynamic scale to fit ~460 px.
- `src/components/SendFlow.tsx`: channel chooser un-gates Sound/Screen flash (disabled only when unsupported: `soundSupport()`/`lightSupported()`); light waiting screen shows the animated announce QR; light transfer screen shows the chunk QR; done-screen copy differs for broadcast channels.
- `src/components/ReceiveFlow.tsx`: scans all three nearby channels simultaneously (`scanForSessions` + `scanSoundSessions` + `scanLightSessions`), sessions tagged `loopback`/`sound`/`light`; `pickSession` uses `nearbyMatcher` per channel; light waiting screen shows the receiver's match QR (`matchDisplay`); per-channel hints on waiting/transfer.
- `core/modem/sound.ts`: removed never-invoked `onState` from `SoundSenderQueue`/`SoundMatcher` (fixed `MatcherLike` type friction).
- `core/qr/light.ts`: `paintQr` return type narrowed to `Uint8ClampedArray<ArrayBuffer>` (TS 5.7 typed-array generics for `ImageData`).
- New test `core/session.test.ts` "broadcasts in noAck mode…": `RecordTransport` fake (paced broadcast, delivers to handlers, idle drains) proves: 3 passes × (hello + 5 chunks) in order, receiver completes from pass 1, sender stops after `maxPasses` with `passes` stat, echoes filtered.
- Known nits: build still warns chunk > 500 kB (libsodium); light transfer is inherently slow (~1.4 KB per 2.5 s QR) — fine for the <100 KB files the prompt scopes; broadcast sender UI relies on the receiver screen for completion confirmation.
- Remaining gaps (unchanged): >4 GB bigint sizes, >10 MB ETA warning, text quick-mode / Copy-as-text / Re-send, Vercel KV env smoke-test against real Upstash, e2e matrix / Lighthouse.

---

### Stage 3 (online WebRTC) fully wired end-to-end — supersedes the "In progress (Stage 3)" note below
- Verification: `npm run typecheck`, `npm test` (86 tests, 11 files), `npm run build` all pass.
- `api/mailbox/[...route].ts` + `api/mailbox-store.ts` — Vercel serverless mailbox (`[sessionId, kind]` routes, Memory store + Upstash KV store via `KV_REST_API_URL`/`KV_REST_API_TOKEN` env, TTL 600 s, CORS, ping probe).
- `core/mailbox.ts` — `createHttpMailbox`, `probeMailbox`, `MailboxPoller` (per-kind cursors), `putWithRetry`.
- `core/webrtc.ts` — `DataChannelTransport` (buffers until open, flushes in order, peer-close flag) + `WebRtcNegotiator` (offer/answer/ICE via mailbox, ICE restart once, connect timeout → fail).
- `core/online.ts` — `advertiseOnline` / `matchOnlineSession` / `fetchAnnouncement`; **sessionId-bound factory `MailboxForSession = (sessionId) => Mailbox`** so all announce/peer/go/ready/offer/answer/ice traffic hits `[sessionId, kind]` routes (bug: client URLs previously omitted sessionId → online mode could never reach the mailbox).
- `src/config.ts` — `mailboxForSession`, `iceServersConfig` (VITE_ICE_SERVERS or Google STUN defaults), `shareLinkFor`/`sessionIdFromLink` (#-fragment links), `probeOnlineSupported`; dev server mailbox via `scripts/dev-mailbox.ts` (vite plugin, memory store).
- `src/engine/send.ts` / `receive.ts` — online channel wired: `SendController` online path + 10-min link expiry; `ReceiveController.openOnline(sessionId, cb)` from link fragment, storage-fit check, header timeout.
- Fixes this session (test red → green):
  - `WebRtcNegotiator` shared ONE `pollSince` cursor across offer/answer/ice mailboxes → ICE entries advancing the cursor before the answer (index 1) arrived meant the answer was never read (deadlock). Per-kind cursors now (`core/webrtc.ts`).
  - FakePeerConnection in `core/online.test.ts`: channels live on the initiator's PC; `openChannels`/`failAndDrop` now open/drop the peer's channels too (they were no-ops → transport never opened).
  - DataChannel buffering test: both fake channels must be opened before delivery (fake drops messages to a non-open peer).
  - `probeMailbox` test: ping route registered before first call.
- Remaining gaps (unchanged): QR/repair/abort tests (stage 4), acoustic rate UI (stage 5), >4 GB bigint sizes, >10 MB ETA warning, text quick-mode / Copy-as-text / Re-send, Vercel deploy config (`vercel.json` absent; KV wiring in code, untested against real Upstash), libsodium > 500 kB code-split.

### Verification pass vs semaphore-prompt.md (2026-08-12, same session)
- `npm run typecheck`, `npm test` (64 tests, 8 files), `npm run build` all pass; dev server smoke-test OK (HTTP 200).
- New tests added per acceptance list: `core/chunker.test.ts` (header wire round trip, wrong-key reject, bad magic/truncated, 0-byte, exact-multiple chunk sizes, bad per-chunk CRC + tampered ciphertext dropped, reassemble missing-chunk fail, whole-file verify rejects tamper, filename sanitize), `core/compression.test.ts` (deflate/zip/none invariants, tiny + empty inputs, empty-zip fail), `core/have-bitmap.test.ts` (set/missing, bytes round trip incl. totalChunks, malformed reject, rebuild keeps bits, RLE runs).
- Spec deltas fixed:
  - Sender success screen now shows checksum (wired `StreamSender` `onHeader` crc32 through `SendController.onDone(hash)`).
  - Sender live stats grid now shows error count (spec: chunks/errors/ETA/kbps).
  - Copy tone: no "session" jargon, "crc32" label → "checksum".
  - `manifest.webmanifest` `scope` → `"/"` per spec.
  - Service worker was never registered — `src/main.tsx` now registers `./sw.js` in PROD builds (installable + offline).
- Confirmed matches: wire format (AB/version/cipher/tag, chunk index+crc32 keyed), session isolation, both-side word confirm, compression pako+fflate keep-smaller, XChaCha20-Poly1305, wake lock during transfer, storage-quota fast-fail, gating (online/light/sound "coming soon", never mocked), design tokens (#111/#FAFAF7/#E8590C, system-ui, 1.5 px round-cap icons, no emoji, 48 px targets, prefers-reduced-motion, aria-live, dark default + toggle), relative PWA paths.
- Known gaps (staged, not built yet): QR/repair-pass/abort tests (stage 4), acoustic rate UI (stage 5), online mailbox + 100 MB memory test (stage 3), >4 GB bigint sizes, >10 MB ETA warning, text quick-mode / Copy-as-text / Re-send, Vercel headers/KV (deploy stage 7). libsodium chunk > 500 kB — code-split later.

### Done (earlier this session)
- **Stage 1 (core protocol lib) complete.** 45 unit tests originally; see list below.
- **Stage 2 (app shell + real transfer engine) complete.**
  - `core/chunker.ts` — slice source, manifest builder, per-chunk seal/CRC, reassembly, header wire format
  - `core/compression.ts`, `core/crc32.ts`, `core/crc16.ts` — pako/fflate compression, CRC
  - `core/crypto.ts` — libsodium-wrappers: XChaCha20-Poly1305, sealed boxes, word pair, passphrase KDF
  - `core/frames.ts` — length-prefixed framing + `FrameParser`
  - `core/have-bitmap.ts` — chunk ownership bitmap (resume/repair)
  - `core/pairing.ts` — BroadcastChannel hub: `advertiseSender` / `scanForSessions` / `matchSession` (cross-tab loopback pairing, matching, go/ready handshake)
  - `core/session.ts` — `StreamSender` (windowed send, resend/retry, stats events), `StreamReceiver` + `ReceiverEngine`
  - `core/stats.ts` — `TransferStats` rate/ETA
  - `core/transports.ts` — `TransportEndpoint` interface, `loopbackPair`, `JsonChannel`
  - `core/modem/` — OFDM speaker/mic modem (dsp.ts + ofdm.ts), in-band test passes (stage 4 foundation)
  - `core/util.ts` — base64url, hex, u32/u64, formatting helpers
- **Stage 2 (app shell + real transfer engine) complete.** `npm run typecheck`, `npm test`, `npm run build` all pass.
  - `src/{main,App,store,icons}.tsx`, `src/styles.css` — shell, zustand store (SenderView/ReceiverView + `resetSender`/`resetReceiver`), line icons, both themes
  - `src/components/SendFlow.tsx` — pick (dropzone) → channel chooser ("This device" live; Online/Screen flash/Sound gated "coming soon", never mocked) → waiting (word chips) → matched (confirm prints peer fingerprint) → transfer (ProgressRing + speed/ETA/chunks stats) → done / error
  - `src/components/ReceiveFlow.tsx` — listen (scans hub, session list with word chips + file meta) → match (words + peer fingerprint, storage-fit check) → waiting → transfer → done (Save via blob download, crc32 shown, keep-listening) / error
  - `src/engine/{send,receive}.ts` — `SendController` / `ReceiveController` wiring pairing + StreamSender/StreamReceiver (hash = 8-hex crc32); `wakelock.ts` runs during transfer screens
  - Fixed core typecheck errors: `ChannelKind` type-only import (pairing.ts), unused `Peer`/missing transport import (pairing.test.ts), `StreamReceiver` opts signature + crc32 hash in receive.ts
- Known nit: build warns chunk > 500 kB (libsodium) — code-split later if needed.

### In progress (Stage 3)
- Online WebRTC mode: Vercel mailbox (api/mailbox), datachannels, streaming — no `api/` or `vercel.json` yet.

### Next (Stage 4+)
4. QR mode (pairing QR + burst loop + repair passes + resume bitmap) — uses qrcode/jsqr deps.
5. Acoustic modem UI integration (core modem exists and is tested).
6. Hybrid picker + polish (wake lock, battery, dark mode done in stage 2 partially, install prompt).
7. e2e matrix, Lighthouse ≥ 90, airplane-mode test.

---

## Commands
- `npm test` — vitest on `core/**/*.test.ts`
- `npm run typecheck` — tsc --noEmit
- `npm run build` — typecheck + vite build
- `npm run dev` — dev server
- `npm run icons` — regenerate PWA icons (scripts/gen-icons.mjs)

## Key API surface (for quick resume)
- Pairing: `advertiseSender({name,size}|null)` → `{sessionId, wordPair, senderFingerprint, onMatch(cb), notifyGo(), start(cb: {sessionKey, channel, receiverFingerprint}), stop()}`
- Receiving: `scanForSessions(cb(list))` → unsubscribe; `matchSession(visible)` → `{pin, confirm(), onGo(cb), postReady(), cancel()}`; `pin.sessionKey` ready after `confirm()`
- Transfer: `new StreamSender(sessionId, sessionKey, source, {onEvent, chunkSize})` then `run(channel)` (channel = pairing `channel`); `new StreamReceiver(sessionId, sessionKey, onEvent)` then `start(channel)`, `onComplete(cb)`
- `source` = `fileSource(File)` or `arraySource(Uint8Array, name, mime)` (chunker.ts)
- Stats: poll `engine.stats.snapshot()` or listen to `onEvent({type:"stats"})`; also `phase` events; `done`/`error`
- Handshake flow: sender `onMatch` → user confirm → `notifyGo()` → receiver `onGo` → `postReady()` → sender `start()` → sender runs StreamSender → receiver runs StreamReceiver (start immediately after onGo; header arrives later)
- Receiver must also handle `onClose` (sender closed) → error state ("Sending stopped")
- Sound channel: `advertiseSound({name,size}|null, {quiet?, burstMs?})` → queue (no display); `matchSoundSession(session)` → matcher; `scanSoundSessions(cb, onError)` → `{stop(), noiseFloor(), snr(), framesDecoded()}`; `soundSupport()` / `soundRxSupport()` (core/modem/sound.ts)
- Light channel: `advertiseLight(...)` → `{..., display: LightTransport}` (UI paints `display.currentFrag()`); `matchLightSession(session)` → `{..., display}`; `scanLightSessions(cb, onError)` → `{stop(), framesScanned()}`; `lightSupported()` (core/qr/light.ts)
- Broadcast mode: `StreamSender` opts `{noAck: true, chunkSize, maxPasses, gapMs}` — cycles header + all chunks per pass, `idle()`-paced per chunk; receiver de-dupes/completes on its own; sender stops after `maxPasses`
- `QrCard` component (`src/components/QrCard.tsx`): `transport: LightTransport | null` — paints + advances every `LIGHT_FRAME_MS`

## Constraints (from semaphore-prompt.md)
- Zero runtime deps beyond listed. No mock/stub UI — real bytes through real pipeline.
- Gate unfinished channels with "coming soon", never fake progress.
- Design: ink #111 / paper #FAFAF7 / accent #E8590C, system-ui, ≥48px targets, line icons, no emoji, aria-live, prefers-reduced-motion.
- Wire format/encryption is E2E on every payload; mailbox never carries bytes.