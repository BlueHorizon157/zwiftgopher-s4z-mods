# TT Sauce4Zwift mod — Audit and Revamp Plan

**Date:** 2026-10-27. **Code reviewed at:** mod `master` 94c61a3 (today's "plan CP and W' for
W'bal, look-ahead setting"), against the planner branch `claude/tt-planner` with its
uncommitted Phase 5 work (`inc/ttplanfile.class.php`, `inc/ttsharedplans.class.php`: share
codes now store the plan file `zg-tt-plan/1`). Sauce4Zwift behaviour is from the current
`SauceLLC/sauce4zwift` master (`src/stats.mjs`, `src/mods.mjs`, `pages/src/common.mjs`,
`pages/scss/common.scss`, `src/zwift.proto`).

**Goal (Dave, 2026-10-27):** the mod runs more reliably, uses fewer resources, the bugs are
squashed, the main widget becomes a fantastic-looking HUD (two or three variants for
preference), and the other widgets are as compact as possible while staying clean and
visible. Everything overlays Zwift, so it must stay readable over every world and time of
day.

This document is the single plan for that work. It follows the shape and rules of
`TT/PLANNER_REVIEW_PLAN.md` in the main repo and takes over its mod-facing items (5.1 plan
file, 5.2 look-ahead) once they land.

---

## Status (2026-10-27)

Audit done; Dave's decisions are in §6. **Phases 0 to 5 are in**, uncommitted on the mod's
working tree (branch `claude/plan-file-v1`, on top of 94c61a3), with a small planner change
uncommitted on `claude/tt-planner` (below). `npm test` runs 125 tests; `scripts/page-check.mjs`
drives every window inside Sauce's own web server (the AppImages on the dev machine:
`sauce4zwift-2.4.0-alpha.5` and `2.0.0-beta.10`, mod enabled under the new id) and writes the
README's screenshots to `docs/screenshots/`. The planner's Phase 5 is committed on
`claude/tt-planner` (4120db9, c4cbc26, 3a8dec0); the mod release (manifest 0.7.0) must ship
with that deploy, plus the uncommitted planner files below, not before. Still Dave's: a real
TT recording (settings → Advanced → Record telemetry, with the field or rivals window open so
`nearby` is recorded too) to confirm the start-line signal and the field's assumptions, the
perf baseline, a look at the windows over real Zwift worlds, the commits, and the directory
listing (docs/DIRECTORY.md). Next: Phase 6, which starts with that recording.

### Phase 5: planner coupling and distribution (in)

