# TT Interval Surfaces

This directory hosts the two browser surfaces that power the Zwift TT toolkit:

- `tt-dashboard.mjs` renders the pacing dashboard (gauges, finish countdown, debug view).
- `tt-interval-list.mjs` renders the detailed interval table (target vs. actual metrics for every block).

Both screens can be opened independently, and they cooperate through `/tt-dashboards/shared-state` in `localStorage`.

## How the plan metre is found (mod, 2026-11-10)

The mod places the rider on the plan's metres (`pages/src/engine/align.mjs`, `course.mjs`,
`engine.mjs`). Two things had to be found: where the timing line is on the plan's route data,
and how the game's `eventDistance` (zero at the line) maps onto that data.

- **The course match (the course tracker, `course.mjs`).** When the plan file carries
  `route.course` (format `zg-course/1`, written by the planner: the planner's own course on the
  plan's metres, simplified to 1 m, no gap over 100 m), the rider's lat/lng is matched onto the
  course. A fix counts when it lies within 10 m of the road; the course's segments are indexed on a
  50 m grid, so a fix costs a few cells, and the course's own crossings and laps are candidates
  together. Once four fixes agree on a line over 30 m of `eventDistance`, the tracker locks, and the
  plan metre is the locked metre plus the odometer (`eventDistance` x `route_m_per_game_m`). Each
  later fix that lies within 40 m of the odometer's metre pulls the metre 15 % of the way to it. The
  metre never goes backwards. Without a fix for 600 m of odometer the lock is lost, but the line is
  kept: the metre runs on from it by the odometer (carried) until a fix relocks, and a relock never
  moves the metre back. Only before the first lock does the old rule place the rider. A zero reading
  once racing is a dropped reading (missing), and an odometer step no rider could ride in the tick
  (45 m or more over two seconds) is held back one tick; if it persists it is taken as a real jump.
  A course may mark stretches the planner drew where its route data has no road (`gaps`: the end of
  a lap that does not join up in the data). No fix is taken there, and a locked rider is carried
  through on the odometer with the lock kept, however long the stretch.
- **A plan out of step with its race.** The road is believed for a timing line up to 1500 m into
  the plan (300 m until 2026-11-12, see the Hilly Route race below). When the line the road gives is
  100 m or more from where the plan has it, the targets still follow the road and the HUD says
  "plan off by 429 m" (the figure first found, kept all race; the tip says which end of the race
  is not in the plan). A plan with a course that is 500 m into its event with no match says "course
  not matched: targets by distance".
- **The old rule (the fallback until the lock, and for plans without a course).** The line is the
  plan length minus the event length when that is a stretch of 0 to 500 m, else the file's
  `start_line_m` (0 on most files), and the plan metre is `eventDistance` plus that line.
  Free rides and plans from here never use the course.
- **The finish.** With the event's length known, the race ends when Sauce's distance to go is spent,
  not at the plan's last metre. With the course locked, the finish metre is the rider's metre plus
  the distance to go, so it can lie past the plan's end; the last interval stays the target until
  then, and the finished time is the clock's at that tick. The plan's pace carries on past the end.
- **The clock.** Zwift's clock, or the event distance, starts it at the line. Once the course locks,
  the plan time at the start is re-anchored to the matched line.
- **A mass start.** The game's distance and timer start at a timing line there too, so the plan's
  clock starts at the line exactly as in a TT. The result counts from the gun, so the engine keeps
  the seconds from the gun to the line (`race.gunToLineS`: the event's start from Sauce, Unix
  time, against the crossing on Zwift's world clock, which counts from 2014-10-22; `clock.mjs`
  `gunToLineS`) and gives the race time and the predicted finish on the result's clock as well
  (`race.officialElapsedS`, `race.officialTotalS`). The finish cell, the plan's time beside it and
  the field's clocks use those; the time to go and ahead or behind are the same on either clock.
  A window opened mid-race takes the crossing from Zwift's timer (to the second); with no start
  time from Sauce nothing is added and every time runs from the line.

Measured on Dave's California Dreamin' ride (route 966890401, 2026-11-10, plan NYC92U, the
recording in `test/fixtures/recordings/`): the line is at route-data metre 160.2 (+/- 2) and the
game's metres are 0.998656 x `eventDistance` + 160.17 (residual sd 1.65 m, max 5 m). The course
locks at `eventDistance` 37.6 m (the implied line 159.5 m), 3 s after the line. Against the
formula, over 3,976 locked race ticks: 100 % within 6 m (median error +0.3 m, worst 5.6 m). The
switches come within 0.6 s of the true crossing on 16 of the 17 boundaries (the tick spacing is 0.4
to 1.1 s); the one at 10059 m is 1.4 s: the rider's road projection and the tracker agree there, and the formula is 5 m ahead of
the road at that bend (the rider rides 3.7 m off the planner's line there). The finish comes at
the Sauce finish (`eventDistance` 21157.7, plan metre 21290 against the true 21287), with the clock
at 2095.6 s (Zwift: 2095 s). Without the course the same ride is late by 15 s median (34 s worst
at the bend): the old rule put the line at the pen.

Measured on Dave's Watopia Hilly Route race (route 2737483381, a 6.1 km custom distance, mass
start, no draft, 2026-11-11, ZwiftPower event 5780317, plan KM96SD; the recording and both plans
are in `test/fixtures/recordings/`, `test/recording-mass-start.test.mjs`):

- The gun went at 18:40:00 UTC. The game's distance and timer stayed at zero for 102 m out of the
  pen and started together 18.8 s after the gun. Line to finish was 686.1 s; ZwiftPower's time is
  704.888 s, from the gun. The engine's time from the gun is 704.92 s.
- The plan as raced was 429 m out of step: the planner had drawn 393 m of flat road before the
  start (the lap in its route data does not join up, and it put the missing metres at the wrong
  end), and the timing line is 36 m into the data. On that plan the rider is at
  0.99856 x `eventDistance` + 429.1.
- Mod 0.9.2 refused a line that far in (its window was 300 m), placed the rider by distance alone
  and changed every target 425 m late: 31 to 123 s, with the countdowns 21 s out on average. That
  is what "intervals off, countdowns erratic" was; the mass start added only the 19 s between the
  two clocks.
- Now: on the plan as raced the course locks with the line at 429 m, every target changes within
  1.5 s of the rider reaching it on the road, and the HUD says the plan is off by 429 m. On the
  same race planned by the fixed planner (metre 0 at the timing line, the lap's end drawn where
  the game has it and marked as a gap) the line locks at 0.3 m (within 7 m all race), never out of
  step, and the countdowns are 3.8 s out on average.

Constants (`course.mjs`): 50 m grid, 15 m search, 10 m accept, 40 m gate, 15 % blend, 4 fixes over
30 m to lock, 8 m agreement, 300 m of fixes kept, a plausible line between -150 and 1500 m (the
planner padded up to 1400 m before a start; the shortest lap is 1.9 km), 600 m to unlock. The blend strength makes no difference to the switch timing on this ride (0.05 to 0.5
gave the same). A fix counts on a segment only where it projects inside that segment: a fix just
past a vertex projects onto the vertex with its along-road distance as the offset, which would
pass for a fix on the road for the first metres past every vertex (on a straight in the unit tests
that locked the line 6 m wrong).

## Finish-time prediction pipeline

1. **Plan ingestion** – Each module loads the shared plan snapshot published by whichever window fetched the plan. A plan is treated as an ordered set of intervals with power targets and durations.
2. **Distance alignment** – `resolvePlanDistanceKm()` blends event progress (if Zwift exposes it) with the rider's reported distance plus manual/auto offsets so that “where am I in the plan?” stays accurate even if the course is longer/shorter than planned.
3. **Interval stats accumulation** – Every telemetry tick updates `state.intervalStats[idx]` with elapsed milliseconds and a power integral. When an interval boundary is crossed we call `finalizeIntervalStats()` for the one that just ended and `beginIntervalStats()` for the next. The dashboard now performs this tracking locally, so predictions continue even if the interval list window never opens.
4. **Pacing ratio** – Once at least `MIN_PACING_SAMPLE_SECONDS` of completed intervals exist we compute an actual/plan ratio (clamped between 0.25× and 4×) that estimates how much quicker or slower the rider is moving than scripted.
5. **Prediction synthesis** – `computeFinishPrediction()` sums:
   - `elapsedSeconds`: actual time already ridden (including a partial current interval if available).
   - `planRemaining`: plan seconds still to go (full remaining intervals + any unfinished remainder of the current block).
   - `predictedRemaining = planRemaining * pacingRatio`.
   - `predictedSeconds = max(elapsedSeconds, elapsedSeconds + predictedRemaining)` and it is clamped so the finish clock can never show less time than has already elapsed.
6. **Shared broadcast** – The resulting structure (predicted total/remaining/delta seconds) is written to `/tt-dashboards/shared-state.finishPrediction` so whichever window is visible can render it instantly.

### Joining mid-race

Late joins are common, so the prediction logic takes extra steps to avoid double-counting the part of the race that already happened:

- **Partial interval detection** – `detectPartialInterval()` compares the actual distance where we first see the rider to the expected start distance of the active plan interval (scaled to the event distance). If the gap exceeds `INTERVAL_START_TOLERANCE_KM`, the first interval is marked `partial`. Partial intervals are time-tracked so pacing and elapsed clocks remain correct, but they are excluded from plan-completion percentages and pacing-ratio samples.
- **Progress pinning** – If Zwift provides `remaining`/`remainingEnd` telemetry we pin `resolveBaseDistanceKm()` to that progress rather than the raw bike distance. This ensures riders who hop in with late lap counters still enter the correct interval.
- **Plan offsets** – Manual offsets and the auto-offset derived from event completion are baked into every distance comparison, so mid-race starts can be aligned quickly without reloading the plan.
- **Look-ahead** – The next target shows a few seconds (setting, default 5 s) before its boundary, at the current speed. The planner places boundaries where the power changes, so the anticipation lives here.
- **Plan CP and W'** – The plan's W'bal is tracked with the CP and W' the plan was made with (`rider.cp_used`, `rider.wprime_used_j` in the plan file `zg-tt-plan/1`); older plans fall back to FTP and `settings.wPrime`.
- **Race elapsed snapshots** – When each interval completes, `finalizeIntervalStats()` snapshots the actual race elapsed time (`watching.state.time`) into `stats.raceElapsedSnapshot`. This becomes the authoritative baseline for predictions.
- **Prediction from baseline** – `computeFinishPrediction()` finds the last completed interval with a snapshot, uses that as the elapsed baseline, then adds predicted remaining time for future intervals. This ignores all interval durations before the baseline (many are zero for mid-race joins) and uses the event clock as truth.
- **Example**: Join at 2:13:35 (8015s), complete interval #143 at 2:14:00 (8040s):
  - Baseline: 8040s (from snapshot)
  - Remaining: intervals #144-293, predicted at ~35kph with pacing ratio
  - Predicted finish: 8040s + (remaining intervals × ratio)
  - Time remaining: remaining intervals × ratio (not comparing to full plan)
- **Delta calculation** – Shows how much time gained/lost vs plan for remaining intervals: `delta = (remainingPlanSeconds × pacingRatio) - remainingPlanSeconds = remainingPlanSeconds × (pacingRatio - 1)`. Positive = slower than plan, negative = faster. Only shown if delta ≥ 120 seconds (~1km at 30 km/h).
- **Safe countdowns** – Predictions always use the most recent race elapsed snapshot or current telemetry, ensuring displayed time can never be less than actual elapsed.

Because both windows maintain their own `intervalStats` arrays, they do not step on each other. When only the dashboard is open it now produces the shared finish prediction itself; when both are open their outputs agree because they ingest the same telemetry-derived plan distance and apply the same clamping rules.

## Troubleshooting checklist

- **Finish clock stuck at "—"** – Ensure a plan is loaded and either event progress or rider distance is available; without both, the system cannot map onto the scripted intervals.
- **Prediction seems slow/fast** – Confirm at least 60 seconds of intervals have been finished after joining. Until then `computePacingRatio()` defaults to 1× (plan pace).
- **Interval stats missing** – Verify `/tt-dashboards/shared-state` is writable. The snapshot helper (`shared-plan-utils.mjs`) trims heavy plan properties to avoid exceeding `localStorage` quotas.
