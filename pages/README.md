# TT Interval Surfaces

This directory hosts the two browser surfaces that power the Zwift TT toolkit:

- `tt-dashboard.mjs` renders the pacing dashboard (gauges, finish countdown, debug view).
- `tt-interval-list.mjs` renders the detailed interval table (target vs. actual metrics for every block).

Both screens can be opened independently, and they cooperate through `/tt-dashboards/shared-state` in `localStorage`.

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