| # | What was done |
|---|---|
| 5.1 | The mod has read the file first since Phase 1 (`plan.mjs`), with the legacy shape as the fallback for codes saved before the file. The rule is now written down: the mod (0.7.0 on) reads the file, and the fields 0.6.x mods read are frozen (`TT/docs/plan-file-v1.md`, `TT/PLANNER_REVIEW_PLAN.md`, `TTPlanFile`'s header). |
| 5.2 | **Strategy switch.** The file's cards gave each interval as route points and watts, which the mod cannot place without the route. **Planner:** each card now also carries `plan_intervals`: its rows in the file's interval shape (metres, start time, duration, speed, gradient, W′ on the rider's own numbers, the margin figure alongside). `TTPlanFile::intervals()` builds them, the same code as the plan's own rows, from the optimiser's per-card plans, so nothing is simulated again. Planner goldens are identical in strict mode; the files grow to 6–16.5 KB. **Mod:** `normalisePlan(raw, {card})` rides a card; the store keeps the chosen card with the active plan (`/zg-tt/active`); every window applies it before the start (idle, armed), and a change made during a race waits until it is over. **HUD:** before the start, the banner shows the strategy as a chip, and clicking it opens the plan panel (Fastest / Balanced / Safe finish with their times; *As shared* too when an edited plan is none of the cards). Picking one closes the panel. Racing, the panel shows the strategy locked. The settings page lists the cards with time, average power and lowest W′. The list's header names the strategy. Tests: card plans load, time and length match the card, choosing the plan's own card changes nothing, old shares without card plans and legacy payloads ignore the choice, margin cards carry W′ on the rider's numbers, and the W′ kernel reproduces every card's `wbal_kj` (43 new goldens). |
| 5.3 | **Clipboard hint.** When the HUD gains focus (and, outside a race, only then), it reads the clipboard. A planner code (upper case, the planner's alphabet) or a zwiftgopher link holding one is offered as **Load ABC123**: in the plan panel, and in the hover tray before the start. The list puts the code in its box. A failed read (no permission, no focus, a browser outside Sauce) is no offer. Nothing is read during a race. The planner's share dialog now says: copy the code, click the TT HUD. |
| 5.4 | `docs/DIRECTORY.md`: how the directory works, the entry ready to send (name, description, tags, URLs), the release fields, and the checks before sending. Directory installs get a Sauce-assigned id, so windows are re-added once. Logo: `docs/brand/logo.svg` and `logo.png` (512 px, the dial's on-target arc and tick). `release.sh` prints the zip's size and sha256 for the entry. The zip holds one top folder with `manifest.json` (84 KB, no tests, docs or fixtures). minVersion 2.0.0: the full page check passes on Sauce 2.0.0-beta.10 as on 2.4.0-alpha.5. README: install and update steps, strategy, clipboard. The planner's `TT/sauce4zwift-mod.html` is rewritten for the six windows, with screenshots under `TT/images/sauce-mod/`. It drops the old install path, which pointed at the wrong folder. |
| 5.5 | Not done (optional). Power-aware pacing changes the finish prediction, so it should be built against the real recording, behind a golden (Phase 6). |

Planner files changed (uncommitted, `claude/tt-planner`): `inc/ttplanfile.class.php`
(`intervals()`, `cardIntervals()`, `plan_intervals` in the card keys), `inc/tt.class.php`
(cards carry `plan_intervals`), `TT/docs/plan-file-v1.md`, `TT/PLANNER_REVIEW_PLAN.md` (the
compatibility rule), `TT/index.php` (share dialog text), `TT/sauce4zwift-mod.html` and
`TT/images/sauce-mod/` (new).

Deviations and open points:

* The strategy is chosen before the start in the HUD's plan panel, reached from the banner
  chip, rather than as buttons always on the armed HUD. The race HUD keeps its four cells
  either way.
* A window opened mid-race after a strategy change made on the settings page during that race
  rides the new card while older windows keep the old one until the race ends. This is rare
  and noted, not handled.
* The clipboard offer is checked in Chrome by the page check. In a real Sauce 2.4 HUD
  window (opened through Sauce's RPC under the remote debugger, then removed), clipboard
  reading is *granted* and `readText()` resolves: Sauce sets no permission handler, so
  Electron allows it.

### Phase 4: list and field (in)

| # | What was done |
|---|---|
| 4.1 | `list.html` + `src/list.mjs` + `css/list.css` replace the 0.6.x list. Header: route, finish time (plan before the start, prediction while racing, actual after), plan time and intervals ridden, the delta in words, planned against actual average power, offset and bias when set. Columns # · to km · W · time · grade · W′ kJ. Rows are built once per plan; each cell is rewritten only when its text changes. The current row carries a bar and a progress fill (amber bar inside the warning time) and sits a third of the way down; manual scrolling holds it for 5 s. A ridden row shows the average against the target in the band colours, the time against the plan, and the closing W′ against the plan's (the engine now records `wbalEndJ` per interval; test: within 0.6 kJ of the plan on every interval). The interval the clock started in is timed against the plan from the line, not the pen. No plan: the code box. |
| 4.2 | `engine/field.mjs` (pure, 14 tests): checkpoints every 50 m of `eventDistance` holding world time, per rider, interpolated between samples; a stopped rider's arrival is back-dated from their speed. Gap at the trailing rider's latest common checkpoint, on the road (world time) and on the clock (less the start offset: each rider's start is seen at the timing line, else taken from `state.time`; a group event uses the gun). Trend = change of the gap over the trailing rider's last 60 s (the clock and road trends are the same). Sector speed over the last plan interval both have finished, merged back to ≥ 400 m, or the last whole km without a plan. Unseen 2 min fades, 10 min evicts; a distance going back or a new subgroup clears the rider; reset clears all. `field.html` + `src/field.mjs` + `css/field.css`: pos (Sauce's `eventPosition`) · rider + team · gap with ▲▼ · gain/loss per minute in green/orange · avg km/h · w/kg · W′ bar; standings order by the clock gap (click *gap* for the road); keyed rows moved only when out of place; the home row is sticky and centred. |
| 4.3 | The per-window titlebar hacks are gone with the old pages; every window uses Sauce's settings-mode titlebar (right-click), and `page-check.mjs` checks it appears with the settings button on each window. |
| 4.4 | `rivals.html` + `src/rivals.mjs` + `css/rivals.css`, manifest window `rivals` (600 × 76, bottom third): the nearest one or two riders behind (left) and ahead (right) on the road with the gap, *gaining / holding / losing* and the rate, and their last-sector speed coloured against yours; your speed in the middle; below, every rider on a track by road gap (range 15 s to 10 min, chosen to fit), dots coloured by trend. Narrow strips drop the sector speed, then the second rider and the rate. |

Shared work: `views/runtime.mjs` now applies the look settings (background, halo, size) and the
replay backgrounds to every window and calls `onReset`; `views/field-feed.mjs` feeds `nearby`
into the field model with the window engine's event kind, line metre and plan sectors; the
settings page has Field and Rivals sections and shows each window only the settings it uses;
every sub-unit text size is `max(11px, …)` and `page-check.mjs` now fails on any visible text
under 11 px; the recorder lets one window per channel write (several windows subscribe to the
same channel); the synthetic recordings carry six made-up rivals released −20 to +25 s from the
home rider at 0.97–1.02 × the plan's speed, in `nearby` rows every 2 s.

Deviations and open points:

* The rivals strip is 600 × 76, not 560 × 56: two lines of riders and the track do not fit in
  56 px at the 11 px floor.
* The field is ordered by the clock gap, not by Sauce's `eventPosition` (shown as *pos*): how
  Zwift ranks a staggered TT mid-race is unknown.
* Assumptions for the real recording to confirm: other riders' `eventDistance` and
  `worldTime` arrive in `nearby` as for the home rider; what `eventDistance` does after the
  finish (the model handles it freezing); whether another rider's `state.time` is their race
  clock (used only for riders first seen past the line).
* The field and rivals need an event; on a free ride riders have no shared distance.

### Phase 3: the HUD (in)

| # | What was done |
|---|---|
| 3.1 | `css/tokens.css`: ink `#f5f7fa` with a three-layer dark halo (`--halo-a` 0/.55/.9/1 by setting), the band colours under `#62c6ff` / on `#7bef9b` / over `#ff7b5c`, amber `#ffc53d` for the boundary moment only, red `#ff5c5c` for a low W′; background modes clear / smoke .38 / dark .74 / solid on the one `.panel`; no blur anywhere. Saira (Sauce's face) with tabular numerals. Every size comes from `--u` = `max(11px, scale × min(cqh, cqw))` per layout, so nothing drops under 11 px at any window size. |
| 3.2 | `hud.html` + `src/hud.mjs` (one page) + `views/runtime.mjs` (what every engine window does the same way: store, settings, event info, replay, visibility). States: idle (the code box, obvious, the figures hidden), armed (banner: route, *ready* / *starts in 0:08* / *group event: the clock runs from the start*, plan-length mismatch), racing, finished (ride average vs plan average, time vs plan in words), spectating (greyed, name). Hover tray: offset ±10 m, bias ±1 %, Reset, Plan, settings. |
| 3.3 | Three layouts, three manifest windows (`hud-strip`, `hud-dial`, `hud-stack`). **Deviation:** Sauce's manifest schema makes `file` unique per window, so `hud-dial.html` and `hud-stack.html` are copies of `hud.html` differing only in `data-layout` and the title (`test/pages.test.mjs` keeps them identical); `?layout=` still overrides for tests and the settings page can override per window. |
| 3.4 | The boundary moment: under `soonSec` (10 s, a setting) or 100 m the next target and its countdown turn amber and pulse; at the swap the now figure scales in over 320 ms (`prefers-reduced-motion` respected). Gradient glyph ▲ ▼ ▬ with the percentage. W′ bar with the planner's floor, red under 25 %, *below plan* when under the plan's end-of-interval figure. Finish in words. Pre-start countdown from the subgroup's start time. |
| 3.5 | `settings.html` + `src/settings.mjs`, one page for every window (`?for=hud|list|field` picks the `SettingsStore` key `zg-tt-*`), bound with Sauce's `initSettingsForm`: Plans (library with route, time, expiry, Use/Remove; code or link), Look, Pacing (smoothing, band, look-ahead, warn time, clock start rule), Advanced (debug, recorder, version/update hint). |
| 3.6 | `scripts/page-check.mjs` second pass: each HUD at four moments (pen, mid-race, 9 s before a boundary, finished) over three **stand-in** backgrounds (CSS gradients for snow, jungle, night: real Zwift captures are Dave's), plus idle and the tray; checks the engine state at each, the amber state at the boundary and the 11 px floor. Output in `docs/screenshots/`, used by the README. |

Phase 2 is in with it: 2.2 (`settingsStore` per window, the one settings page), 2.4
(`version.mjs`, the update hint once a day under `/zg-tt/update-check`, no work while the
window is hidden via `common.isVisible()`), 2.5 (no console output per tick; changed-value
DOM writes via `views/dom.mjs`; at 1 Hz rAF batching is not needed). The 0.6.x dashboard
(`tt-dashboard.html`, its settings page and stylesheet) is deleted; the interval list runs
on `views/runtime.mjs` and reads the `zg-tt-list` settings. The field window is untouched
until Phase 4.

Design notes (the `frontend-design` pass): the target is the hero, not the live power; the
live figure reads as a relation to it (colour, glyph, word). Labels are lower-case words,
no caps, no dots between facts. One accent moment, the amber boundary; everything else is
ink. The dial's live arc carries a dark under-stroke so it reads on snow. The replayer took
`seekMs` (`?seek=`) so a moment can be screenshotted without playing the race.

### Phase 1: one engine (in)

`pages/src/engine/` is pure (no DOM, storage or timers) and runs in Node and in every
window. The dashboard and the interval list are views over it; the field window keeps its
own logic until Phase 4.

| # | What was done |
|---|---|
| 1.1 | `plan.mjs`: a plan file or a legacy share payload → one shape in metres and seconds (`startM/endM/powerW/grade/durationS/startTimeS/speedMs/wbalKj`), CP for W'bal = `cp_wbal ?? cp_used ?? ftp`, W' = `wprime_used_j ?? settings.wPrime`, cards, a cheap signature. |
| 1.2 | `clock.mjs`: three starts. TT event: the timing line, by rule `time` (state.time leaves 0 in the event: the old mod's working assumption and the synthetic recordings'), `distance` (eventDistance passes the plan's line metre: `start_offset_m` + 150) or `auto`. Group event: the subgroup start time from `eventinfo.mjs` (Sauce's event RPCs), else the first eventDistance. Free ride: the arm. Elapsed comes from the telemetry (`state.time`, `state.worldTime`), so two windows read one clock. |
| 1.3 | `align.mjs`: plan metre = `eventDistance` in an event (ride distance from the arm outside) + the manual offset; no rescaling, a length mismatch over 1 % is reported. Route match by `route.id` arms a plan on a free ride. |
| 1.4 | `cursor.mjs`: O(1) with the previous index, O(log n) without; look-ahead is a second cursor at `speed × lookAheadSec`. |
| 1.5 | `tracking.mjs`: per-interval time and work on the race clock; the interval holding the start line counts as whole, a join beyond it is partial; pacing = actual/plan time over whole completed intervals (1 until a minute of them, clamped 0.25–4); prediction = remaining plan time from the current metre × pacing, compared with the plan's time *from the line* (`planTimeAtMetre`), so a plan from the pen and a clock from the line agree. |
| 1.6 | `wbal.mjs`: the planner's kernel (Bartram 2018, gain 1.75 × level, the 1 × DCP recovery cap). Golden: riding every plan fixture exactly reproduces each interval's `wbal_kj` within 0.1 kJ + the drift of a CP written to 0.1 W. |
| 1.7 | `engine.mjs`: idle → armed → racing → finished; spectating as a flag (the rider with `self: true` is home, else the first seen); statistics clear only on a new event subgroup, a new plan or `reset`; `view()` is the flat model the windows draw. Tests on the synthetic recordings: states, the first interval opening on the start tick, delta within 2 s and pacing 1 when the plan is ridden exactly, W' at the finish within 0.5 kJ of the plan, bias and look-ahead, reset, spectate, late join. |
| 1.8 | `tt-dashboard.mjs` (382 lines, was 2,820) and `tt-interval-list.mjs` (300, was 1,732) draw the engine's view into the 0.6.x HTML with changed-value writes; `store.mjs` holds the plan library (five by code), the active plan and the controls under `/zg-tt/*` and migrates 0.6.x keys once; `views/plan-loader.mjs` loads a code (or a pasted planner URL) with a timeout and a retry. Gone: the BroadcastChannels, the postMessage bridge, publisher ids, signatures, the eight detections, `shared-plan-utils.mjs`, per-tick console output; the update check runs once a day. The field window clears on the dashboard's reset through `/zg-tt/controls`. |

Deviations and open points:

* The finish delta is shown in words (`on plan`, `ahead 0:12`, `behind 0:40`) already,
  as the rules ask; the HUD will keep that.
* Smoothing default is 3 s in the engine; the settings page still offers Off–5 s and the
  dashboard honours it. The interval list runs its engine unsmoothed.
* `state.eventDistance` is read as metres (Sauce converts the game's centimetres); the real
  recording confirms it.
* 1.5's power-aware pacing (R11) is not done (plan 5.5).

### Phase 0: guardrails (in)

| # | What was done |
|---|---|
| 0.1 | `package.json` (`npm test` → `node --test`). `scripts/make-plan-fixtures.php` runs the planner's own harness (`tt_plan_runner.php`) and writes `test/fixtures/plans/<case>.<path>.json` (optimise for all 13 cases, generate for the four `.fit` cases) and `test/fixtures/legacy/flat.fit.optimise.json` (the whole plan as a pre-file share code held it). `test/plan-fixtures.test.mjs` pins what the engine may rely on: contiguous metres from 0, cumulative `start_time_s`, whole-second `duration_text`, `cp_used`/`wprime_used_j`, the `settings.wPrime` alias. `scripts/make-synthetic-telemetry.mjs` rides a plan file exactly (pen, roll-out, plan, freewheel) into the recorder's JSONL with the event RPCs; its guesses about the start line are listed in the meta row (`assumptions`) so a real recording can be compared against them. |
| 0.2 | `pages/src/recorder.mjs`: the dashboard records `athlete/watching` (trimmed: laps, segments, streams dropped) and the field window records `nearby` every 2 s (its own subgroup, a fixed set of fields), plus every `sauce.rpc` result, into IndexedDB (shared by the mod's windows), two hours or 150 MB, controlled by the global key `/zg-tt/recorder`. Settings page: Record on/off (on starts a fresh recording), status, Save recording… (a `.jsonl` download), Clear. |
| 0.3 | `pages/src/sauce.mjs` is now the windows' only door to Sauce (`subscribe`, `rpc`, `storage`). With `?replay=<name>` it plays `pages/fixtures/<name>.jsonl` (or `?replay=idb`, the recorder's buffer) through `pages/src/replay.mjs`, serves recorded RPC results, and runs `Date.now` on the recording's clock so interval timing is right at any `&speed=`. The replayer is pure and tested (`test/replay.test.mjs`). |
| 0.4 | The broken tag workflow is deleted; `scripts/release.sh` checks the tag against `manifest.json`, writes and commits `pages/src/version.mjs` (the dashboard imports it), and refuses a dirty tree. `manifest.json` has `"id": "zwiftgopher-tt"` (decision 5). `.gitattributes` keeps `test/`, `docs/`, `pages/fixtures/`, `scripts/` out of release zips. `pages/README.md` → `docs/prediction-pipeline.md`, `pages/PERFORMANCE_AUDIT.md` → `docs/perf-audit-2025-12.md`; `.gitignore` no longer ignores markdown. |
| 0.5 | `docs/perf-baseline.md`: the procedure and the table to fill in on Dave's machine (needs Sauce). |

Facts for Phase 1 (from the planner's code, 2026-10-27):

* **Plan metre 0 is the pen.** The planner's GPX starts with `start_offset_m` of flat
  padding = 30 m pen-to-route (`PEN_DISTANCE_M`) plus any track the route data is missing
  before its first point; raced distance = the game's lead-in + lap − 150 m
  (`START_DELAY_M`, unverified). So the plan covers pen → finish, and the timing line sits
  about 180 m into the plan under that rule. The synthetic recordings model exactly that
  (`--line=180`); whether `eventDistance` counts from the pen release and what `state.time`
  does at the line are the two things to read off the real recording.
* The planner's harness (`scripts/diagnostics/tt_plan_runner.php`) builds every path a
  rider can trigger; `ttRunCase()['plans']` holds the full plans and `TTPlanFile::fromPlan()`
  makes the file. Each case takes 1–5 s; the climb cases need the harness's 1024 MB.

---

## 1. What the mod is today

| Window (manifest id) | Page | Script | Lines | Subscribes to | Does |
|---|---|---|---|---|---|
| TT Planner Dashboard (`tt-interval-dashboard`) | `pages/tt-dashboard.html` | `src/tt-dashboard.mjs` | 2,820 | `athlete/watching` | gauge, target band, W'bal ring, next interval, finish countdown, offset/bias buttons, plan code input, debug log, version check, event-start detection, interval stats, finish prediction, cross-window publishing |
| TT Interval List (`tt-interval-list`) | `pages/tt-interval-list.html` | `src/tt-interval-list.mjs` | 1,732 | `athlete/watching` | summary header, full interval table with actual-vs-plan after each interval; its own copy of tracking, offsets and scaling |
| TT Field Dashboard (`tt-field-dashboard`) | `pages/tt-field-dashboard.html` | `src/tt-field-dashboard.mjs` | 566 | `nearby` | riders in the pen/category with gap at equal distance, avg kph, w/kg, IF, W' bar, position |
| two settings pages | `*-settings.html` | `*-settings.mjs` | 131 | storage events | band width, smoothing, look-ahead, debug; show all riders |

Data flow today:

```
Sauce athlete/watching ──► dashboard ──┬─► common.storage '/tt-dashboards/shared-state'
                        │              │   (plan snapshot + offset + bias + home athlete
                        │              │    + spectate + clearStatsTimestamp)  ──► 'globalupdate' in every window
                        │              ├─► BroadcastChannel tt:predictions:<athlete>
                        │              └─► BroadcastChannel tt:interval-avg:<athlete>
                        └──► interval list (re-derives distance, offsets, scaling, interval stats itself)
Sauce nearby ──────────► field dashboard (own checkpoints, own position count)
zwiftgopher.com/TT/share-plan.php?action=load&code= ──► dashboard (plan), persisted in window storage
api.github.com releases/latest ──► dashboard (update check, every window open)
```

The plan arrives as the planner's share-code payload. Until today that was the whole planner
plan; it is now the plan file (`schema: zg-tt-plan/1`) with `intervals[].start_m / end_m /
start_time_s / duration_s / power_w / avg_gradient / wbal_kj`, `route.id / start_offset_m /
lead_in_km`, `rider.cp_used / wprime_used_j`, `summary`, `cards`. The legacy km fields are
kept in the file so released mods keep working.

---

## 2. Design rules

Every phase is checked against these.

- **One engine.** Plan + telemetry + controls go into one pure module (`src/engine/`) that
  produces a view model. Windows render; they do not compute. The engine runs in Node for
  tests and in every window at runtime.
- **The planner's numbers.** The plan file is the input, in metres and seconds as the planner
  wrote them. The mod never rescales a plan to the event; it reports a mismatch.
- **Event truth from Sauce.** Distance is `state.eventDistance` in an event (0 at the start
  line) and `state.distance` from an explicit start otherwise; the race clock comes from the
  event subgroup's start time, never from a guess about `state.time`.
- **Deterministic windows.** Two windows fed the same telemetry show the same numbers because
  they run the same engine, not because one publishes to the other. The only shared state is
  the plan library and the controls, small and written rarely.
- **Readable at a glance, over anything.** Three levels of information (now / next / how it
  is going), one number dominant, no text under 11 px at any window size, every glyph with a
  halo, no blur. Background mode (clear / smoke / dark / solid) is the user's choice.
- **Quiet.** No console output unless debug is on. No `backdrop-filter`. DOM writes only when
  a value changed. Lists render at most once a second and only the rows that changed.
- **Resets are explicit.** Race statistics are cleared when the engine sees a new event
  start, a new plan or the rider presses Reset, never because a storage key was written.
- **Compatibility.** Codes in the wild keep loading (file and legacy). Storage keys migrate
  once with a one-off step; the mod id stays stable.
- **Words, not numbers, for judgement calls** (as in the planner): "on target", "a little
  hot", "spending W' fast", not IF or ratios.

---

## 3. Findings

Ranked by user impact within each group. R = reliability/correctness, P = performance,
X = compatibility/packaging, U = readability/UX, C = code health. References are to
`pages/src/*.mjs` at 94c61a3, by function so they survive edits.

### 3.1 Reliability and correctness

| # | Finding | Where |
|---|---|---|
| R1 | **The race clock is a guess.** `state.time` is treated as "0 in the pen, counts from the gun" (DETECTION 7), snapshotted at each interval end (`finalizeIntervalStats` → `raceElapsedSnapshot`) and used as the baseline of every finish prediction. `zwift.proto` gives `time` no meaning and Sauce never resets it. If it is the ride timer (it counts the warm-up), every prediction delta carries the warm-up and "Time remaining" is wrong from the first interval. Sauce has the event subgroup's start time (`rpc.getEventSubgroup(id)`), which is the authoritative race clock. | `tt-dashboard.mjs` `detectAndHandleEventStart`, `finalizeIntervalStats`, `computeFinishPrediction`; `tt-field-dashboard.mjs` `getEntryElapsedSeconds` |
| R2 | **Distance comes from the wrong field.** `deriveDistanceMeters` prefers `state.distance` (ride distance, warm-up included) and only uses event progress when Sauce reports `remainingMetric === 'distance'`; `state.eventDistance` (metres from the start line, the field made for this) is never read. The auto-offset, the plan-to-event scaling (`getScaledDistanceKm`, two different versions in the two windows: tail-only under 1 km in the dashboard, proportional in the list) and the "course Δ" flag exist to compensate. The field dashboard's 10 m checkpoints index on ride distance, so gaps between riders with different warm-ups are off by the warm-up difference. | `deriveDistanceMeters`, `getScaledDistanceKm`, `resolveBaseDistanceKm` (both windows); `tt-field-dashboard.mjs` `getEntryDistanceMeters`, `recordCheckpoint` |
| R3 | **Two W'bal models on screen.** The gauge integrates its own W'bal (`updatePlanWBalFromTelemetry`: linear spend, exponential recovery) while the list shows the planner's `wbal_kj`, which comes from the shared, calibrated kernel with the 1 × (CP − P) recovery cap (planner Phase 1/4). At the same moment the two windows disagree. Sauce's own `wBal` is read from `watching.stats.wBal`, which does not exist (it is top-level `wBal`), so `metrics.wBal` and `wBalPercent` are always null. 94c61a3 fixed which CP and W' are used, not the model. | `handleWatching`, `updatePlanWBalFromTelemetry`, `tt-interval-list.mjs` `recomputeIntervals` |
| R4 | **Two interval cursors in one window.** `handleWatching` tracks `currentIndex` and `intervalStats`; `updateDashboard` keeps `displayedIntervalIndex` with its own `powerIntegral`/`intervalAvgPower`, reset on display change. The gauge's "Avg" and the list's interval average come from different integrators. Since 94c61a3 the displayed index also carries the look-ahead, so the two diverge by design, and the progress bar, "Next n/m" label and "Next in" distance mix the two. | `handleWatching`, `updateDashboard`, `updateIntervalTracking` |
| R5 | **Nothing is tracked outside an organised event.** Interval stats and the prediction only start when `eventHasStarted`, which only the pen→start detections set, and those need `eventSubgroupId`. A solo TT of the route, a club ride on it or a late-loaded plan gets the gauge but no statistics and no finish time. The plan file carries `route.id`; Sauce's state carries `routeId`, `laps` and `eventDistance`. | `detectAndHandleEventStart`, `handleWatching` (`if (state.eventHasStarted)`) |
| R6 | **Resets are triggered by storage writes.** Eight detection branches (7 and 8 are copies), five reset paths, each writing `clearStatsTimestamp` to the shared key (twice in the refresh handler); the interval list clears all its stats on every such write (`applyStoragePayload`). A course-id flicker, a subgroup id arriving one tick late, or a spectate switch wipes the race's statistics in both windows. No test covers any of it. | `detectAndHandleEventStart`, `handleEventReset`, `initControls` (refresh), `tt-interval-list.mjs` `applyStoragePayload` |
| R7 | **Home athlete is whoever was watched first.** `maybeAdoptHomeAthleteId` locks the first athlete seen as "home" until the plan is reloaded, and persists it with the plan. Open the window while Sauce is watching a teammate and the mod spends the race "spectating". | `maybeAdoptHomeAthleteId`, `setHomeAthleteId`, `shouldBlockTelemetry` |
| R8 | **Three sync channels, one truth.** Storage `globalupdate` (with the plan snapshot in every write), two `BroadcastChannel`s named by athlete, a `postMessage` bridge, publisher ids and signatures so a window ignores itself; `computePlanSignature` stringifies all intervals on every event to tell whether the plan changed. This is where "the two windows disagree" bugs come from. | `persistSharedState`, `applySharedStatePayload`, `initPredictionChannel`, `shareFinishPrediction`, `initPlanBridge` (both windows) |
| R9 | **Plan loading has no safety net.** No timeout, no retry, no message outside the debug log; a code is only valid for 7 days and nothing says when it expires; one plan is held, so a rider with two routes in a week re-types codes. | `fetchPlanFromCode`, `persistState` |
| R10 | **Update check hits the GitHub API on every window open** (60/h unauthenticated per address) and compares with a hard-coded `'0.6.4'` that must be edited by hand on each release. | `loadCurrentVersion`, `checkLatestVersion` |
| R11 | **Pacing model is time-only.** The finish prediction scales the remaining plan time by actual/plan time over completed intervals (clamped 0.25–4). It ignores power: a rider 20 W under target on a climb and 20 W over on the flat predicts "on plan". Acceptable as a first estimate; the plan file's per-interval `speed_kmh`, `duration_s` and the cards allow a power-aware remaining-time estimate later. | `computePacingRatio`, `computeFinishPrediction` |

### 3.2 Performance (resource use)

| # | Finding | Where |
|---|---|---|
| P1 | **Console output on every tick.** `renderPlanSummary` and `updateDistanceFlag` log three to four lines per telemetry tick with object arguments (plan summary, last interval); Electron formats every one, with DevTools attached or not. 24 `console.log` calls in the dashboard alone. | `renderPlanSummary`, `updateDistanceFlag`, `setPlan` |
| P2 | **`backdrop-filter: blur()` on every window's root panel** (five places, 10–16 px). On a transparent always-on-top window the compositor re-blurs the game behind the panel every frame; this is the most expensive thing the mod does and it costs GPU time the game needs. | `css/tt-dashboard.css` `.tt-wrapper`; `css/tt-interval-list.css` `.window`, `.table-header`; `css/tt-field-dashboard.css` `.window`, `thead th` |
| P3 | **O(n) interval search several times per tick.** `findCurrentInterval` runs in `handleWatching` and again in `updateDashboard`, each `getScaledDistanceKm` call re-reads the plan total and `intervals.at(-1)`; `formatDistanceToNext`, `updateDistanceProgress`, `setUpcomingDetails` repeat the scaling. Fine at 20 intervals, not at the 290 the README describes. | `findCurrentInterval`, `getScaledDistanceKm` (both windows) |
| P4 | **Whole tables rebuilt.** The field dashboard replaces every row every second for every rider ever seen; the interval list rebuilds all rows on each 400 ms window while anything changes and sets cells by `innerHTML`. | `tt-field-dashboard.mjs` `renderRows`; `tt-interval-list.mjs` `renderTable` |
| P5 | **Field memory grows for the whole session.** 10 m checkpoints, up to 6,000 per rider, for every rider ever seen (`persistentRiders` never evicts), plus `computeMetrics` per rider per tick. A 100-rider TT is tens of megabytes and a table of ghosts at 40 % opacity. | `recordCheckpoint`, `handleNearby`, `MAX_CHECKPOINT_HISTORY` |
| P6 | **Storage churn.** `persistState` writes the whole plan into the window's localStorage on every bias or offset click; every shared-state patch re-serialises the plan snapshot and fires `globalupdate` in all windows, where R8's signature check runs. | `persistState`, `persistSharedState`, `shared-plan-utils.mjs` |
| P7 | **Unconditional DOM writes each tick:** ~15 `textContent` writes, six SVG `d` rewrites (with a CSS `transition: d`), class toggles, `hidden` flips, with no change detection. Sauce ships `softTextContent`/`softInnerHTML` for this. | `updateDashboard`, `renderPlanSummary`, `updateGauge*` |
| P8 | **Every window is a full engine** with its own subscription and its own copy of the heavy code. Acceptable once the engine is cheap (budget in §7); today each window is heavy. | all three windows |

### 3.3 Compatibility, packaging, release

| # | Finding | Where |
|---|---|---|
| X1 | **The tag workflow cannot have worked.** `${{ github.repository }}` is `owner/repo`, so the zip path is `dist/BlueHorizon157/…` in a directory that does not exist; both actions used are archived. `scripts/release.sh` is the real release path (git archive with the repo name as the top-level folder). | `.github/workflows/release-on-tag.yml`, `scripts/release.sh` |
| X2 | **The mod id is the folder name.** No `id` in the manifest; Sauce derives it from `zwiftgopher-s4z-mods`, and window types (`<modId>-<windowId>`) and per-window storage keys hang off it. A renamed folder loses every setting. | `manifest.json` |
| X3 | **Not in the Sauce mod directory** (`mods.sauce.llc/directory.json`). Listed mods get one-click install, hash-verified automatic updates at Sauce start and a `minVersion`; the mod's own update check (R10) becomes unnecessary. | — |
| X4 | **Plan file v1 is landing** (planner Phase 5.1, mod 94c61a3). The mod still reads `start_km/end_km`, `summary.distance_km`, `duration_text` and parses duration strings in two copies of `parseDurationSeconds`; the file has metres, `start_time_s`, `route.id`, `start_offset_m`, `cards`. Read the file first, legacy second; shared codes saved before the file still load (`TTSharedPlans::load`). | `setPlan`, `parseDurationSeconds`, `getPlanTotalDistanceKm` |
| X5 | **The docs are gitignored.** `.gitignore` has `pages/*.md`, so `pages/README.md` and `pages/PERFORMANCE_AUDIT.md` are untracked, absent from clones and releases, and the planner's own `.gitignore` rule (`**/*.md`, `git add -f`) is a known trap. | `.gitignore` |
| X6 | **Settings keys are inconsistent.** `data-settings-key` is set on every page but `settingsStore`/`initSettingsForm` are never used; the dashboard keeps preferences, the plan and the home athlete in one `tt-dashboard-state` object; the interval list has a settings key and no settings page. | all pages |
| X7 | **CSP and remote calls.** `script-src 'self' 'unsafe-inline'` and fetches to GitHub and zwiftgopher.com with no `connect-src`. Works in Sauce; worth tightening when the version check goes. | `tt-dashboard.html` |

### 3.4 Readability and UX

| # | Finding | Where |
|---|---|---|
| U1 | **Text sizes of 0.35–0.5 rem.** Sauce's root font is `clamp(2.2mm, 7vw, 18mm)`: at the 400 px default width that is ~28 px, so the labels are 10–14 px; shrink the window to 300 px and the root is 21 px, the labels 7–10 px. The version footer is 0.35 rem. Nothing in a HUD may fall under ~11 px at any width. | `css/tt-dashboard.css` (14 rules under 0.5 rem) |
| U2 | **Panels, not a HUD.** Dark 0.9-alpha boxes with blur, borders and drop shadows over the game. True transparency would be unreadable (no halo on any text), so the panels are the only readable option today. No background choice. | all three stylesheets |
| U3 | **Hierarchy is inverted for a TT.** "Time remaining" is the largest number at the top; the current target is 0.55 rem under the live power; "Next" is a 0.45 rem side-note; the one moment that matters (the power change in 10 s) has no emphasis beyond a purple tick on the arc. For a TT the order is: target now → next, and when → how I am doing (band, W') → finish. | `tt-dashboard.html`, `css/tt-dashboard.css` |
| U4 | **Controls live inside the overlay:** offset ±, bias ±, plan code, Load, refresh, version footer, debug log all take HUD space during the race. | `tt-dashboard.html` |
| U5 | **Field dashboard** has seven columns at 10–12 px; "Position n / m" counts riders the window has seen, while Sauce provides `eventPosition` and `eventParticipants`; riders who left stay forever at 40 %. | `tt-field-dashboard.mjs` `renderRows` |
| U6 | **Interval list** has the right content and a cramped presentation: seven columns, "exp / act / tgt" strings in one cell, duration and power deltas on second lines. | `tt-interval-list.html`, `updateSummary` |
| U7 | **Titlebar handling** hides Sauce's titlebar with CSS and shows it on right-click, never hiding it again, instead of Sauce's settings-mode titlebar from `initInteractionListeners`. | `initTitlebarReveal`, `contextmenu` listeners, both stylesheets |

### 3.5 Code health

| # | Finding |
|---|---|
| C1 | 4,500 lines across two windows with roughly 60 % duplication: tracking, offsets, scaling, prediction normalisation, athlete id, spectate, channels, duration parsing, plan signature. |
| C2 | Dead code: `els.gaugeTargetMark`, `els.smoothingSelect` (the select lives on the settings page), `initDebugSimControls` (empty container), `setDefaultPlanPrediction`, `formatMetric`, `resetLiveDataForSimulation`, `advancePlanWbal` in the list; CSS for `.up-next`, `.micro-grid`, `.loader-grid`, `.control-chip-toggle`, `.band-buttons`, duplicated `.version-status` hover rule. |
| C3 | No tests, no fixtures, no lint, no replay; every behaviour was verified in live events. |
| C4 | Comments narrate history ("No more continuous tracking line", "Simulation buttons removed") and the perf audit's claims (40–51 % backend CPU before) were never re-measured after. |

---

## 4. Target design

### 4.1 Architecture

```
pages/
  hud.html            one page, three layouts (?layout=strip|dial|stack), three manifest windows
  interval-list.html  compact table
  field.html          compact rivals table
  settings.html       one settings page (?for=hud|list|field)
  css/tokens.css      colours, halo, background modes, scale   (shared)
  css/hud.css  css/list.css  css/field.css  css/settings.css
  src/engine/plan.mjs      normalise plan file v1 and legacy payloads → metres, cumulative seconds, cp, W', route id
  src/engine/clock.mjs     race clock: subgroup start time, else first eventDistance > 0, else manual start
  src/engine/align.mjs     event distance → plan distance (start_offset_m, manual offset, route match); mismatch flag
  src/engine/cursor.mjs    locate(distance) in O(log n); look-ahead view; boundary countdown
  src/engine/tracking.mjs  per-interval stats, partial intervals, pacing, finish prediction
  src/engine/wbal.mjs      the planner's W'bal kernel in JS (same recovery model and cap)
  src/engine/engine.mjs    pure state machine: idle → armed → racing → finished; tick(telemetry, now) → view
  src/sauce.mjs            subscribe/rpc/storage wrappers; replay shim for ?replay=
  src/store.mjs            plan library, controls, migration of old keys
  src/views/hud.mjs  list.mjs  field.mjs  settings.mjs   render view models with diff writes
  src/version.mjs          generated by scripts/release.sh
docs/   this plan, README, fixtures guide
test/   node --test; fixtures/ (plan files + telemetry JSONL)
```

Each window subscribes to Sauce itself and runs the engine on its own telemetry. The engine
is pure (no DOM, no storage, no timers), so Node tests drive it from recorded telemetry and
two windows always agree. Shared storage holds only the plan library and the controls
(offset, bias, active plan), written when the rider changes them, never per tick.

### 4.2 Engine contract

- `createEngine({plan, prefs})`; `engine.tick(athleteData, nowMs)`; `engine.view()` returns a
  flat view model (`target`, `livePower`, `bandState`, `next`, `boundaryIn` (m and s),
  `wbal`, `eta`, `delta`, `intervalProgress`, `state`, `warnings`); `engine.control(name,
  value)`; `engine.event('reset' | 'start' | 'plan')`.
- **States.** `idle` (no plan or no rider), `armed` (plan matches the event route or the
  rider pressed Start; stats cleared), `racing` (clock running), `finished` (eventDistance
  ≥ plan length or event remaining 0). Transitions are logged to the debug log; nothing else
  clears statistics.
- **Clock.** Three cases, chosen from the event (`rpc.getEvent` / `getEventSubgroup`:
  `eventType`, `timeTrialOptions`) and the state (`eventSubgroupId`, `routeId`):
  - **TT event** (staggered start): the clock starts when the rider crosses the timing line,
    which is not the pen exit and not the end of the lead-in but a point a few metres to
    ~150 m after the pen exit (Dave, 2026-10-27; the planner models it as 150 m and adds 30 m
    from the pen, `route.start_offset_m`). The engine opens the first interval and starts the
    clock on the first tick where the rider is past the line. Which signal marks it (a jump in
    `state.time`, `eventDistance` leaving 0, `progress`, `roadTime`) is **unknown**: the Phase
    0 recorder captures a real TT start and Phase 1.2 picks the signal from the fixture, with
    the plan's `start_offset_m` as the fallback distance. Detection may be late by a tick: the
    first interval still opens at plan metre 0 (today's bug: it sometimes never opened).
  - **Group event or race** (mass start): there is no timing line; the clock runs from the
    gun (the subgroup's start time) and the rider's time includes the roll-out. The HUD says
    "not a TT event: the clock runs from the start" so the plan's time is read with that in
    mind.
  - **Free ride on the planned route** (route match or Start pressed): clock from the arm.
  Before the gun in any event, the HUD shows the countdown to the start.
- **Distance.** In an event, `state.eventDistance`; outside, `state.distance − distanceAtStart`.
  Plan distance = event distance + manual offset. The plan's `route.start_offset_m` is already
  in its metres. If the event's `remainingEnd` differs from the plan length by more than 1 %,
  the HUD says "plan is N m shorter/longer than the event" and keeps the plan's metres; no
  rescaling.
- **Look-ahead** (94c61a3) stays: the displayed target switches `lookAheadSec × speed` before
  the boundary; statistics switch at the boundary. One cursor, two views.
- **W'bal.** The planner's kernel ported (shared/wprimebalance semantics: spend above CP,
  recovery with the calibrated model and the TT cap), seeded full at the start, using the plan's
  `cp_used`/`wprime_used_j`. Golden test: riding the plan exactly reproduces each interval's
  `wbal_kj` within 0.1 kJ.
- **Prediction.** Remaining time = Σ remaining `duration_s` × pacing, where pacing starts at
  1 and is the time ratio over completed full intervals (today's rule), reported with a plain
  word ("on plan", "ahead 0:12", "behind 0:40"). Power-aware pacing (R11) is a later item.

### 4.3 Storage

| Key | Scope | Written when | Holds |
|---|---|---|---|
| `/zg-tt/plans` | global | plan loaded/removed | up to 5 plan files keyed by code: `{code, file, loadedAt, expiresAt}` |
| `/zg-tt/active` | global | plan chosen, route auto-match | `{code}` |
| `/zg-tt/controls` | global | offset/bias/reset pressed | `{offsetM, bias, resetAt}` |
| per-window `settingsStore` | window | settings page | layout, background mode, scale, halo, smoothing, band width, look-ahead, fields shown, colour-blind, debug |

A one-off migration reads `tt-dashboard-state` / `/tt-dashboards/shared-state`, keeps the
plan and the preferences, and deletes the old keys.

### 4.4 HUD system

Three layouts, one page, one view model. All sizes derive from one `--hud-scale`
(container-query based so the HUD scales with its window, with a floor so nothing drops under
11 px). Typeface: Saira (Sauce loads it), tabular numerals.

**Strip** (default; manifest `default_bounds` 560 × 96 at the top centre):

```
┌────────────────────────────────────────────────────────────────────────┐
│  NOW  312 W   ●318      │ NEXT  340 W ▲4.2%  in 0.42 km · 38 s │ W' ▮▮▮▮▯ 71% │ ETA 23:41  ahead 0:12 │
│  ▁▁▁▃▅█▅▃▁▁  (band meter)                                                                        │
└────────────────────────────────────────────────────────────────────────┘
```

**Dial** (300 × 300; today's gauge rebuilt): target band and live arc on the outer ring,
W' on the inner ring, the target as the dominant centre number, live power below it in the
band colour, next target and "in 0.42 km · 38 s" under the dial, interval progress as a thin
ring.

**Stack** (220 × 420, for a screen edge): NOW / live + band / NEXT / countdown / W' / ETA
in a column with a vertical interval-progress bar.

Shared behaviour:
- **Band colour** (one scheme everywhere): under = cool blue, on = green, over = red/orange;
  the state is also shown as a glyph (▼ ● ▲) and a word for colour-blind users.
- **The boundary moment.** Under 10 s or 100 m, the NEXT cell grows and pulses; at the
  boundary NOW takes NEXT's value with a 300 ms swap. This is the HUD's reason to exist.
- **Gradient glyph** (▲ ▼ with the percentage) next to the next target, since the planner's
  boundaries sit on gradient changes.
- **W'** as a bar with the planner's floor marked; turns red under 25 % of W'; the word
  "spending fast" when the spend rate exceeds the plan's for this interval.
- **ETA** with a word, not a sign: "on plan", "ahead 0:12", "behind 0:40"; before the gun,
  the countdown to the start.
- **Readability:** every glyph has a layered halo (`text-shadow` 0 0 2px + 0 0 6px, dark),
  readable on white snow and on black night; background modes clear / smoke (0.35) / dark
  (0.7) / solid; a "halo strength" setting; no blur anywhere.
- **States:** idle (code box, plan library, "waiting for Zwift"), armed (plan name, route,
  "ready"), racing, finished (final time vs plan), spectating (greyed, name).
- **Hover tray** (only while the pointer is over the HUD): offset ±, bias ±, Reset, Settings.
  Nothing else is on the overlay during the race.

### 4.5 The other widgets

- **Interval list:** header = plan name · plan time · ETA with word · avg target vs actual;
  rows = # · to (km) · W · time · grade · W'; after an interval completes its row shows the
  actual time and power as a small delta in the band colour; the current row is sticky at the
  top third; rows are keyed and diffed; 1 Hz. Same tokens and background modes.
- **Field:** pos (Sauce's `eventPosition`/`eventParticipants`) · rider · gap at equal
  distance · avg kph · w/kg · W' bar; checkpoints every 50 m on `eventDistance`, capped at
  the plan length, riders unseen for 2 min fade and are evicted after 10 min; rows diffed;
  1 Hz. The home rider's row is pinned.
- **Rivals strip** (new, decision 9): a one-line glanceable window (560 × 56) for the top
  or bottom edge. A horizontal track with the home rider at the centre and the nearest
  rivals ahead and behind as markers placed by gap at equal distance; for the two closest
  each side: name, gap in seconds and a **trend** (gaining / holding / losing, from the gap's
  change over the last 60 s and over the last plan sector), plus their speed over the last
  sector against yours. All of it comes from the field's checkpoints (time at equal
  distance), so "am I gaining on the rider ahead" is answered by the slope of the gap, not
  by Sauce's road gap. Same engine data as the field window; no extra subscriptions.

### 4.6 Settings

One settings page, sections per window: layout and look (layout, background, scale, halo,
colour-blind), pacing (smoothing default 3 s, band width, look-ahead), fields shown, plans
(library with route, time, expiry, remove; code entry), controls (offset, bias, Reset race),
advanced (debug log, telemetry recorder, replay). Bound with `common.initSettingsForm`.

### 4.7 Release and distribution

`scripts/release.sh` generates `pages/src/version.mjs` from `manifest.json`, builds the zip
with the stable folder name, creates the GitHub release; the tag workflow is deleted or
fixed to call the same script. The mod is submitted to the Sauce mod directory with a logo
and `minVersion`; the in-mod update check becomes a once-a-day, cached hint that links to the
release page (or goes away once the directory handles updates).

---

## 5. Plan of action

Effort: S ≤ 1 session, M = 2–3, L = 4+. Each phase ends with the checks in §7.

### Phase 0 — Guardrails and measurement (S, first)

| # | Item | Effort | Check |
|---|---|---|---|
| 0.1 | `test/` with `node --test`; plan fixtures: the planner goldens exported as plan files (`TT/fixtures/planner/*` → `test/fixtures/plans/`) plus one pre-file share payload. | S | tests run in CI-less `npm test` |
| 0.2 | **Telemetry recorder:** a debug setting that keeps the last two hours of `athlete/watching` and `nearby` ticks (trimmed to the fields the engine reads) and saves them as JSONL from the settings page. Dave records: one full TT from pen to finish, one late join, one solo ride of a planned route, one spectate switch. | S | four fixtures in `test/fixtures/telemetry/` |
| 0.3 | **Replay mode:** `?replay=<fixture>&speed=10` runs any window from a fixture with no Sauce (shim in `src/sauce.mjs`), for tests, screenshots and debugging. | S | a window plays a fixture end to end |
| 0.4 | Release hygiene: delete or fix the tag workflow (X1), `release.sh` writes `version.mjs`, docs move to `docs/` and are tracked (X5), `id` in the manifest (X2, decision 5). | S | release of 0.7.0-alpha from the script |
| 0.5 | **Perf baseline** on Dave's machine: renderer CPU %, GPU process %, heap per window at idle and during the full-TT replay, with and without `backdrop-filter`; recorded in §7. | S | numbers in this document |

### Phase 1 — One engine (M)

| # | Item | Effort | Check |
|---|---|---|---|
| 1.1 | `plan.mjs`: file v1 and legacy → one shape (metres, cumulative seconds, cp, W', route id, cards). Replaces `setPlan`'s distance "correction", both `parseDurationSeconds`, `computePlanSignature`. | S | plan fixtures load identically from file and legacy |
| 1.2 | `clock.mjs` (R1): subgroup start time via rpc, fallbacks, pre-start countdown. | S | full-TT fixture: elapsed at the finish equals the event result |
| 1.3 | `align.mjs` (R2): `eventDistance` / explicit start, manual offset, route match, mismatch flag; no rescaling. | S | late-join fixture enters the right interval; solo fixture arms on route match |
| 1.4 | `cursor.mjs` (P3, R4): one cursor, binary search, look-ahead view, boundary countdown in m and s. | S | 300-interval plan under 5 µs per tick |
| 1.5 | `tracking.mjs` (R4, R6): interval stats from the one cursor, partial intervals, pacing, prediction; no storage-driven resets. | M | today's correct numbers reproduced on the fixtures; the three failure cases in R6 no longer reset |
| 1.6 | `wbal.mjs` (R3): port of the planner kernel. | S | plan `wbal_kj` reproduced within 0.1 kJ |
| 1.7 | `engine.mjs`: the state machine; `view()`; debug log of transitions. Delete the eight detections, the BroadcastChannels, the postMessage bridge, publisher ids, signatures. | M | fixtures: states and transitions asserted |
| 1.8 | Wire the existing three windows to the engine behind their current HTML (no visual change yet) so Phase 1 ships alone. | S | replay side by side with 0.6.4: differences are the fixed bugs only |

### Phase 2 — State and plumbing (S–M)

| # | Item | Effort |
|---|---|---|
| 2.1 | `store.mjs`: new keys (§4.3), one-off migration, plan library with expiry shown, auto-select by route id. | S |
| 2.2 | `settingsStore` + `initSettingsForm` for preferences; the single settings page skeleton. | S |
| 2.3 | Plan fetch with timeout, retry, uppercase, clear messages; the code box also accepts a pasted planner URL. | S |
| 2.4 | Version from `version.mjs`; update hint at most daily; Sauce `cpuState`-aware (skip work while hidden: `common.isVisible()`). | S |
| 2.5 | Quiet mode: no console output unless debug; `softTextContent` everywhere; rAF-batched writes. | S |

### Phase 3 — The HUD (M–L)

| # | Item | Effort |
|---|---|---|
| 3.1 | `tokens.css`: colours, band states, halo, background modes, scale with container queries and the 11 px floor; verified over three Zwift captures (snow, jungle, night) in replay. | S |
| 3.2 | `hud.html` + `views/hud.mjs`: the view model rendered with diff writes; states idle/armed/racing/finished/spectating; hover tray. | M |
| 3.3 | The three layouts (strip, dial, stack) as three manifest windows sharing the page (`query.layout`), each with its own default bounds and aspect ratio. Use the `frontend-design` skill for the visual pass. | M |
| 3.4 | The boundary moment: countdown, pulse, swap; gradient glyph; W' bar with floor; ETA words; pre-start countdown. | S |
| 3.5 | Settings page sections for the HUD (layout, look, pacing, fields). | S |
| 3.6 | Screenshots from replay over the three backgrounds for the README and the planner's `TT/sauce4zwift-mod.html`. | S |

### Phase 4 — List and field (M)

| # | Item | Effort |
|---|---|---|
| 4.1 | Interval list on the engine view: keyed row diffing at 1 Hz, the compact columns, sticky current row, actual-vs-plan deltas, tokens and background modes. | M |
| 4.2 | Field on `nearby` + the engine clock: Sauce's event position, checkpoints on `eventDistance` at 50 m with eviction, row diffing, pinned home row, compact columns. | M |
| 4.3 | Remove the per-window titlebar hacks; Sauce's settings-mode titlebar everywhere. | S |
| 4.4 | Rivals strip (§4.5): gap-at-equal-distance track, trend over 60 s and over the last sector, sector speed; its own manifest window. | M |

### Phase 5 — Planner coupling and distribution (M)

| # | Item | Effort |
|---|---|---|
| 5.1 | Plan file first (X4): read `start_m/end_m/start_time_s`, `route.id`, `cards`; keep the legacy path; the planner's rule "never remove the fields the mod reads" becomes "the mod reads the file; legacy is frozen". | S |
| 5.2 | Race-day strategy switch from `cards` (Fastest / Balanced / Safe), offered only before the start (idle/armed states and the settings page), never during the race, so the race HUD stays clean (decision 8). | S |
| 5.3 | Clipboard hint: a 6-character code on the clipboard when the HUD gains focus offers "Load ABC123"; the planner's share dialog keeps the "Riding with Sauce?" text. | S |
| 5.4 | Sauce mod directory submission (logo, zip layout, `minVersion`); README and `TT/sauce4zwift-mod.html` rewritten for the new windows. | S |
| 5.5 | Power-aware pacing (R11) using the file's per-interval speeds, behind a golden. | M, optional |

### Phase 6 — Validation (runs from Phase 0)

Race-day runs with the recorder on after every phase; predicted vs actual finish time and
per-interval times kept in `docs/validation.md`; perf budget re-measured on each release;
the bug list in §3 ticked off against fixtures, not memory.

---

## 6. Decisions (Dave, 2026-10-27)

1. **Windows:** three HUD windows (strip, dial, stack) sharing one page, plus list, field
   and the rivals strip.
2. **Engine per window**, deterministic; no cross-window publishing.
3. **W'bal:** the planner's kernel, with the plan's CP and W'. Not Sauce's `wBal`: Sauce
   defaults every rider to 20 kJ.
4. **Off the overlay:** debug log, version footer, offset/bias/Reset (hover tray and
   settings). The plan code stays easy and obvious: the idle state of every HUD is the code
   box, and the settings page has it too.
5. **Mod id:** set `"id"` in the manifest (`zwiftgopher-tt`); window positions are lost
   once.
6. **Sauce mod directory:** submit after Phase 5; alphas keep going through GitHub releases.
7. **Defaults:** smoothing 3 s, background smoke, layout strip, look-ahead 5 s; all of them
   settings.
8. **Strategy switch** from the file's cards: yes, but only before the start (5.2), so it
   cannot complicate the race HUD.
9. **Field:** its own window, plus a compact visual "rivals strip" (§4.5, Phase 4.4) that
   shows gaining/losing ground and sector speeds against the nearest rivals.
10. **Start now with Phase 0**; Phase 1 once the planner's Phase 5 is deployed (it is
    committed: 4120db9).

**Start-line facts (Dave):** in true TT events the clock starts at an imaginary line some
arbitrary distance after the pen exit (a few metres up to ~150 m), not at the pen exit and
not at the end of the lead-in. The first version of the mod could not detect it and the first
interval would not open. Non-TT events have no such line: the time runs from when the rider
starts pedalling, so plans ridden in non-TT events carry that discrepancy. See §4.2 (Clock).

---

## 7. Verification and budgets

Commands (after Phase 0):

```
npm test                              # node --test test/   (engine, wbal, align, plan)
node scripts/replay-check.mjs test/fixtures/telemetry/full-tt.jsonl   # engine end to end, prints finish vs event result
./scripts/release.sh v0.7.0-alpha --notes "..." --push               # writes version.mjs, zip, GitHub release
```

Per-window budget during a race at Sauce's telemetry rate (measured in replay at 1×, Chrome
task manager inside Sauce):

| Measure | Today (0.6.4, to be measured in 0.5) | Target |
|---|---|---|
| JS per tick, HUD | — | ≤ 0.5 ms average |
| DOM writes per tick, HUD | ~25 unconditional | only changed values, ≤ 10 |
| List / field render rate | every tick / 400 ms | ≤ 1 Hz, rows diffed |
| GPU: `backdrop-filter` | 5 panels | none |
| Console lines per tick | 3–4 | 0 (debug off) |
| Heap after a 2 h event, field | grows (P5) | flat, ≤ 20 MB |
| Storage writes per tick | 0–2 (prediction, avg) | 0 |
| Smallest text at 300 px width | ~7 px | ≥ 11 px |

Definition of done per window: replays of the four fixtures match the asserted states and
numbers; screenshots over the three backgrounds are legible at arm's length at 1080p; the
budget table holds.

---

## 8. Out of scope

- The web race overlay `TT/screen.php` (shares the plan file, not the code).
- TTT (team) support in the mod.
- Mobile/companion layouts beyond what Sauce's window scaling gives.
