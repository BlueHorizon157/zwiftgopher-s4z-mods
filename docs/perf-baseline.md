# Performance baseline (REVAMP_PLAN.md Phase 0.5)

Measured on Dave's machine inside Sauce4Zwift, once per release. The 0.6.4 column is the
baseline the revamp is judged against; fill it in before Phase 1 lands.

## Procedure

1. Record a full TT with the telemetry recorder (settings → Telemetry recorder → Record),
   save it as `pages/fixtures/full-tt.jsonl` (export-ignored from releases).
2. Open each window with `?replay=full-tt&speed=1` appended to its URL (Sauce: right-click
   the window → settings mode, or open the page from the mod's windows list with the query
   added in `manifest.json` `query` temporarily). The window then plays the recording with
   no Zwift running, so the numbers are the mod's own.
3. Read, with only that window open:
   - **Renderer CPU %** and **GPU process %**: Sauce menu → Debug → Task manager (or
     Electron's task manager: `Shift+Esc` is Chrome only; use the OS monitor for the
     `Sauce for Zwift Helper (Renderer)` and `(GPU)` processes).
   - **JS per tick**: DevTools (right-click → Inspect) → Performance → record 60 s → the
     `handleWatching` / `handleNearby` self time ÷ ticks.
   - **Heap**: DevTools → Memory → heap snapshot at 5 min and at 2 h of replay (speed 10
     for the second, 12 min real time).
   - **Console lines per tick**: DevTools console, count over 10 ticks.
4. Repeat with `backdrop-filter` disabled (DevTools → Elements → untick the rule) to
   isolate the GPU cost.

## Results

| Measure | 0.6.4 dashboard | 0.6.4 list | 0.6.4 field | Target (every window) |
|---|---|---|---|---|
| Renderer CPU %, racing | | | | ≤ 1 |
| GPU process % attributable | | | | 0 beyond paint |
| JS per tick, ms | | | | ≤ 0.5 |
| DOM writes per tick | ~25 | rows × cells | rows × 7 | ≤ 10, changed values only |
| Heap after 2 h, MB | | | | flat, ≤ 20 |
| Console lines per tick | 3–4 | 0 | 0 | 0 |
| Storage writes per tick | 0–2 | 0 | 0 | 0 |

Date measured: — · Sauce version: — · Machine: —
