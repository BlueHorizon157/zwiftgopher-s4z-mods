# TT Dashboard Performance Audit & Fixes

## Issues Identified

### Critical Performance Problems

1. **Dual Prediction Computation** (ELIMINATED)
   - **Before**: Both dashboard AND interval-list computed finish predictions independently on every telemetry tick
   - **Impact**: Double computation, double storage writes, cross-window event storms
   - **Fix**: Interval-list now consumes predictions from shared storage instead of computing them
   - Removed `computeFinishPrediction()` and `shareFinishPrediction()` from interval-list

2. **recomputeIntervals() in Hot Path** (ELIMINATED)
   - **Before**: `interval-list.mjs` called `recomputeIntervals()` in `handleWatching()` every telemetry tick
   - **Impact**: Full enriched interval array rebuild with W'bal calculations 10+ times per second
   - **Fix**: Only call `recomputeIntervals()` when interval index changes (`intervalChanged` guard)
   - **Result**: ~90% reduction in recompute calls

3. **Unconditional Storage Listener Re-renders** (ELIMINATED)
   - **Before**: `applyStoragePayload()` always called `recomputeIntervals()` + `render()`, even for prediction-only updates
   - **Impact**: Every dashboard prediction write triggered full recompute in interval-list
   - **Fix**: Added change tracking in `applyStoragePayload()`:
     - Only recompute when offset/bias/plan/spectate changes
     - Only render when something visible changed
     - Prediction updates trigger render without recompute

## Architecture Changes

### Finish Prediction Flow (New)

```
Dashboard:
  handleWatching() → 
  updateIntervalTracking() → 
  computeFinishPrediction() → 
  shareFinishPrediction() → 
  persistSharedState({finishPrediction})

Interval List:
  storage.addEventListener('globalupdate') → 
  applyStoragePayload() → 
  render() → 
  updateSummaryDuration() → 
  display state.persisted.finishPrediction
```

**Key Change**: Single source of truth (dashboard) for predictions; interval-list is pure consumer.

### recomputeIntervals() Call Sites (Validated)

Remaining calls are legitimate:
- `applyStoragePayload()` - when offset/bias change
- `setOffset()` - manual offset adjustment
- `setPlan()` - new plan loaded
- power bias change
- `handleWatching()` - **only when interval index changes** (new guard)
- `markEventComplete()` - event finishes
- `resetEventCompletionState()` - clearing stats

## Estimated Impact

### CPU Load
- **Before**: 40-51% backend CPU during active rides
- **Expected After**: ~15-25% (estimate based on eliminated work)
- **Eliminated**:
  - ~10 `recomputeIntervals()` calls/sec in hot path
  - ~10 duplicate prediction computations/sec
  - ~10 unnecessary storage writes/sec

### Cross-Window Thrashing
- **Before**: Both windows compute → write → trigger storage events → other window re-renders
- **After**: Dashboard writes predictions, interval-list just re-renders summary (no recompute)

### Remaining Work Loops

**Dashboard** (primary pacing UI):
- `handleWatching()` every telemetry tick:
  - Update interval tracking (lightweight)
  - Compute finish prediction (unavoidable, needed for countdown)
  - Render gauge/countdown/upcoming interval
  - Write prediction to shared storage (~10 writes/sec, throttled by signature check)

**Interval-List** (detail table):
- `handleWatching()` every telemetry tick:
  - Update interval tracking (lightweight)
  - Render table (throttled to 400ms cooldown, uses lightweight active-row sync between rebuilds)
  - `recomputeIntervals()` only on interval change (rare)
- Storage listener:
  - Render only when predictions/spectate change (no recompute unless offset/bias change)

## Testing Checklist

- [ ] Dashboard countdown shows smooth updates without flicker
- [ ] Interval-list table highlights active interval correctly
- [ ] Finish prediction appears in both windows with same value
- [ ] Plan changes propagate to both windows
- [ ] Offset adjustments update both windows
- [ ] Backend CPU load stays below 25% during active rides
- [ ] No Sauce crashes during 30+ minute rides with both windows open

## Code Changes Summary

### `/tt-interval-list.mjs`

1. **updateSummaryDuration()**: Removed `computeFinishPrediction()` call, now reads `state.persisted.finishPrediction`
2. **handleWatching()**: Added `intervalChanged` guard before calling `recomputeIntervals()`
3. **resetEventCompletionState()**: Removed `shareFinishPrediction(null)` call
4. **Removed functions**: `computeFinishPrediction()`, `shareFinishPrediction()` (no longer needed)
5. **applyStoragePayload()**: Added change tracking to avoid unnecessary recomputes/renders

### `/tt-dashboard.mjs`

No changes required - already sole source of predictions with signature-based throttling.

## Commit Message

```
perf(tt): eliminate dual prediction computation and recompute thrashing

- Remove prediction computation from interval-list; consume from dashboard instead
- Guard recomputeIntervals() to only run on interval changes, not every tick
- Add change tracking to applyStoragePayload() to avoid unnecessary work
- Reduces cross-window storage event storms and CPU load
```
