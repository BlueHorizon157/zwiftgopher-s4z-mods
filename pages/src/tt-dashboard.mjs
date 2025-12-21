import * as common from '/pages/src/common.mjs';
import {withSharedPlanSnapshot} from './shared-plan-utils.mjs';

const INSTANCE_ID = `tt-dashboard-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

const STORAGE_KEY = 'tt-dashboard-state';
const SHARED_STORAGE_KEY = '/tt-dashboards/shared-state';
const GAUGE_RADIUS = 110;
const GAUGE_START_ANGLE = 210; // 7 o'clock in degrees
const GAUGE_TOTAL_DEGREES = 300; // Arc spans 300 degrees (from 7 to 5 o'clock clockwise)
const DEFAULT_WPRIME = 20000;
const WBAL_RADIUS = GAUGE_RADIUS - 18;
const WBAL_NEGATIVE_RATIO = ((360 - GAUGE_TOTAL_DEGREES) / GAUGE_TOTAL_DEGREES) * 0.5;
const PLAN_WBAL_MIN_PERCENT = -100;
const PLAN_WBAL_MAX_PERCENT = 200;
const DEFAULT_TARGET_BAND_WIDTH = 5; // watts
const TARGET_BAND_MIN = 1;
const TARGET_BAND_MAX = 75;
const MIN_PACING_SAMPLE_SECONDS = 60;
const MIN_AVERAGE_TIME_MS = 10000;
const INTERVAL_START_TOLERANCE_KM = 0.02;
const DEBUG_MAX_LINES = 200; // cap the debug log size

function createEmptyMetrics() {
    return {
        ftp: null,
        ftpSource: null,
        wPrime: null,
        wPrimeSource: null,
        wBal: null,
        wBalPercent: null,
        weight: null,
        weightSource: null,
    };
}

function createPlanWBalState() {
    return {
        value: null,
        lastTime: null,
        cp: null,
        wPrime: null,
    };
}

const state = {
    plan: null,
    intervals: [],
    currentIndex: -1,
    displayedIntervalIndex: -1,
    planSignature: null,
    intervalStats: [],
    planDurationSeconds: null,
    planAvgPower: null,
    distanceOffset: 0,
    autoOffset: 0,
    usesEventProgress: false,
    powerBias: 1.0,
    watching: null,
    planPeakPower: 0,
    intervalStartTime: null,
    lastUpdateTime: null,
    powerIntegral: 0,
    timeIntegral: 0,
    intervalAvgPower: null,
    metrics: createEmptyMetrics(),
    planWBal: createPlanWBalState(),
    planWBalPercent: null,
    wbalTrackInitialized: false,
    eventDistanceMeters: null,
    eventRemainingMeters: null,
    eventProgressMeters: null,
    targetBandWidthW: DEFAULT_TARGET_BAND_WIDTH,
    showDebug: false,
    homeAthleteId: null,
    lastValidWatching: null,
    spectateActive: false,
    spectateReason: null,
    spectatingAthleteId: null,
    finishPrediction: null,
    sharedPredictionSignature: null,
    eventComplete: false,
    eventCompleteTimestamp: null,
    eventHasStarted: false,
    lastEventDistanceMeters: null,
    // Display-only power smoothing. Seconds: 0=Off, 0.5..5.0 allowed
    powerSmoothingSec: 0,
    // Rolling buffer of recent power samples for smoothing
    powerSamples: [],
    // Exponential moving average state for display power
    displayPowerEma: null,
    displayPowerEmaTsMs: null,
    // BroadcastChannel for ephemeral shared predictions
    predictionChan: null,
    predictionChanName: null,
    intervalAvgChan: null,
    intervalAvgChanName: null,
    lastPredictionBroadcastMs: 0,
    lastIntervalAvgBroadcastMs: 0,
    lastIntervalAvgSignature: null,
    lastAthleteId: null,
    lastEventSubgroupId: null,
    lastCourseId: null,
    versionCurrent: null,
    versionLatest: null,
    // Debug buffer management
    debugBuffer: [],
    lastDebugMessage: null,
    lastTrackingSnapshot: null,
    versionStatus: 'idle', // idle|checking|ok|update|error
};

const els = {};

function loadPersistedState() {
    const persisted = common.storage.get(STORAGE_KEY) || {};
    state.distanceOffset = persisted.distanceOffset ?? 0;
    state.powerBias = persisted.powerBias ?? 1;
    state.powerSmoothingSec = Number.isFinite(persisted.powerSmoothingSec)
        ? clamp(persisted.powerSmoothingSec, 0, 5)
        : 0;
    state.targetBandWidthW = normalizeTargetBandWidth(persisted.targetBandWidthW);
    state.showDebug = typeof persisted.showDebug === 'boolean' ? persisted.showDebug : false;
    if (persisted.plan) {
        setPlan(persisted.plan, {share: false, resetHome: false});
    } else {
        clearHomeAthleteId({share: true, persist: true});
    }
    updateBiasLabel();
    updateOffsetLabel();
    updateSmoothingLabel();
    updateDebugVisibility();
    persistSharedState({powerBias: state.powerBias});
    setSpectateState(false);
}

function persistState() {
    common.storage.set(STORAGE_KEY, {
        distanceOffset: state.distanceOffset,
        powerBias: state.powerBias,
        powerSmoothingSec: state.powerSmoothingSec,
        targetBandWidthW: getTargetBandWidth(),
        showDebug: state.showDebug,
        plan: state.plan,
        homeAthleteId: state.homeAthleteId,
    });
}

function persistSharedState(patch) {
    if (!common.storage || !patch || typeof patch !== 'object') {
        return;
    }
    const base = common.storage.get(SHARED_STORAGE_KEY) || {};
    const next = {...base, ...withSharedPlanSnapshot(patch)};
    try {
        common.storage.set(SHARED_STORAGE_KEY, next);
    } catch (err) {
        console.error('Failed to persist shared TT dashboard state', err);
    }
}

function queryEls() {
    els.summary = document.getElementById('event-summary');
    els.summaryRoute = document.getElementById('summary-route');
    els.summaryEventDistance = document.getElementById('summary-event-distance');
    els.distanceFlag = document.getElementById('distance-flag');
    els.finishGlance = document.getElementById('finish-glance');
    els.finishCountdownValue = document.getElementById('finish-countdown-value');
    els.finishCountdownDelta = document.getElementById('finish-countdown-delta');
    els.finishRemainingValue = document.getElementById('finish-remaining-value');
    els.finishProgressValue = document.getElementById('finish-progress-value');

    els.offsetValue = document.getElementById('offset-value');
    els.biasValue = document.getElementById('bias-value');
    els.biasButtons = document.querySelectorAll('[data-action^="bias"]');
    els.offsetButtons = document.querySelectorAll('[data-action^="offset"]');
    els.smoothingSelect = document.getElementById('smoothing-window');
    els.smoothingValue = document.getElementById('smoothing-value');

    els.codeInput = document.getElementById('plan-code');
    els.fetchBtn = document.getElementById('fetch-plan');
    els.refreshBtn = document.getElementById('refresh-plan');

    els.gaugePower = document.getElementById('gauge-power');
    els.gaugeWkg = document.getElementById('gauge-wkg');
    els.gaugeTargetPower = document.getElementById('gauge-target-power');
    els.gaugeTargetArc = document.getElementById('gauge-target');
    els.gaugeCurrentArc = document.getElementById('gauge-current');
    els.gaugeTargetMark = document.getElementById('gauge-target-mark');
    els.gaugeAvgPower = document.getElementById('gauge-avg-power');
    els.gaugeWbalTrack = document.getElementById('gauge-wbal-track');
    els.gaugeWbalPositive = document.getElementById('gauge-wbal-positive');
    els.gaugeWbalNegative = document.getElementById('gauge-wbal-negative');
    els.gaugeCadence = document.getElementById('gauge-cadence');
    els.gaugeGradient = document.getElementById('gauge-gradient');

    els.distanceToNext = document.getElementById('distance-to-next');

    els.upcomingTargetPower = document.getElementById('upcoming-target-power');
    els.upcomingTargetDesc = document.getElementById('upcoming-target-desc');
    els.upcomingTargetRange = document.getElementById('upcoming-target-range');
    els.upcomingTargetDuration = document.getElementById('upcoming-target-duration');

    els.nextLabel = document.getElementById('next-label');
    els.distanceProgress = document.getElementById('distance-progress');
    els.distanceProgressFill = document.getElementById('distance-progress-fill');

    els.log = document.getElementById('debug-log');
    els.spectateBanner = document.getElementById('spectate-banner');
    els.versionFooter = document.getElementById('version-footer');
    els.versionCurrent = document.getElementById('version-current');
    els.versionStatus = document.getElementById('version-status');
    updateSpectateBanner();
}

function initControls() {
    els.biasButtons.forEach(btn => btn.addEventListener('click', () => {
        const dir = btn.dataset.action === 'bias-up' ? 1 : -1;
        state.powerBias = clamp(state.powerBias + dir * 0.01, 0.8, 1.3);
        persistState();
        persistSharedState({powerBias: state.powerBias});
        updateBiasLabel();
        updateDashboard();
    }));

    els.offsetButtons.forEach(btn => btn.addEventListener('click', () => {
        const dir = btn.dataset.action === 'offset-up' ? 1 : -1;
        updateManualOffset(state.distanceOffset + dir * 10);
    }));

    if (els.smoothingSelect) {
        // Populate select value on load
        const initVal = Number.isFinite(state.powerSmoothingSec) ? state.powerSmoothingSec : 0;
        els.smoothingSelect.value = String(initVal);
        els.smoothingSelect.addEventListener('change', () => {
            const raw = parseFloat(els.smoothingSelect.value);
            const val = Number.isFinite(raw) ? raw : 0;
            // Accept only steps of 0.5s within bounds
            const stepped = Math.round(val * 2) / 2;
            state.powerSmoothingSec = clamp(stepped, 0, 5);
            updateSmoothingLabel();
            persistState();
            updateDashboard();
        });
    }

    els.fetchBtn.addEventListener('click', fetchPlanFromCode);
    
    els.refreshBtn.addEventListener('click', () => {
        console.log('[REFRESH] Manual reset triggered - clearing all interval tracking data');
        resetIntervalTracking();
        persistSharedState({clearStatsTimestamp: Date.now()});
        resetAutoOffset();
        // Also reset event detection state to allow for fresh detection
        state.eventHasStarted = false;
        state.lastEventDistanceMeters = null;
        // Note: We keep lastAthleteId/lastEventSubgroupId/lastCourseId to still detect rider/event swaps
        updateDashboard();
        // Signal to interval list to clear its stats too
        persistSharedState({clearStatsTimestamp: Date.now()});
    });
}

function setPlan(plan, {share=true, resetHome=true}={}) {
    console.log('[setPlan] plan.summary=', plan?.summary, 'intervals.length=', plan?.intervals?.length, 'lastInterval=', plan?.intervals?.at(-1));
    
    // Fix incorrect summary.distance_km by recalculating from intervals (source of truth)
    if (plan?.intervals && Array.isArray(plan.intervals) && plan.intervals.length > 0) {
        const lastInterval = plan.intervals.at(-1);
        const lastEndKm = Number(lastInterval?.end_km);
        if (Number.isFinite(lastEndKm) && lastEndKm > 0) {
            if (!plan.summary) {
                plan.summary = {};
            }
            const oldDistance = plan.summary.distance_km;
            plan.summary.distance_km = lastEndKm;
            if (oldDistance !== lastEndKm) {
                console.log('[setPlan] ✓ CORRECTED summary.distance_km from', oldDistance, 'to', lastEndKm);
            }
        }
    }
    
    state.plan = plan ?? null;
    state.intervals = Array.isArray(plan?.intervals) ? plan.intervals : [];
    state.currentIndex = -1;
    state.displayedIntervalIndex = -1;
    state.intervalStats = [];
    state.planSignature = computePlanSignature(state.plan);
    state.planPeakPower = state.intervals.reduce((max, interval) =>
        Math.max(max, Number(interval.power_w) || 0), 0);
    state.intervalStartTime = null;
    state.lastUpdateTime = null;
    state.powerIntegral = 0;
    state.timeIntegral = 0;
    state.intervalAvgPower = null;
    state.eventComplete = false;
    state.eventCompleteTimestamp = null;
    state.eventHasStarted = false;
    state.lastEventDistanceMeters = null;
    console.log('[setPlan] Reset event start detection flags');
    const durationStats = sumDurations(state.intervals);
    state.planDurationSeconds = durationStats.totalSeconds;
    state.planAvgPower = durationStats.totalSeconds > 0 && durationStats.totalWork > 0
        ? durationStats.totalWork / durationStats.totalSeconds
        : null;
    // Reset user-adjustable pacing knobs to match the online planner defaults
    state.powerBias = 1.0;
    resetMetrics();
    resetPlanWBal();
    resetAutoOffset();
    state.finishPrediction = null;
    state.sharedPredictionSignature = null;
    shareFinishPrediction(null);
    shareIntervalAvgPower(null);
    if (resetHome) {
        clearHomeAthleteId();
    }
    updateBiasLabel();
    updateDashboard();
    if (share) {
        persistSharedState({plan: state.plan, powerBias: state.powerBias});
        // Signal to interval-list to clear its stats when a new plan is loaded
        // This ensures a clean slate for interval tracking
        persistSharedState({clearStatsTimestamp: Date.now()});
    }
}

function clearPlan({share=true, resetHome=true}={}) {
    state.plan = null;
    state.intervals = [];
    state.currentIndex = -1;
    state.displayedIntervalIndex = -1;
    state.intervalStats = [];
    state.planSignature = null;
    state.planPeakPower = 0;
    state.intervalStartTime = null;
    state.lastUpdateTime = null;
    state.powerIntegral = 0;
    state.timeIntegral = 0;
    state.intervalAvgPower = null;
    state.planDurationSeconds = null;
    state.planAvgPower = null;
    state.eventComplete = false;
    state.eventCompleteTimestamp = null;
    resetMetrics();
    resetPlanWBal();
    resetAutoOffset();
    state.finishPrediction = null;
    state.sharedPredictionSignature = null;
    shareFinishPrediction(null);
    shareIntervalAvgPower(null);
    if (resetHome) {
        clearHomeAthleteId();
    }
    persistState();
    updateDashboard();
    if (share) {
        persistSharedState({plan: null});
    }
}

async function fetchPlanFromCode() {
    const code = els.codeInput.value.trim();
    if (!code) {
        log('Enter a plan code first.');
        return;
    }
    try {
        const resp = await fetch(`https://zwiftgopher.com/TT/share-plan.php?action=load&code=${encodeURIComponent(code)}`);
        if (!resp.ok) {
            throw new Error(`HTTP ${resp.status}`);
        }
        const data = await resp.json();
        if (!data.success || !data.plan) {
            throw new Error(data.error || 'Failed to load plan');
        }
        const plan = data.plan;
        console.log('[fetchPlanFromCode] received plan from PHP: summary=', plan?.summary, 'intervals.length=', plan?.intervals?.length, 'lastInterval=', plan?.intervals?.at(-1));
        setPlan(plan);
        persistState();
        console.log('[fetchPlanFromCode] after setPlan: state.plan.summary=', state.plan?.summary);
        log('Plan loaded successfully.');
    } catch (err) {
        log('Plan load failed: ' + err.message);
    }
}

function renderPlanSummary(distanceKm) {
    if (!els.summary) {
        return;
    }
    els.summary.hidden = false;

    const eventDistanceKm = Number.isFinite(state.eventDistanceMeters)
        ? state.eventDistanceMeters / 1000
        : null;
    const eventProgressKm = Number.isFinite(state.eventProgressMeters)
        ? state.eventProgressMeters / 1000
        : null;
    const remainingKm = Number.isFinite(state.eventRemainingMeters)
        ? state.eventRemainingMeters / 1000
        : (eventDistanceKm && Number.isFinite(distanceKm)
            ? Math.max(0, eventDistanceKm - distanceKm)
            : null);

    if (els.summaryEventDistance) {
        els.summaryEventDistance.textContent = Number.isFinite(eventDistanceKm)
            ? `${eventDistanceKm.toFixed(1)} km event`
            : 'event distance —';
    }
    if (els.finishRemainingValue) {
        els.finishRemainingValue.textContent = Number.isFinite(remainingKm)
            ? `${remainingKm.toFixed(1)} km`
            : '— km';
    }
    if (els.finishProgressValue) {
        els.finishProgressValue.textContent = formatProgressLine(eventProgressKm, eventDistanceKm);
    }

    if (!state.plan) {
        els.summaryRoute.textContent = 'TT plan not loaded';
        updateDistanceFlag(null, eventDistanceKm);
        if (els.finishGlance) {
            els.finishGlance.hidden = true;
        }
        return;
    }

    const route = state.plan.route?.name ?? 'Custom plan';
    els.summaryRoute.textContent = route;
    if (els.finishGlance) {
        els.finishGlance.hidden = false;
    }
    const totalKm = getPlanTotalDistanceKm();
    console.log('[updateSummary] state.plan.summary=', state.plan?.summary, 'state.intervals.at(-1)=', state.intervals?.at(-1), 'totalKm=', totalKm, 'eventDistanceKm=', eventDistanceKm);
    updateDistanceFlag(totalKm, eventDistanceKm);
}

function formatProgressLine(eventProgressKm, eventDistanceKm) {
    if (Number.isFinite(eventProgressKm) && Number.isFinite(eventDistanceKm)) {
        return `${eventProgressKm.toFixed(1)} / ${eventDistanceKm.toFixed(1)} km`;
    }
    if (Number.isFinite(eventProgressKm)) {
        return `${eventProgressKm.toFixed(1)} km`;
    }
    if (Number.isFinite(eventDistanceKm)) {
        return `${eventDistanceKm.toFixed(1)} km course`;
    }
    return 'waiting for distance…';
}

function updateDistanceFlag(planKm, eventKm) {
    if (!els.distanceFlag) {
        return;
    }
    if (!Number.isFinite(planKm) || !Number.isFinite(eventKm)) {
        console.log('[distanceFlag] hiding: planKm=', planKm, 'eventKm=', eventKm);
        els.distanceFlag.classList.add('hidden');
        els.distanceFlag.removeAttribute('title');
        return;
    }
    const delta = eventKm - planKm;
    const threshold = 1.0; // km — hide differences smaller than 1 km per UX feedback
    console.log('[distanceFlag] planKm=', planKm, 'eventKm=', eventKm, 'delta=', delta, 'threshold=', threshold);
    if (Math.abs(delta) < threshold) {
        console.log('[distanceFlag] ✓ hiding: delta', delta, 'below threshold', threshold);
        els.distanceFlag.classList.add('hidden');
        els.distanceFlag.removeAttribute('title');
        return;
    }
    const sign = delta >= 0 ? '+' : '-';
    els.distanceFlag.textContent = `plan Δ ${sign}${Math.abs(delta).toFixed(1)} km`;
    els.distanceFlag.title = `Plan ${planKm.toFixed(1)} km vs event ${eventKm.toFixed(1)} km`;
    els.distanceFlag.classList.remove('hidden');
    console.log('[distanceFlag] ⚠️ SHOWING:', els.distanceFlag.textContent);
}

function updateFinishCountdown() {
    if (!els.finishGlance) {
        return;
    }
    const hasPlan = Boolean(state.plan);
    els.finishGlance.hidden = !hasPlan;
    if (!hasPlan) {
        if (els.finishCountdownValue) {
            els.finishCountdownValue.textContent = '—:—';
        }
        if (els.finishCountdownDelta) {
            els.finishCountdownDelta.hidden = true;
        }
        return;
    }
    const prediction = state.finishPrediction;
    const hasPrediction = prediction && Number.isFinite(prediction.remainingSeconds);
    
    // Show remaining time (critical for pacing decisions)
    if (els.finishCountdownValue) {
        if (hasPrediction) {
            // Calculate live countdown: remaining seconds minus elapsed since prediction was made
            const elapsedSincePrediction = prediction.updatedAt ? (Date.now() - prediction.updatedAt) / 1000 : 0;
            const liveRemaining = Math.max(prediction.remainingSeconds - elapsedSincePrediction, 0);
            els.finishCountdownValue.textContent = formatCountdown(liveRemaining);
        } else if (Number.isFinite(state.planDurationSeconds)) {
            els.finishCountdownValue.textContent = formatCountdown(state.planDurationSeconds);
        } else {
            els.finishCountdownValue.textContent = '—:—';
        }
    }
    
    if (els.finishCountdownDelta) {
        // Always use total deltaSeconds (predicted total - plan total) for consistency
        const delta = prediction?.deltaSeconds;
        if (hasPrediction && Number.isFinite(delta) && Math.abs(delta) >= 0.5) {
            els.finishCountdownDelta.textContent = `Δ ${formatDeltaSeconds(delta)}`;
            els.finishCountdownDelta.classList.toggle('positive', delta > 0);
            els.finishCountdownDelta.classList.toggle('negative', delta <= 0);
            els.finishCountdownDelta.hidden = false;
        } else {
            els.finishCountdownDelta.hidden = true;
        }
    }
}

function handleWatching(watching) {
    const athleteId = getWatchingAthleteId(watching);
    maybeAdoptHomeAthleteId(athleteId);
    const isSpectating = shouldBlockTelemetry(athleteId);
    if (isSpectating) {
        const wasSpectating = state.spectateActive;
        setSpectateState(true, formatSpectateReason(watching), {spectatingAthleteId: athleteId});
        if (state.intervalStartTime) {
            state.lastUpdateTime = Date.now();
        }
        if (state.lastValidWatching) {
            state.watching = state.lastValidWatching;
        } else {
            state.watching = null;
        }
        if (!wasSpectating) {
            log('Spectating another rider — TT stats paused.');
        }
        updateDashboard();
        return;
    }

    state.watching = watching ?? null;
    if (watching) {
        state.lastValidWatching = watching;
    }
    setSpectateState(false);

    const power = watching?.state?.power ?? watching?.stats?.power?.cur ?? null;
    const wBal = Number.isFinite(watching?.stats?.wBal) ? watching.stats.wBal : null;
    const cadence = watching?.state?.cadence;
    const hr = watching?.state?.heartrate;
    const avgPower = watching?.stats?.power?.avg;
    const speed = watching?.state?.speed;
    const gradient = watching?.state?.grade;
    const elapsedTime = watching?.state?.time;
    const ftpResolved = resolveMetric(getPlanFtp(), getTelemetryFtp(watching));
    const wPrimeResolved = resolveMetric(getPlanWPrime(), getTelemetryWPrime(watching));
    const weightResolved = resolveMetric(getPlanWeight(), getTelemetryWeight(watching));
    const wBalPercent = Number.isFinite(wBal) && Number.isFinite(wPrimeResolved.value) && wPrimeResolved.value > 0
        ? clamp((wBal / wPrimeResolved.value) * 100, 0, 200)
        : null;
    Object.assign(state.metrics, {
        ftp: ftpResolved.value,
        ftpSource: ftpResolved.source,
        wPrime: wPrimeResolved.value,
        wPrimeSource: wPrimeResolved.source,
        wBal,
        wBalPercent,
        weight: weightResolved.value,
        weightSource: weightResolved.source,
    });
    const actualDistanceMeters = deriveDistanceMeters(watching);
    updateEventTelemetryAndOffset(watching, actualDistanceMeters);
    updatePlanWBalFromTelemetry(power);
    const actualDistanceKm = Number.isFinite(actualDistanceMeters) ? actualDistanceMeters / 1000 : NaN;
    const planDistanceKm = resolvePlanDistanceKm(actualDistanceKm);
    if (state.plan && state.intervals.length) {
        const previousIndex = state.currentIndex;
        const nextIndex = findCurrentInterval(planDistanceKm);
        const intervalChanged = previousIndex !== nextIndex;
        // Only track interval stats after the event has started (i.e., after crossing the start line)
        // This prevents warmup power data from being included in interval averages
        if (state.eventHasStarted) {
            updateIntervalTracking(previousIndex, nextIndex, power, planDistanceKm);
        }
        state.currentIndex = nextIndex;
        
        // Keep finish prediction fresh and share interval avg power
        const nowMs = Date.now();
        const existingPrediction = state.finishPrediction;
        const elapsedSincePrediction = existingPrediction?.updatedAt
            ? (nowMs - existingPrediction.updatedAt) / 1000
            : null;
        const predictionStale = !existingPrediction
            || !Number.isFinite(existingPrediction.remainingSeconds)
            || (elapsedSincePrediction != null && elapsedSincePrediction > 5)
            || (existingPrediction && existingPrediction.remainingSeconds <= 0);
        if (intervalChanged || predictionStale) {
            const prediction = computeFinishPrediction();
            if (prediction) {
                state.finishPrediction = {
                    ...prediction,
                    publisherId: INSTANCE_ID,
                    updatedAt: nowMs,
                };
                shareFinishPrediction(state.finishPrediction);
            } else {
                state.finishPrediction = null;
                shareFinishPrediction(null);
            }
        }
    }

    // No more continuous tracking line - all logging is now event-based

    if (state.intervalStartTime && power != null && Number.isFinite(power)) {
        const now = Date.now();
        const dt = now - state.lastUpdateTime;
        if (dt > 0) {
            state.powerIntegral += power * dt;
            state.timeIntegral += dt;
            state.intervalAvgPower = state.timeIntegral > 0 ? state.powerIntegral / state.timeIntegral : null;
        }
        state.lastUpdateTime = now;
    }

    // Share interval average power via BroadcastChannel (avoid storage conflicts)
    shareIntervalAvgPower(state.intervalAvgPower);

    updateDashboard();
}

function updateDashboard() {
    const watching = state.watching;
    const power = watching?.state?.power ?? watching?.stats?.power?.cur ?? null;
    const riderWeight = state.metrics.weight ?? watching?.athlete?.weight ?? null;
    const nowMs = Date.now();
    const displayPower = getSmoothedDisplayPower(nowMs, power);
    const wkg = displayPower && riderWeight ? displayPower / riderWeight : null;

    if (displayPower != null) {
        els.gaugePower.textContent = `${Math.round(displayPower)} W`;
        els.gaugeWkg.textContent = wkg ? `${wkg.toFixed(2)} w/kg` : '— w/kg';
    } else {
        els.gaugePower.textContent = '—';
        els.gaugeWkg.textContent = '— w/kg';
    }

    const distanceMeters = watching ? deriveDistanceMeters(watching) : NaN;
    const actualDistanceKm = Number.isFinite(distanceMeters) ? distanceMeters / 1000 : NaN;
    renderPlanSummary(actualDistanceKm);
    updateFinishCountdown();
    const offsetKm = getEffectiveOffsetKm();
    const distanceKmForPlan = resolveBaseDistanceKm(actualDistanceKm);
    const planDistanceKm = resolvePlanDistanceKm(actualDistanceKm);

    if (!state.plan || !state.intervals.length) {
        els.gaugeTargetPower.textContent = 'load a plan';
        els.distanceToNext.textContent = '— km';
        setUpcomingDetails(null, 'load a plan');
        updateTargetBand(null);
        updateGauge(power, null, watching);
        updatePlanWBalVisuals();
        updateGaugeAnnotations(watching);
        return;
    }

    const currentIdx = findCurrentInterval(planDistanceKm);
    if (currentIdx !== state.displayedIntervalIndex) {
        state.intervalStartTime = Date.now();
        state.lastUpdateTime = Date.now();
        state.powerIntegral = 0;
        state.timeIntegral = 0;
        state.intervalAvgPower = null;
    }
    state.displayedIntervalIndex = currentIdx;
    state.currentIndex = currentIdx;
    const current = currentIdx !== -1 ? state.intervals[currentIdx] : null;
    const upcoming = currentIdx === -1
        ? state.intervals[0]
        : state.intervals[currentIdx + 1] ?? null;

    let adjustedTarget = null;
    if (current) {
        adjustedTarget = current.power_w * state.powerBias;
    } else if (upcoming) {
        adjustedTarget = upcoming.power_w * state.powerBias;
    }

    const distanceLabel = formatDistanceToNext(distanceKmForPlan, offsetKm, current, upcoming);
    els.distanceToNext.textContent = distanceLabel.label;
    updateDistanceProgress(actualDistanceKm, offsetKm, current, upcoming);
    const intervalNumber = currentIdx === -1 ? 1 : currentIdx + 2;
    setUpcomingDetails(distanceLabel.finish ? null : upcoming, distanceLabel.finish ? 'finish strong' : 'no more intervals', intervalNumber, offsetKm);

    els.gaugeTargetPower.textContent = adjustedTarget ? `${Math.round(adjustedTarget)} W` : '— W';
    const avgDisplay = state.intervalAvgPower ? Math.round(state.intervalAvgPower) : '—';
    els.gaugeAvgPower.textContent = `${avgDisplay} W`;
    updateTargetBand(adjustedTarget);
    updateGauge(displayPower, adjustedTarget, watching);
    updatePlanWBalVisuals();
    updateGaugeAnnotations(watching);
}

function deriveDistanceMeters(watching) {
    if (!watching) {
        return 0;
    }
    const candidates = [
        watching.state?.distance,
        watching.state?.progress?.distance,
        watching.state?.lapDistance,
        watching.stats?.distance,
        watching.stats?.activeDistance,
    ];
    for (const value of candidates) {
        if (typeof value === 'number' && !Number.isNaN(value)) {
            return value;
        }
    }
    return 0;
}

function findCurrentInterval(distanceKm) {
    if (!Number.isFinite(distanceKm)) {
        return -1;
    }
    return state.intervals.findIndex(interval => {
        const start = getScaledDistanceKm(interval.start_km);
        const end = getScaledDistanceKm(interval.end_km);
        if (Number.isFinite(start) && Number.isFinite(end)) {
            return distanceKm >= start && distanceKm < end;
        }
        if (!Number.isFinite(start) && Number.isFinite(end)) {
            return distanceKm < end;
        }
        if (Number.isFinite(start) && !Number.isFinite(end)) {
            return distanceKm >= start;
        }
        return false;
    });
}

function formatDistanceToNext(actualDistanceKm, offsetKm, current, upcoming) {
    if (!Number.isFinite(actualDistanceKm)) {
        return {label: '— km', finish: false};
    }
    const offset = Number.isFinite(offsetKm) ? offsetKm : 0;
    if (upcoming && Number.isFinite(upcoming.start_km)) {
        const upcomingStartPlan = getScaledDistanceKm(upcoming.start_km);
        const nextStartActual = Number.isFinite(upcomingStartPlan)
            ? upcomingStartPlan - offset
            : null;
        if (Number.isFinite(nextStartActual)) {
            const gapKm = Math.max(0, nextStartActual - actualDistanceKm);
            if (gapKm <= 0.01) {
                return {label: 'now', finish: false};
            }
            return {label: `${gapKm.toFixed(2)} km`, finish: false};
        }
    }
    if (current) {
        const currentEndRaw = Number.isFinite(current.end_km)
            ? current.end_km
            : Number.isFinite(current.start_km)
                ? current.start_km
                : null;
        const currentEnd = getScaledDistanceKm(currentEndRaw);
        if (Number.isFinite(currentEnd)) {
            const currentEndActual = currentEnd - offset;
            const remainingKm = Math.max(0, currentEndActual - actualDistanceKm);
            if (remainingKm <= 0.01) {
                return {label: 'finish', finish: true};
            }
            return {label: `${remainingKm.toFixed(2)} km`, finish: true};
        }
        return {label: 'finish', finish: true};
    }
    return {label: '— km', finish: false};
}

function updateDistanceProgress(actualDistanceKm, offsetKm, current, upcoming) {
    if (!els.distanceProgress || !els.distanceProgressFill) {
        return;
    }
    if (!state.plan || !state.intervals.length || !Number.isFinite(actualDistanceKm)) {
        els.distanceProgress.hidden = true;
        if (els.distanceToNext) {
            els.distanceToNext.classList.remove('urgent');
        }
        return;
    }

    const offset = Number.isFinite(offsetKm) ? offsetKm : 0;

    // Determine the active span to next boundary
    let startKm = null;
    let endKm = null;

    if (current) {
        const startPlan = getScaledDistanceKm(current.start_km);
        const endPlan = getScaledDistanceKm(current.end_km);
        if (Number.isFinite(startPlan) && Number.isFinite(endPlan)) {
            startKm = startPlan - offset;
            endKm = endPlan - offset;
        }
    } else if (upcoming) {
        // Before the first interval: progress toward its start
        const upcomingStart = getScaledDistanceKm(upcoming.start_km);
        if (Number.isFinite(upcomingStart)) {
            startKm = 0;
            endKm = upcomingStart - offset;
        }
    }

    if (!Number.isFinite(startKm) || !Number.isFinite(endKm) || endKm <= startKm) {
        els.distanceProgress.hidden = true;
        if (els.distanceToNext) {
            els.distanceToNext.classList.remove('urgent');
        }
        return;
    }

    const rawProgress = clamp((actualDistanceKm - startKm) / (endKm - startKm), 0, 1);
    const remainingKm = Math.max(0, endKm - actualDistanceKm);
    const urgent = remainingKm <= 0.1; // highlight last 100 m regardless of interval length
    if (els.distanceToNext) {
        els.distanceToNext.classList.toggle('urgent', urgent);
    }

    // Linear fill to keep movement proportional to distance across interval lengths
    const eased = rawProgress;
    els.distanceProgressFill.style.width = `${(eased * 100).toFixed(1)}%`;
    els.distanceProgress.hidden = false;
}

function setUpcomingDetails(interval, emptyMessage = 'no more intervals', intervalNumber = null, offsetKm = 0) {
    if (!els.upcomingTargetPower) {
        return;
    }
    const offset = Number.isFinite(offsetKm) ? offsetKm : 0;
    if (!interval) {
        els.upcomingTargetPower.textContent = '— W';
        els.upcomingTargetDesc.textContent = emptyMessage;
        els.upcomingTargetRange.textContent = '— km';
        els.upcomingTargetDuration.textContent = '—';
        if (els.nextLabel) {
            els.nextLabel.textContent = 'Next';
        }
        return;
    }
    const adjusted = Number.isFinite(interval.power_w)
        ? Math.round(interval.power_w * state.powerBias)
        : null;
    els.upcomingTargetPower.textContent = adjusted ? `${adjusted} W` : '— W';
    if (interval.avg_gradient !== undefined && interval.avg_gradient !== null) {
        const gradPct = Number(interval.avg_gradient);
        els.upcomingTargetDesc.textContent = `${formatNumber(gradPct, 1)}%`;
        els.upcomingTargetDesc.classList.remove('grade-up', 'grade-down');
        if (gradPct > 0.05) {
            els.upcomingTargetDesc.classList.add('grade-up');
        } else if (gradPct < -0.05) {
            els.upcomingTargetDesc.classList.add('grade-down');
        }
    } else {
        const startPlan = getScaledDistanceKm(interval.start_km);
        const startActual = Number.isFinite(startPlan)
            ? Math.max(startPlan - offset, 0)
            : null;
        els.upcomingTargetDesc.textContent = `starts at ${formatKm(startActual)} km`;
        els.upcomingTargetDesc.classList.remove('grade-up', 'grade-down');
    }
    const scaledStart = getScaledDistanceKm(interval.start_km);
    const scaledEnd = getScaledDistanceKm(interval.end_km);
    const rangeStart = Number.isFinite(scaledStart)
        ? Math.max(scaledStart - offset, 0)
        : scaledStart;
    const rangeEnd = Number.isFinite(scaledEnd)
        ? Math.max(scaledEnd - offset, 0)
        : scaledEnd;
    els.upcomingTargetRange.innerHTML = formatRange(rangeStart, rangeEnd);
    els.upcomingTargetDuration.textContent = interval.duration_text ?? '—';
    if (els.nextLabel) {
        const totalIntervals = state.intervals.length;
        els.nextLabel.textContent = Number.isFinite(intervalNumber) && totalIntervals
            ? `Next ${intervalNumber}/${totalIntervals}`
            : 'Next';
    }
}

function formatMeters(value) {
    const sign = value > 0 ? '+' : '';
    return `${sign}${value} m`;
}

function formatKm(value, digits = 1) {
    return Number.isFinite(value) ? value.toFixed(digits) : '—';
}

function formatRange(start, end) {
    if (!Number.isFinite(start) || !Number.isFinite(end)) {
        return '— km';
    }
    return `${start.toFixed(1)} km<br>↓<br>${end.toFixed(1)} km`;
}

function formatNumber(value, digits = 1) {
    return Number.isFinite(value) ? value.toFixed(digits) : '—';
}

function updateSmoothingLabel() {
    if (els.smoothingValue) {
        const val = state.powerSmoothingSec || 0;
        els.smoothingValue.textContent = val > 0 ? `${val.toFixed(1)}s` : 'Off';
    }
}

// Maintain rolling buffer of power samples for display-only smoothing
function pushPowerSample(nowMs, power) {
    if (power == null || !Number.isFinite(power)) return;
    state.powerSamples.push({ tMs: nowMs, pW: power });
    const windowMs = (state.powerSmoothingSec || 0) * 1000;
    if (windowMs <= 0) {
        // Limit buffer size when smoothing disabled
        const maxLen = 128;
        if (state.powerSamples.length > maxLen) {
            state.powerSamples.splice(0, state.powerSamples.length - maxLen);
        }
        return;
    }
    const cutoff = nowMs - windowMs;
    while (state.powerSamples.length && state.powerSamples[0].tMs < cutoff) {
        state.powerSamples.shift();
    }
}

function getSmoothedDisplayPower(nowMs, rawPower) {
    const windowSec = state.powerSmoothingSec || 0;
    // Always keep a short history for potential future uses
    if (rawPower != null && Number.isFinite(rawPower)) {
        pushPowerSample(nowMs, rawPower);
    }

    // No smoothing requested
    if (windowSec <= 0) {
        state.displayPowerEma = Number.isFinite(rawPower) ? rawPower : state.displayPowerEma;
        state.displayPowerEmaTsMs = nowMs;
        return rawPower;
    }

    // Initialize EMA on first sample
    if (!Number.isFinite(state.displayPowerEma) || !Number.isFinite(state.displayPowerEmaTsMs)) {
        state.displayPowerEma = Number.isFinite(rawPower) ? rawPower : state.displayPowerEma;
        state.displayPowerEmaTsMs = nowMs;
        return state.displayPowerEma;
    }

    // If current sample is missing, hold previous smoothed value
    if (rawPower == null || !Number.isFinite(rawPower)) {
        return state.displayPowerEma;
    }

    // Time-based EMA so smoothing works with low update rates
    const dtMs = Math.max(0, nowMs - state.displayPowerEmaTsMs);
    const tauMs = windowSec * 1000; // time constant
    const alpha = 1 - Math.exp(-dtMs / tauMs);
    const ema = state.displayPowerEma + alpha * (rawPower - state.displayPowerEma);
    state.displayPowerEma = ema;
    state.displayPowerEmaTsMs = nowMs;
    return ema;
}

function formatCountdown(seconds) {
    if (!Number.isFinite(seconds)) {
        return '—:—';
    }
    const clamped = Math.max(0, seconds);
    const hours = Math.floor(clamped / 3600);
    const minutes = Math.floor((clamped % 3600) / 60);
    const secs = Math.floor(clamped % 60);
    if (hours > 0) {
        return `${hours}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
    }
    return `${minutes}:${String(secs).padStart(2, '0')}`;
}

function formatDeltaSeconds(value) {
    if (!Number.isFinite(value)) {
        return '+0:00';
    }
    const sign = value >= 0 ? '+' : '-';
    const abs = Math.abs(value);
    const minutes = Math.floor(abs / 60);
    const seconds = Math.floor(abs % 60);
    return `${sign}${minutes}:${String(seconds).padStart(2, '0')}`;
}

function normalizeFinishPrediction(raw) {
    if (!raw) {
        return null;
    }
    const predictedSeconds = Number(raw.predictedSeconds);
    const remainingSeconds = Number(raw.remainingSeconds);
    if (!Number.isFinite(predictedSeconds) || !Number.isFinite(remainingSeconds)) {
        return null;
    }
    const deltaSeconds = Number(raw.deltaSeconds);
    const elapsedSeconds = Number(raw.elapsedSeconds);
    const predictedText = typeof raw.predictedText === 'string' && raw.predictedText.trim()
        ? raw.predictedText.trim()
        : formatCountdown(predictedSeconds);
    const updatedAt = Number(raw.updatedAt);
    const publisherId = typeof raw.publisherId === 'string' && raw.publisherId ? raw.publisherId : null;
    return {
        predictedSeconds,
        remainingSeconds,
        deltaSeconds: Number.isFinite(deltaSeconds) ? deltaSeconds : null,
        elapsedSeconds: Number.isFinite(elapsedSeconds) ? elapsedSeconds : null,
        predictedText,
        updatedAt: Number.isFinite(updatedAt) ? updatedAt : null,
        publisherId,
    };
}

function formatMetric(value, source, unit = '') {
    if (!Number.isFinite(value)) {
        return '—';
    }
    const rounded = unit === 'W' || unit === 'J' ? Math.round(value) : value;
    const suffix = unit ? `${rounded} ${unit}` : String(rounded);
    return source ? `${suffix} (${source})` : suffix;
}

function getPlanTotalDistanceKm() {
    if (!state.plan) {
        return null;
    }
    // Summary is now corrected in setPlan(), so prioritize it for performance
    const summaryDistance = Number(state.plan.summary?.distance_km);
    if (Number.isFinite(summaryDistance) && summaryDistance > 0) {
        return summaryDistance;
    }
    // Fallback to intervals if summary not available
    const lastInterval = state.intervals.at(-1);
    const lastEnd = Number(lastInterval?.end_km);
    if (Number.isFinite(lastEnd) && lastEnd > 0) {
        return lastEnd;
    }
    return null;
}

function getEventDistanceKm() {
    return Number.isFinite(state.eventDistanceMeters)
        ? state.eventDistanceMeters / 1000
        : null;
}

function getCourseDiscrepancyMeters() {
    const eventKm = getEventDistanceKm();
    const planKm = getPlanTotalDistanceKm();
    if (!Number.isFinite(eventKm) || !Number.isFinite(planKm)) {
        return null;
    }
    return Math.round((eventKm - planKm) * 1000);
}

function getEventProgressKm() {
    return Number.isFinite(state.eventProgressMeters)
        ? state.eventProgressMeters / 1000
        : null;
}

function getScaledDistanceKm(value) {
    if (!Number.isFinite(value)) {
        return value;
    }
    const planTotal = getPlanTotalDistanceKm();
    const eventTotal = getEventDistanceKm();
    if (!Number.isFinite(planTotal) || planTotal <= 0 || !Number.isFinite(eventTotal) || eventTotal <= 0) {
        return value;
    }

    // Target finish should account for any manual/auto offset so the last interval ends at course end
    const targetTotal = eventTotal + getEffectiveOffsetKm();
    const delta = targetTotal - planTotal;
    const lastInterval = state.intervals.at(-1);
    const lastStart = Number(lastInterval?.start_km);

    // If the discrepancy is small (<1 km), adjust only the tail (last interval) to avoid warping all earlier segments
    if (Math.abs(delta) < 1 && Number.isFinite(lastStart)) {
        if (value >= lastStart) {
            // Shift values in the final interval to land exactly on the event finish (with offset)
            const adjusted = value + delta;
            // Guard against inverted interval in extreme edge cases
            const minEnd = lastStart + 0.01; // 10 m minimum length
            return Math.max(adjusted, minEnd);
        }
        return value;
    }

    // For larger discrepancies, fall back to proportional scaling of the entire plan
    const scale = targetTotal / planTotal;
    return value * scale;
}

function getEffectiveOffsetMeters() {
    const manual = state.distanceOffset ?? 0;
    const auto = state.usesEventProgress ? 0 : (state.autoOffset ?? 0);
    return manual + auto;
}

function getEffectiveOffsetKm() {
    return getEffectiveOffsetMeters() / 1000;
}

function resolveBaseDistanceKm(actualDistanceKm) {
    const eventProgressKm = getEventProgressKm();
    if (Number.isFinite(eventProgressKm)) {
        return eventProgressKm;
    }
    return Number.isFinite(actualDistanceKm) ? actualDistanceKm : NaN;
}

function resolvePlanDistanceKm(actualDistanceKm) {
    const base = resolveBaseDistanceKm(actualDistanceKm);
    if (!Number.isFinite(base)) {
        return NaN;
    }
    return base + getEffectiveOffsetKm();
}

function resetAutoOffset() {
    if (state.autoOffset !== 0) {
        state.autoOffset = 0;
        updateOffsetLabel();
        return true;
    }
    return false;
}

function deriveEventTelemetry(watching) {
    const metric = watching?.remainingMetric;
    const remaining = Number(watching?.remaining);
    const remainingEnd = Number(watching?.remainingEnd);
    const stateEventDistance = Number(watching?.state?.eventDistance);

    let totalMeters = null;
    if (Number.isFinite(remainingEnd)) {
        totalMeters = remainingEnd;
    } else if (Number.isFinite(stateEventDistance)) {
        totalMeters = stateEventDistance;
    }

    const remainingMeters = metric === 'distance' && Number.isFinite(remaining)
        ? Math.max(0, remaining)
        : null;

    const progressMeters = Number.isFinite(totalMeters) && Number.isFinite(remainingMeters)
        ? clamp(totalMeters - remainingMeters, 0, totalMeters)
        : null;

    return {totalMeters, remainingMeters, progressMeters};
}

function detectAndHandleEventStart(watching) {
    if (!watching) {
        return;
    }
    
    const info = deriveEventTelemetry(watching);
    const currentDistance = info.progressMeters ?? 0;
    const currentAthleteId = watching.athleteId;
    const currentEventSubgroupId = watching.state?.eventSubgroupId;
    const currentCourseId = watching.state?.courseId;
    const currentTime = watching.state?.time; // Key: state.time indicates race started
    
    // DETECTION 1: Athlete ID changed (rider swap)
    if (state.lastAthleteId !== null && 
        currentAthleteId !== state.lastAthleteId) {
        console.log('[ATHLETE CHANGE] Rider swapped from', state.lastAthleteId, 'to', currentAthleteId);
        logAppend(`🔄 Athlete changed: switching from ${state.lastAthleteId} to ${currentAthleteId}. Clearing all tracking data.`);
        resetIntervalTracking();
        resetAutoOffset();
        persistSharedState({clearStatsTimestamp: Date.now()});
        state.eventHasStarted = false;
        state.lastEventDistanceMeters = null;
        state.lastAthleteId = currentAthleteId;
        state.lastEventSubgroupId = currentEventSubgroupId;
        state.lastCourseId = currentCourseId;
        updateDashboard();
        return;
    }
    
    // DETECTION 2: Entering event pen (eventSubgroupId appears)
    // This happens when you join an event and enter the pen
    // Only trigger if we previously saw NO subgroup (transition from out-of-event to in-event)
    if (state.lastEventSubgroupId === null && currentEventSubgroupId && currentAthleteId === state.lastAthleteId) {
        console.log('[PEN ENTRY] Entered event pen. EventSubgroupId:', currentEventSubgroupId);
        const subgroupPreview = typeof currentEventSubgroupId === 'string' ? currentEventSubgroupId.slice(0,12) : String(currentEventSubgroupId ?? 'null');
        logAppend(`🚪 Entered event pen: subgroup ${subgroupPreview}... on course ${currentCourseId}. Ready to start.`);
        resetIntervalTracking();
        resetAutoOffset();
        persistSharedState({clearStatsTimestamp: Date.now()});
        state.eventHasStarted = false;
        state.lastEventDistanceMeters = null;
        state.lastEventSubgroupId = currentEventSubgroupId;
        state.lastCourseId = currentCourseId;
        updateDashboard();
        return;
    }
    
    // DETECTION 3: Event subgroup changed (new event joined)
    if (state.lastEventSubgroupId !== null && 
        currentEventSubgroupId !== state.lastEventSubgroupId &&
        currentEventSubgroupId !== undefined) {
        console.log('[EVENT CHANGE] New event joined. SubgroupId changed from', 
                    state.lastEventSubgroupId, 'to', currentEventSubgroupId);
        const oldSub = typeof state.lastEventSubgroupId === 'string' ? state.lastEventSubgroupId.slice(0,8) : String(state.lastEventSubgroupId);
        const newSub = typeof currentEventSubgroupId === 'string' ? currentEventSubgroupId.slice(0,8) : String(currentEventSubgroupId);
        logAppend(`🔀 Event changed: switched from ${oldSub}... to ${newSub}... Resetting tracking.`);
        resetIntervalTracking();
        resetAutoOffset();
        persistSharedState({clearStatsTimestamp: Date.now()});
        state.eventHasStarted = false;
        state.lastEventDistanceMeters = null;
        state.lastEventSubgroupId = currentEventSubgroupId;
        state.lastAthleteId = currentAthleteId;
        state.lastCourseId = currentCourseId;
        updateDashboard();
        return;
    }
    
    // DETECTION 4: Leaving event (eventSubgroupId disappears)
    if (state.lastEventSubgroupId && !currentEventSubgroupId) {
        console.log('[PEN EXIT] Left event. EventSubgroupId was:', state.lastEventSubgroupId);
        logAppend(`🚪 Left event pen. Tracking cleared.`);
        resetIntervalTracking();
        resetAutoOffset();
        persistSharedState({clearStatsTimestamp: Date.now()});
        state.eventHasStarted = false;
        state.lastEventDistanceMeters = null;
        state.lastEventSubgroupId = null;
        updateDashboard();
        return;
    }
    
    // DETECTION 5: Course changed (world/route change)
    if (state.lastCourseId !== null && 
        currentCourseId !== state.lastCourseId &&
        currentCourseId !== undefined) {
        console.log('[COURSE CHANGE] Course changed from', 
                    state.lastCourseId, 'to', currentCourseId);
        logAppend(`🗺️ Course changed: ${state.lastCourseId} → ${currentCourseId}. Resetting tracking.`);
        resetIntervalTracking();
        resetAutoOffset();
        persistSharedState({clearStatsTimestamp: Date.now()});
        state.eventHasStarted = false;
        state.lastEventDistanceMeters = null;
        state.lastCourseId = currentCourseId;
        state.lastAthleteId = currentAthleteId;
        state.lastEventSubgroupId = currentEventSubgroupId;
        updateDashboard();
        return;
    }
    
    // Initialize tracking values on first run
    if (state.lastAthleteId === null) {
        state.lastAthleteId = currentAthleteId;
    }
    if (state.lastEventSubgroupId === null) {
        state.lastEventSubgroupId = currentEventSubgroupId;
    }
    if (state.lastCourseId === null) {
        state.lastCourseId = currentCourseId;
    }
    if (state.lastEventDistanceMeters === null && Number.isFinite(currentDistance)) {
        state.lastEventDistanceMeters = currentDistance;
    }
    
    // DETECTION 6: Distance reset to zero (warmup ends, event resets)
    if (Number.isFinite(state.lastEventDistanceMeters) &&
        state.lastEventDistanceMeters > 0 && 
        currentDistance === 0) {
        
        console.log('[EVENT RESET] Distance dropped to 0 (warmup ended). Resetting tracking. Previous distance:', 
                    state.lastEventDistanceMeters);
        logAppend(`⏮️ Distance reset to 0m (warmup ended, was at ${Math.round(state.lastEventDistanceMeters)}m). Clearing tracking.`);
        resetIntervalTracking();
        resetAutoOffset();
        persistSharedState({clearStatsTimestamp: Date.now()});
        state.eventHasStarted = false;
        state.lastEventDistanceMeters = 0;
        updateDashboard();
        return;
    }
    
    // DETECTION 7: Crossing start line - PRIMARY METHOD using state.time
    // state.time is 0/null/undefined in the pen, then becomes > 0 when crossing start line
    if (currentEventSubgroupId && !state.eventHasStarted && currentTime && currentTime > 0) {
        console.log('[START LINE CROSSED] state.time became truthy:', currentTime, 'seconds. Event has started!');
        logAppend(`🏁 Start line crossed! Race timer at ${Math.round(currentTime)}s. Initializing interval tracking.`);
        state.eventHasStarted = true;
        resetIntervalTracking();
        resetAutoOffset();
        persistSharedState({clearStatsTimestamp: Date.now()});
        
        // CRITICAL: Initialize the first interval immediately to ensure complete tracking
        // This creates the initial marker so the whole first interval is tracked from the start
        if (state.plan && state.intervals.length > 0) {
            const distanceMeters = info.progressMeters ?? 0;
            const distanceKm = distanceMeters / 1000;
            const planDistanceKm = resolvePlanDistanceKm(distanceKm);
            const firstIntervalIndex = findCurrentInterval(planDistanceKm);
            
            if (firstIntervalIndex >= 0) {
                console.log('[START LINE CROSSED] Creating initial marker for interval', firstIntervalIndex);
                beginIntervalStats(firstIntervalIndex, {
                    timestamp: Date.now(),
                    planDistanceKm
                });
            }
        }
        updateDashboard();
        // Note: Don't return here - let distance tracking continue below
    }
    
    // DETECTION 8: Crossing start line - FALLBACK METHOD using distance
    // Only use this if state.time detection didn't trigger
    if (!state.eventHasStarted && 
        Number.isFinite(state.lastEventDistanceMeters) &&
        state.lastEventDistanceMeters === 0 && 
        Number.isFinite(currentDistance) && 
        currentDistance > 0) {
        
        console.log('[START LINE CROSSED - FALLBACK] Distance changed from 0 to', currentDistance, 'meters');
        logAppend(`🏁 Start line crossed (distance fallback)! Now at ${Math.round(currentDistance)}m. Initializing interval tracking.`);
        state.eventHasStarted = true;
        resetIntervalTracking();
        resetAutoOffset();
        persistSharedState({clearStatsTimestamp: Date.now()});
        
        // CRITICAL: Initialize the first interval immediately to ensure complete tracking
        if (state.plan && state.intervals.length > 0) {
            const distanceMeters = info.progressMeters ?? 0;
            const distanceKm = distanceMeters / 1000;
            const planDistanceKm = resolvePlanDistanceKm(distanceKm);
            const firstIntervalIndex = findCurrentInterval(planDistanceKm);
            
            if (firstIntervalIndex >= 0) {
                console.log('[START LINE CROSSED - FALLBACK] Creating initial marker for interval', firstIntervalIndex);
                beginIntervalStats(firstIntervalIndex, {
                    timestamp: Date.now(),
                    planDistanceKm
                });
            }
        }
        updateDashboard();
    }
    
    // Track distance for next comparison
    if (Number.isFinite(currentDistance)) {
        state.lastEventDistanceMeters = currentDistance;
    }
}

function resetIntervalTracking({resetEventState = false} = {}) {
    console.log('[RESET] Clearing interval stats and predictions');
    state.currentIndex = -1;
    state.displayedIntervalIndex = -1;
    state.intervalStats = [];
    state.intervalStartTime = null;
    state.lastUpdateTime = null;
    state.powerIntegral = 0;
    state.timeIntegral = 0;
    state.intervalAvgPower = null;
    state.eventComplete = false;
    state.eventCompleteTimestamp = null;
    state.finishPrediction = null;
    state.sharedPredictionSignature = null;
    shareFinishPrediction(null);
    shareIntervalAvgPower(null);
    resetMetrics();
    resetPlanWBal();

    if (resetEventState) {
        state.eventHasStarted = false;
        state.lastEventDistanceMeters = null;
        state.eventProgressMeters = null;
        state.eventRemainingMeters = null;
        state.autoOffset = 0;
        state.usesEventProgress = false;
    }
}

function resetLiveDataForSimulation() {
    resetIntervalTracking({resetEventState: true});
    state.powerSamples = [];
    state.displayPowerEma = null;
    state.displayPowerEmaTsMs = null;
    state.lastValidWatching = null;
    state.finishPrediction = null;
    state.sharedPredictionSignature = null;
    state.eventComplete = false;
    state.eventCompleteTimestamp = null;
    state.lastUpdateTime = null;
    state.intervalStartTime = null;
    state.powerIntegral = 0;
    state.timeIntegral = 0;
    state.intervalAvgPower = null;
    shareFinishPrediction(null);
    shareIntervalAvgPower(null);
}

function updateEventTelemetryAndOffset(watching, distanceMeters) {
    detectAndHandleEventStart(watching);
    
    const info = deriveEventTelemetry(watching);
    if (Number.isFinite(info.totalMeters)) {
        state.eventDistanceMeters = info.totalMeters;
    }
    if (Number.isFinite(info.remainingMeters)) {
        state.eventRemainingMeters = info.remainingMeters;
    }
    if (Number.isFinite(info.progressMeters)) {
        state.eventProgressMeters = info.progressMeters;
    }
    state.usesEventProgress = Number.isFinite(info.progressMeters);
    if (state.usesEventProgress) {
        resetAutoOffset();
    }
}

function updateBiasLabel() {
    els.biasValue.textContent = `${Math.round(state.powerBias * 100)}%`;
}

function updateOffsetLabel() {
    if (!els.offsetValue) {
        return;
    }
    const effectiveMeters = Math.round(getEffectiveOffsetMeters());
    els.offsetValue.textContent = formatMeters(effectiveMeters);
    const manual = Math.round(state.distanceOffset ?? 0);
    const auto = Math.round((state.usesEventProgress ? 0 : state.autoOffset) ?? 0);
    const courseDelta = getCourseDiscrepancyMeters();
    const parts = [`Manual ${formatMeters(manual)}`, `${state.usesEventProgress ? 'auto (locked)' : 'auto'} ${formatMeters(auto)}`];
    if (Number.isFinite(courseDelta)) {
        parts.push(`course Δ ${formatMeters(courseDelta)}`);
    }
    els.offsetValue.title = parts.join(' · ');
}

function updateVersionUI() {
    if (!els.versionFooter) return;
    const current = state.versionCurrent || '—';
    const latest = state.versionLatest;
    const status = state.versionStatus;
    if (els.versionCurrent) {
        els.versionCurrent.textContent = `v${current}`;
    }
    if (els.versionStatus) {
        // Clear any existing link
        els.versionStatus.onclick = null;
        els.versionStatus.style.cursor = '';
        els.versionStatus.title = '';
        
        if (status === 'update' && latest) {
            els.versionStatus.textContent = `Update available: v${latest}`;
            els.versionStatus.classList.add('alert');
            els.versionStatus.hidden = false;
            // Make it clickable to open releases page
            els.versionStatus.style.cursor = 'pointer';
            els.versionStatus.title = 'Click to download latest release';
            els.versionStatus.onclick = () => {
                window.open('https://github.com/BlueHorizon157/zwiftgopher-s4z-mods/releases/latest', '_blank');
            };
        } else if (status === 'checking') {
            els.versionStatus.textContent = 'Checking updates…';
            els.versionStatus.classList.remove('alert');
            els.versionStatus.hidden = false;
        } else if (status === 'error') {
            els.versionStatus.textContent = 'Update check failed';
            els.versionStatus.classList.add('alert');
            els.versionStatus.hidden = false;
        } else {
            els.versionStatus.textContent = latest ? `Up to date (v${latest})` : 'Up to date';
            els.versionStatus.classList.remove('alert');
            els.versionStatus.hidden = false;
        }
    }
}

function initDebugSimControls() {
    if (!els.log) {
        return;
    }

    const container = document.createElement('div');
    container.style.display = 'flex';
    container.style.flexWrap = 'wrap';
    container.style.gap = '8px';
    container.style.marginBottom = '8px';

    const mkBtn = (label, handler, variant = 'outline-warning') => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = `btn btn-sm btn-${variant}`;
        btn.textContent = label;
        btn.addEventListener('click', handler);
        return btn;
    };

    // Simulation buttons removed - focusing on live event detection

    // Insert controls just before the debug log for easy access when debug is visible.
    const parent = els.log.parentNode;
    if (parent) {
        parent.insertBefore(container, els.log);
    }
}

function setDefaultPlanPrediction() {
    if (!Number.isFinite(state.planDurationSeconds)) {
        state.finishPrediction = null;
        shareFinishPrediction(null);
        return;
    }
    const seconds = Math.max(0, state.planDurationSeconds);
    const predicted = {
        predictedSeconds: seconds,
        predictedText: formatCountdown(seconds),
        deltaSeconds: 0,
        remainingDeltaSeconds: 0,
        elapsedSeconds: 0,
        remainingSeconds: seconds,
        remainingPlanSeconds: seconds,
        pacingRatio: 1,
    };
    state.finishPrediction = predicted;
    shareFinishPrediction(predicted);
}

function updateManualOffset(value, {share=true, clampValue=true, persist=true}={}) {
    let next = Number(value);
    if (!Number.isFinite(next)) {
        next = 0;
    }
    if (clampValue) {
        next = clamp(next, -500, 500);
    }
    if (next === state.distanceOffset) {
        return;
    }
    state.distanceOffset = next;
    if (persist) {
        persistState();
    }
    updateOffsetLabel();
    updateDashboard();
    if (share) {
        persistSharedState({distanceOffset: next});
    }
}

function normalizeTargetBandWidth(value) {
    const width = Number.isFinite(value)
        ? value
        : DEFAULT_TARGET_BAND_WIDTH;
    return clamp(width, TARGET_BAND_MIN, TARGET_BAND_MAX);
}

function getTargetBandWidth() {
    return normalizeTargetBandWidth(state.targetBandWidthW);
}

function updateDebugVisibility() {
    if (els.log) {
        els.log.hidden = state.showDebug !== true;
    }
}

function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
}

function log(message) {
    if (!els.log) {
        return;
    }
    const time = new Date().toLocaleTimeString();
    els.log.textContent = `[${time}] ${message}`;
}

// Append a line to the debug log without overwriting the previous message
function logAppend(message) {
    if (!els.log) {
        return;
    }
    // Only append if the message body changed
    if (state.lastDebugMessage === message) {
        return;
    }
    state.lastDebugMessage = message;
    const time = new Date().toLocaleTimeString();
    const line = `[${time}] ${message}`;
    // Prepend latest line so newest stays visible at the top
    state.debugBuffer.unshift(line);
    if (state.debugBuffer.length > DEBUG_MAX_LINES) {
        state.debugBuffer.length = DEBUG_MAX_LINES;
    }
    els.log.textContent = state.debugBuffer.join('\n');
}

function normalizeAthleteId(value) {
    if (value == null) {
        return null;
    }
    if (typeof value === 'string') {
        const trimmed = value.trim();
        return trimmed ? trimmed : null;
    }
    const num = Number(value);
    if (Number.isFinite(num)) {
        return String(num);
    }
    return null;
}

function getWatchingAthleteId(watching) {
    if (!watching) {
        return null;
    }
    const candidates = [
        watching.athleteId,
        watching.athlete?.id,
        watching.athlete?.athleteId,
    ];
    for (const candidate of candidates) {
        const normalized = normalizeAthleteId(candidate);
        if (normalized) {
            return normalized;
        }
    }
    return null;
}

function setHomeAthleteId(athleteId, {share = true, persist = true} = {}) {
    const normalized = normalizeAthleteId(athleteId);
    if (state.homeAthleteId === normalized) {
        return false;
    }
    state.homeAthleteId = normalized;
    if (persist) {
        persistState();
    }
    // Refresh prediction channel scope when athlete changes
    initPredictionChannel();
    initIntervalAvgChannel();
    if (share) {
        persistSharedState({homeAthleteId: normalized});
    }
    return true;
}

function maybeAdoptHomeAthleteId(athleteId) {
    if (!athleteId || state.homeAthleteId) {
        return false;
    }
    return setHomeAthleteId(athleteId);
}

function clearHomeAthleteId({share = true, persist = true, resetTelemetry = true} = {}) {
    setHomeAthleteId(null, {share, persist});
    if (resetTelemetry) {
        state.lastValidWatching = null;
        state.watching = null;
    }
}

function shouldBlockTelemetry(athleteId) {
    if (!state.homeAthleteId || !athleteId) {
        return false;
    }
    return state.homeAthleteId !== athleteId;
}

function formatSpectateReason(watching) {
    const name = watching?.athlete?.sanitizedFullname || watching?.athlete?.fullname || null;
    if (name) {
        return `Spectating ${name} — stats paused`;
    }
    return 'Spectating another rider — stats paused';
}

function setSpectateState(active, reason = null, {spectatingAthleteId = null} = {}) {
    const normalizedReason = active ? (reason || 'Spectating another rider — stats paused') : null;
    const normalizedSpectatingId = normalizeAthleteId(spectatingAthleteId);
    if (state.spectateActive === active && state.spectateReason === normalizedReason && state.spectatingAthleteId === normalizedSpectatingId) {
        updateSpectateBanner();
        return;
    }
    state.spectateActive = active;
    state.spectateReason = normalizedReason;
    state.spectatingAthleteId = normalizedSpectatingId;
    updateSpectateBanner();
    persistSharedState({
        spectateActive: state.spectateActive,
        spectateReason: state.spectateReason,
        spectatingAthleteId: state.spectatingAthleteId,
    });
}

function updateSpectateBanner() {
    if (!els.spectateBanner) {
        return;
    }
    if (state.spectateActive && state.spectateReason) {
        els.spectateBanner.hidden = false;
        els.spectateBanner.textContent = state.spectateReason;
    } else {
        els.spectateBanner.hidden = true;
    }
}

function initPlanBridge() {
    window.addEventListener('message', event => {
        if (event.origin && event.origin !== window.location.origin) {
            return;
        }
        const data = event.data;
        if (!data || typeof data !== 'object') {
            return;
        }
        if (data.type === 'tt-plan:set' && data.plan) {
            setPlan(data.plan);
            persistState();
            log('Plan received from host.');
        } else if (data.type === 'tt-plan:clear') {
            clearPlan();
            log('Plan cleared by host.');
        }
    });

    window.ttIntervalDashboard = {
        setPlan(plan) {
            setPlan(plan);
            persistState();
            log('Plan set via API.');
        },
        clearPlan() {
            clearPlan();
            log('Plan cleared via API.');
        },
        setOffset(valueMeters) {
            updateManualOffset(valueMeters, {clampValue: false});
        },
        lockHomeToCurrent() {
            const source = state.watching || state.lastValidWatching;
            const athleteId = getWatchingAthleteId(source);
            if (athleteId) {
                setHomeAthleteId(athleteId);
                log(`Home rider locked to athlete ${athleteId}.`);
            }
        },
        setHomeAthleteId(athleteId) {
            setHomeAthleteId(athleteId);
            log('Home rider updated via API.');
        },
        clearHomeAthlete() {
            setHomeAthleteId(null);
            log('Home rider cleared via API.');
        },
    };
}

export function main() {
    common.initInteractionListeners();
    common.subscribe('athlete/watching', handleWatching);
    queryEls();
    loadPersistedState();
    initVersionInfo();
    initPredictionChannel();
    initIntervalAvgChannel();
    initSharedStateSync();
    initControls();
    initDebugSimControls();
    initPlanBridge();
    initStorageSync();
    updateDashboard();
}

function initStorageSync() {
    if (!common.storage) {
        return;
    }
    common.storage.addEventListener('update', handleStorageUpdate);
}

function handleStorageUpdate(ev) {
    if (!ev?.data || ev.data.key !== STORAGE_KEY) {
        return;
    }
    applyRemotePreferences(ev.data.value || {});
}

function initSharedStateSync() {
    if (!common.storage) {
        return;
    }
    const payload = common.storage.get(SHARED_STORAGE_KEY);
    if (payload) {
        applySharedStatePayload(payload);
    }
    common.storage.addEventListener('globalupdate', ev => {
        if (!ev?.data || ev.data.key !== SHARED_STORAGE_KEY) {
            return;
        }
        applySharedStatePayload(ev.data.value || {});
    });
}

async function initVersionInfo() {
    state.versionStatus = 'checking';
    updateVersionUI();
    await loadCurrentVersion();
    await checkLatestVersion();
}

async function loadCurrentVersion() {
    // Hardcoded version synced with manifest.json
    // Sauce mods don't have reliable runtime access to their manifest,
    // so we embed the version directly. Update this when bumping version.
    state.versionCurrent = '0.6.1';
    console.log('[version] Using embedded version:', state.versionCurrent);
    updateVersionUI();
}

async function checkLatestVersion() {
    try {
        state.versionStatus = 'checking';
        updateVersionUI();
        const res = await fetch('https://api.github.com/repos/BlueHorizon157/zwiftgopher-s4z-mods/releases/latest', {
            headers: {Accept: 'application/vnd.github+json'},
        });
        let rawLatest = null;

        if (res.ok) {
            const body = await res.json();
            rawLatest = body?.tag_name || body?.name || null;
        } else {
            console.warn(`[version] releases/latest returned ${res.status}, falling back to tags`);
        }

        if (!rawLatest) {
            // Fallback: grab the first tag (handles repos with only pre-releases or tags)
            const tagsRes = await fetch('https://api.github.com/repos/BlueHorizon157/zwiftgopher-s4z-mods/tags?per_page=1', {
                headers: {Accept: 'application/vnd.github+json'},
            });
            if (tagsRes.ok) {
                const tags = await tagsRes.json();
                rawLatest = tags?.[0]?.name || null;
            } else {
                throw new Error(`github tags failed ${tagsRes.status}`);
            }
        }

        const latest = rawLatest ? normalizeVersionString(rawLatest) : null;
        state.versionLatest = latest;
        if (latest && state.versionCurrent) {
            const cmp = compareVersions(latest, state.versionCurrent);
            state.versionStatus = cmp > 0 ? 'update' : 'ok';
        } else {
            state.versionStatus = 'ok';
        }
    } catch (err) {
        console.warn('[version] Latest check failed:', err);
        state.versionStatus = 'error';
    }
    updateVersionUI();
}

function getPredictionChannelName() {
    const athleteId = normalizeAthleteId(state.homeAthleteId) || 'global';
    return `tt:predictions:${athleteId}`;
}

function initPredictionChannel() {
    try {
        const name = getPredictionChannelName();
        if (state.predictionChan && state.predictionChanName === name) {
            return; // Already set up
        }
        if (state.predictionChan) {
            try { state.predictionChan.close(); } catch (_) {}
        }
        const chan = new BroadcastChannel(name);
        chan.onmessage = ev => {
            const msg = ev?.data;
            if (!msg || msg.type !== 'finish-prediction') return;
            if (msg.instanceId === INSTANCE_ID) return; // ignore self
            const athleteId = normalizeAthleteId(msg.athleteId);
            const targetId = normalizeAthleteId(state.homeAthleteId);
            if (athleteId && targetId && athleteId !== targetId) return;
            if (msg.payload == null) {
                state.finishPrediction = null;
            } else {
                const incoming = normalizeFinishPrediction(msg.payload);
                if (!incoming) return;
                state.finishPrediction = incoming;
            }
            updateFinishCountdown();
        };
        state.predictionChan = chan;
        state.predictionChanName = name;
    } catch (err) {
        console.warn('[initPredictionChannel] Failed:', err);
    }
}

function getIntervalAvgChannelName() {
    const athleteId = normalizeAthleteId(state.homeAthleteId) || 'global';
    return `tt:interval-avg:${athleteId}`;
}

function initIntervalAvgChannel() {
    try {
        const name = getIntervalAvgChannelName();
        if (state.intervalAvgChan && state.intervalAvgChanName === name) {
            return; // Already set up
        }
        if (state.intervalAvgChan) {
            try { state.intervalAvgChan.close(); } catch (_) {}
        }
        const chan = new BroadcastChannel(name);
        // Dashboard only publishes interval average; no listener needed
        state.intervalAvgChan = chan;
        state.intervalAvgChanName = name;
    } catch (err) {
        console.warn('[initIntervalAvgChannel] Failed:', err);
    }
}

function applySharedStatePayload(payload) {
    if (!payload) {
        return;
    }
    if (Object.prototype.hasOwnProperty.call(payload, 'plan')) {
        const incomingPlan = payload.plan ?? null;
        if (incomingPlan) {
            const incomingSignature = computePlanSignature(incomingPlan);
            if (!state.plan || incomingSignature !== state.planSignature) {
                setPlan(incomingPlan, {share: false, resetHome: false});
                persistState();
            }
        } else if (state.plan) {
            clearPlan({share: false, resetHome: false});
        }
    }
    if (Object.prototype.hasOwnProperty.call(payload, 'distanceOffset')) {
        const next = Number(payload.distanceOffset);
        if (Number.isFinite(next)) {
            updateManualOffset(next, {share: false, clampValue: false});
        }
    }
    if (Object.prototype.hasOwnProperty.call(payload, 'homeAthleteId')) {
        const normalized = normalizeAthleteId(payload.homeAthleteId);
        if (state.homeAthleteId !== normalized) {
            state.homeAthleteId = normalized;
            persistState();
        }
    }
    const hasSpectate = Object.prototype.hasOwnProperty.call(payload, 'spectateActive')
        || Object.prototype.hasOwnProperty.call(payload, 'spectateReason')
        || Object.prototype.hasOwnProperty.call(payload, 'spectatingAthleteId');
    if (hasSpectate) {
        state.spectateActive = Boolean(payload.spectateActive);
        state.spectateReason = payload.spectateReason ?? null;
        state.spectatingAthleteId = normalizeAthleteId(payload.spectatingAthleteId);
        updateSpectateBanner();
    }
    if (Object.prototype.hasOwnProperty.call(payload, 'finishPrediction')) {
        const incoming = normalizeFinishPrediction(payload.finishPrediction);
        if (!incoming || !incoming.publisherId || incoming.publisherId !== INSTANCE_ID) {
            state.finishPrediction = incoming;
            updateFinishCountdown();
        }
    }
}

function applyRemotePreferences(persisted) {
    const width = normalizeTargetBandWidth(persisted.targetBandWidthW);
    if (width !== state.targetBandWidthW) {
        state.targetBandWidthW = width;
        updateDashboard();
    }
    const debugPref = typeof persisted.showDebug === 'boolean' ? persisted.showDebug : false;
    if (debugPref !== state.showDebug) {
        state.showDebug = debugPref;
        updateDebugVisibility();
    }
    const smoothingRaw = Number.isFinite(persisted.powerSmoothingSec) ? persisted.powerSmoothingSec : 0;
    const smoothing = clamp(Math.round(smoothingRaw * 2) / 2, 0, 5);
    if (smoothing !== state.powerSmoothingSec) {
        state.powerSmoothingSec = smoothing;
        updateSmoothingLabel();
        updateDashboard();
    }
}

function resolveMetric(planValue, telemetryValue) {
    if (Number.isFinite(planValue)) {
        return {value: planValue, source: 'plan'};
    }
    if (Number.isFinite(telemetryValue)) {
        return {value: telemetryValue, source: 'telemetry'};
    }
    return {value: null, source: null};
}

function getPlanFtp() {
    return Number(state.plan?.rider?.ftp);
}

function getTelemetryFtp(watching) {
    return Number(watching?.athlete?.ftp ?? watching?.stats?.ftp);
}

function getPlanWPrime() {
    return Number(state.plan?.settings?.wPrime);
}

function getTelemetryWPrime(watching) {
    return Number(watching?.athlete?.wPrime ?? watching?.stats?.wPrime);
}

function getPlanWeight() {
    return Number(state.plan?.rider?.weight);
}

function getTelemetryWeight(watching) {
    return Number(watching?.athlete?.weight);
}

function resetMetrics() {
    Object.assign(state.metrics, createEmptyMetrics());
}

function resetPlanWBal() {
    state.planWBal = createPlanWBalState();
    state.planWBalPercent = null;
}

function updatePlanWBalFromTelemetry(power) {
    if (!state.plan) {
        resetPlanWBal();
        return;
    }

    // Use the plan's FTP as CP for W'bal calculation to match plan design assumptions
    // This ensures that hitting the plan's target power will decrease W'bal at the intended rate
    const cp = Number.isFinite(getPlanFtp()) ? getPlanFtp() : null;
    let wPrime = Number.isFinite(getPlanWPrime()) ? getPlanWPrime() : null;
    if (!Number.isFinite(wPrime) || wPrime <= 0) {
        wPrime = DEFAULT_WPRIME;
    }
    if (!Number.isFinite(cp) || cp <= 0 || !Number.isFinite(wPrime) || wPrime <= 0) {
        resetPlanWBal();
        return;
    }

    if (state.planWBal.cp !== cp || state.planWBal.wPrime !== wPrime || state.planWBal.value == null) {
        state.planWBal.cp = cp;
        state.planWBal.wPrime = wPrime;
        state.planWBal.value = wPrime;
        state.planWBal.lastTime = Date.now();
    }

    const now = Date.now();
    if (!Number.isFinite(power)) {
        state.planWBal.lastTime = now;
        state.planWBalPercent = computePlanWBalPercent(state.planWBal.value, wPrime);
        return;
    }

    const lastTime = state.planWBal.lastTime ?? now;
    const dt = (now - lastTime) / 1000;
    state.planWBal.lastTime = now;
    if (dt <= 0) {
        return;
    }

    if (power > cp) {
        state.planWBal.value -= (power - cp) * dt;
    } else {
        const recovery = cp - power;
        const expTerm = Math.exp(-(recovery * dt) / wPrime);
        state.planWBal.value = wPrime - (wPrime - state.planWBal.value) * expTerm;
    }

    state.planWBal.value = clamp(state.planWBal.value, -wPrime, wPrime);
    state.planWBalPercent = computePlanWBalPercent(state.planWBal.value, wPrime);
}

function computePlanWBalPercent(value, wPrime) {
    if (!Number.isFinite(value) || !Number.isFinite(wPrime) || wPrime <= 0) {
        return null;
    }
    const percent = (value / wPrime) * 100;
    return clamp(percent, PLAN_WBAL_MIN_PERCENT, PLAN_WBAL_MAX_PERCENT);
}

function updateGauge(power, target, watching) {
    const maxPower = computeGaugeMaxPower();
    if (power == null || !Number.isFinite(power)) {
        setArc(els.gaugeCurrentArc, 0, 0);
        els.gaugeCurrentArc.setAttribute('class', 'gauge-current');
        return;
    }
    const ratio = clamp(power / maxPower, 0, 1);
    setArc(els.gaugeCurrentArc, 0, ratio);

    // Determine color based on target band
    let colorClass = 'below'; // default blue
    if (target != null && Number.isFinite(target)) {
        const bandWidth = getTargetBandWidth();
        const minTarget = Math.max(0, target - bandWidth);
        const maxTarget = target + bandWidth;
        const minRatio = clamp(minTarget / maxPower, 0, 1);
        const maxRatio = clamp(maxTarget / maxPower, 0, 1);
        if (power >= minTarget && power <= maxTarget) {
            colorClass = 'within';
        } else if (ratio > maxRatio) {
            colorClass = 'above';
        }
    }
    els.gaugeCurrentArc.setAttribute('class', `gauge-current ${colorClass}`);
}

function updatePlanWBalVisuals() {
    ensureWBalTrack();
    if (!els.gaugeWbalPositive || !els.gaugeWbalNegative) {
        return;
    }
    const percent = state.planWBalPercent;
    if (!Number.isFinite(percent)) {
        setArc(els.gaugeWbalPositive, 0, 0, WBAL_RADIUS);
        setArc(els.gaugeWbalNegative, 0, 0, WBAL_RADIUS);
        return;
    }

    if (percent >= 0) {
        const ratio = clamp(percent / 100, 0, 1);
        setArc(els.gaugeWbalPositive, 0, ratio, WBAL_RADIUS);
        setArc(els.gaugeWbalNegative, 0, 0, WBAL_RADIUS);
    } else {
        const negRatio = clamp(Math.abs(percent) / 100, 0, 1) * WBAL_NEGATIVE_RATIO;
        setArc(els.gaugeWbalPositive, 0, 0, WBAL_RADIUS);
        setArc(els.gaugeWbalNegative, -negRatio, 0, WBAL_RADIUS);
    }
}

function ensureWBalTrack() {
    if (state.wbalTrackInitialized || !els.gaugeWbalTrack) {
        return;
    }
    setArc(els.gaugeWbalTrack, 0, 1, WBAL_RADIUS);
    state.wbalTrackInitialized = true;
}

function updateTargetBand(target) {
    if (!target || !Number.isFinite(target)) {
        setArc(els.gaugeTargetArc, 0, 0);
        return;
    }
    const maxPower = computeGaugeMaxPower();
    const width = getTargetBandWidth();
    const minRatio = clamp((target - width) / maxPower, 0, 1);
    const maxRatio = clamp((target + width) / maxPower, 0, 1);
    setArc(els.gaugeTargetArc, minRatio, maxRatio);
}

function updateGaugeAnnotations(watching) {
    if (els.gaugeCadence) {
        const cadence = watching?.state?.cadence;
        els.gaugeCadence.textContent = Number.isFinite(cadence)
            ? `${Math.round(cadence)} rpm`
            : '— rpm';
    }
    if (els.gaugeGradient) {
        const gradient = watching?.state?.grade;
        const percent = Number.isFinite(gradient) ? gradient * 100 : null;
        els.gaugeGradient.classList.remove('grade-up', 'grade-down');
        if (Number.isFinite(percent)) {
            const formatted = percent.toFixed(1);
            const display = formatted === "-0.0" ? "0.0" : formatted;
            els.gaugeGradient.textContent = `${display}%`;
            if (percent > 0.05) {
                els.gaugeGradient.classList.add('grade-up');
            } else if (percent < -0.05) {
                els.gaugeGradient.classList.add('grade-down');
            }
        } else {
            els.gaugeGradient.textContent = '—%';
        }
    }
}

function setArc(el, startRatio, endRatio, radius = GAUGE_RADIUS) {
    if (!el) {
        return;
    }
    const startAngle = GAUGE_START_ANGLE + startRatio * GAUGE_TOTAL_DEGREES;
    const endAngle = GAUGE_START_ANGLE + endRatio * GAUGE_TOTAL_DEGREES;
    const largeArc = (endAngle - startAngle) > 180 ? 1 : 0;
    const x1 = 130 + radius * Math.cos(startAngle * Math.PI / 180);
    const y1 = 130 + radius * Math.sin(startAngle * Math.PI / 180);
    const x2 = 130 + radius * Math.cos(endAngle * Math.PI / 180);
    const y2 = 130 + radius * Math.sin(endAngle * Math.PI / 180);
    const d = startRatio === endRatio ? '' : `M ${x1} ${y1} A ${radius} ${radius} 0 ${largeArc} 1 ${x2} ${y2}`;
    el.setAttribute('d', d);
}

function computeGaugeMaxPower() {
    return state.planPeakPower > 0 ? Math.ceil(state.planPeakPower * 1.25) : 1000;
}

function updateIntervalTracking(previousIndex, nextIndex, power, planDistanceKm) {
    if (!Number.isFinite(planDistanceKm)) {
        return;
    }
    const now = Date.now();
    
    // Handle interval transitions
    if (previousIndex !== nextIndex) {
        finalizeIntervalStats(previousIndex, {timestamp: now, power, nextIndex});
        beginIntervalStats(nextIndex, {timestamp: now, planDistanceKm});
    } else if (nextIndex >= 0) {
        // Even if index didn't change, ensure the interval has been initialized
        // This handles cases where we might have missed the initial creation
        const existing = state.intervalStats[nextIndex];
        if (!existing) {
            console.log('[INTERVAL INIT] Creating missing interval stats for index', nextIndex);
            beginIntervalStats(nextIndex, {timestamp: now, planDistanceKm});
        }
    }
    
    advanceIntervalStats(nextIndex, {timestamp: now, power});
}

function beginIntervalStats(index, {timestamp, planDistanceKm}) {
    if (!Number.isInteger(index) || index < 0) {
        return;
    }
    const existing = state.intervalStats[index];
    if (existing && existing.finished) {
        return;
    }
    
    const partial = detectPartialInterval(index, planDistanceKm);
    state.intervalStats[index] = {
        startMs: timestamp,
        lastUpdateMs: timestamp,
        elapsedMs: 0,
        powerIntegral: 0,
        timeIntegral: 0,
        avgPower: null,
        finished: false,
        partial,
    };
    
    // Log interval start
    const interval = state.intervals[index];
    const targetW = interval ? Math.round(interval.power_w * state.powerBias) : '?';
    const durationText = interval?.duration_text || '?';
    const partialFlag = partial ? ' (partial - started mid-interval)' : '';
    logAppend(`▶ Interval ${index + 1} started: target ${targetW}W for ${durationText}${partialFlag}`);
}

function detectPartialInterval(index, planDistanceKm) {
    if (!Number.isInteger(index) || index < 0) {
        return false;
    }
    if (!Number.isFinite(planDistanceKm)) {
        return true;
    }
    const interval = state.intervals[index];
    if (!interval) {
        return false;
    }
    const startKm = getScaledDistanceKm(interval.start_km);
    if (!Number.isFinite(startKm)) {
        return false;
    }
    return Math.abs(planDistanceKm - startKm) > INTERVAL_START_TOLERANCE_KM;
}

function advanceIntervalStats(index, {timestamp, power}) {
    if (!Number.isInteger(index) || index < 0) {
        return;
    }
    const stats = state.intervalStats[index];
    if (!stats || stats.finished) {
        return;
    }
    const last = stats.lastUpdateMs ?? timestamp;
    const dt = timestamp - last;
    if (dt <= 0) {
        return;
    }
    stats.elapsedMs += dt;
    stats.lastUpdateMs = timestamp;
    if (Number.isFinite(power)) {
        stats.powerIntegral += power * dt;
        stats.timeIntegral += dt;
        stats.avgPower = stats.timeIntegral > 0 ? stats.powerIntegral / stats.timeIntegral : null;
    }
}

function finalizeIntervalStats(index, {timestamp, power, nextIndex}) {
    if (!Number.isInteger(index) || index < 0) {
        return;
    }
    const stats = state.intervalStats[index];
    if (!stats || stats.finished) {
        return;
    }
    advanceIntervalStats(index, {timestamp, power});
    stats.finished = true;
    
    // Snapshot actual race elapsed time at interval completion for mid-race prediction baseline
    const raceElapsed = Number(state.watching?.state?.time);
    if (Number.isFinite(raceElapsed) && raceElapsed > 0) {
        stats.raceElapsedSnapshot = raceElapsed;
    }
    
    // Log interval completion with stats
    const interval = state.intervals[index];
    const targetW = interval ? Math.round(interval.power_w * state.powerBias) : null;
    const actualW = stats.avgPower ? Math.round(stats.avgPower) : null;
    const elapsedSec = Math.round(stats.elapsedMs / 1000);
    const planSec = interval ? parseDurationSeconds(interval) : null;
    const deltaW = (actualW && targetW) ? (actualW - targetW) : null;
    const deltaSec = (planSec && Number.isFinite(planSec)) ? (elapsedSec - planSec) : null;
    
    const completedCount = state.intervalStats.filter(s => s?.finished && !s?.partial).length;
    const totalIntervals = state.intervals.length;
    const partialFlag = stats.partial ? ' (partial)' : '';
    
    let msg = `■ Interval ${index + 1}/${totalIntervals} completed${partialFlag}: ${actualW || '?'}W avg (target ${targetW || '?'}W`;
    if (deltaW !== null) {
        msg += deltaW >= 0 ? ` +${deltaW}W` : ` ${deltaW}W`;
    }
    msg += `), ${elapsedSec}s`;
    if (deltaSec !== null) {
        msg += deltaSec >= 0 ? ` +${deltaSec}s` : ` ${deltaSec}s`;
    }
    msg += `. Completed intervals: ${completedCount}`;
    
    if (Number.isFinite(raceElapsed)) {
        msg += `, race time: ${Math.round(raceElapsed)}s`;
    }
    
    logAppend(msg);
    
    // If this is the last interval, log finish
    if (Number.isInteger(nextIndex) && nextIndex >= totalIntervals) {
        logAppend(`🏁 All intervals complete! Final time: ${Math.round(raceElapsed)}s`);
    }
}

// Fallback: approximate race elapsed time by summing interval durations when telemetry time is missing
function getApproxElapsedSeconds() {
    let totalMs = 0;
    for (const stats of state.intervalStats) {
        if (stats && Number.isFinite(stats.elapsedMs)) {
            totalMs += stats.elapsedMs;
        }
    }
    return totalMs > 0 ? totalMs / 1000 : null;
}

function computeFinishPrediction() {
    if (!state.plan || !Number.isFinite(state.planDurationSeconds)) {
        return null;
    }
    
    // Find last completed interval with race elapsed snapshot
    let baselineElapsed = 0;
    let baselineIndex = -1;
    for (let i = state.intervals.length - 1; i >= 0; i--) {
        const stats = state.intervalStats[i];
        if (stats?.finished && Number.isFinite(stats.raceElapsedSnapshot)) {
            baselineElapsed = stats.raceElapsedSnapshot;
            baselineIndex = i;
            break;
        }
    }
    
    // If no completed intervals yet, use basic plan-based prediction
    if (baselineIndex < 0) {
        const currentElapsed = Number(state.watching?.state?.time);
        const approxElapsed = getApproxElapsedSeconds();
        const elapsedForPrediction = Number.isFinite(currentElapsed) && currentElapsed > 0
            ? currentElapsed
            : (Number.isFinite(approxElapsed) && approxElapsed > 0 ? approxElapsed : null);
        if (!Number.isFinite(elapsedForPrediction) || elapsedForPrediction <= 0) {
            return null; // No elapsed time data
        }
        
        // Simple prediction: plan duration - elapsed time
        const remainingPlan = Math.max(state.planDurationSeconds - elapsedForPrediction, 0);
        
        return {
            predictedSeconds: state.planDurationSeconds,
            predictedText: formatCountdown(state.planDurationSeconds),
            deltaSeconds: 0, // No delta yet - on plan
            remainingDeltaSeconds: 0,
            elapsedSeconds: elapsedForPrediction,
            remainingSeconds: remainingPlan,
            remainingPlanSeconds: remainingPlan,
            pacingRatio: 1, // Assume on-pace
        };
    }
    
    if (baselineElapsed <= 0) {
        const approxElapsed = getApproxElapsedSeconds();
        if (Number.isFinite(approxElapsed) && approxElapsed > 0) {
            baselineElapsed = approxElapsed;
        } else {
            return null; // No baseline available
        }
    }
    
    // Calculate remaining plan duration ONLY from intervals after baseline
    // This ensures we only project based on future intervals, not incomplete past ones
    let remainingPlanSeconds = 0;
    
    state.intervals.forEach((interval, idx) => {
        const planDuration = parseDurationSeconds(interval);
        if (!Number.isFinite(planDuration) || planDuration <= 0) {
            return;
        }
        
        // For current interval (if after baseline), add remaining portion
        if (idx === state.currentIndex && idx > baselineIndex) {
            const stats = state.intervalStats[idx];
            const elapsed = stats && Number.isFinite(stats.elapsedMs) ? stats.elapsedMs / 1000 : 0;
            remainingPlanSeconds += Math.max(planDuration - elapsed, 0);
        } 
        // For future intervals after current, add full duration
        else if (idx > state.currentIndex && state.currentIndex >= 0) {
            remainingPlanSeconds += planDuration;
        }
        // For current interval at baseline, add remaining portion
        else if (idx === state.currentIndex && idx === baselineIndex) {
            const stats = state.intervalStats[idx];
            const elapsed = stats && Number.isFinite(stats.elapsedMs) ? stats.elapsedMs / 1000 : 0;
            remainingPlanSeconds += Math.max(planDuration - elapsed, 0);
        }
    });
    
    if (remainingPlanSeconds <= 0) {
        // No remaining intervals, use current race elapsed as prediction
        return {
            predictedSeconds: baselineElapsed,
            predictedText: formatCountdown(baselineElapsed),
            deltaSeconds: 0,
            elapsedSeconds: baselineElapsed,
            remainingSeconds: 0,
        };
    }
    
    // Compute pacing ratio ONLY from completed intervals (not partial ones)
    const pacingRatio = computePacingRatio();
    const ratio = Number.isFinite(pacingRatio) && pacingRatio > 0 ? pacingRatio : 1;
    const predictedRemaining = Math.max(remainingPlanSeconds * ratio, 0);
    
    const predictedSeconds = baselineElapsed + predictedRemaining;
    const remainingSeconds = predictedRemaining;
    
    // Delta for remaining time: how much time gained/lost vs plan for remaining intervals
    // Positive = slower than plan, Negative = faster than plan
    const remainingDeltaSeconds = predictedRemaining - remainingPlanSeconds;
    
    // Delta for total time: predicted finish vs total plan
    // This accounts for all the time completed so far plus the projected remaining
    const totalDeltaSeconds = predictedSeconds - state.planDurationSeconds;
    
    return {
        predictedSeconds,
        predictedText: formatCountdown(predictedSeconds),
        deltaSeconds: totalDeltaSeconds,
        remainingDeltaSeconds,
        elapsedSeconds: baselineElapsed,
        remainingSeconds,
        remainingPlanSeconds,
        pacingRatio: ratio,
    };
}

function computePacingRatio() {
    let planSeconds = 0;
    let actualSeconds = 0;
    state.intervals.forEach((interval, idx) => {
        const durationSec = parseDurationSeconds(interval);
        const stats = state.intervalStats[idx];
        // Only use completed intervals that were fully tracked (not partial/mid-race starts)
        if (!Number.isFinite(durationSec) || !stats?.finished || !Number.isFinite(stats.elapsedMs) || stats.partial) {
            return;
        }
        planSeconds += durationSec;
        actualSeconds += stats.elapsedMs / 1000;
    });
    if (planSeconds >= MIN_PACING_SAMPLE_SECONDS && actualSeconds > 0) {
        return clamp(actualSeconds / Math.max(planSeconds, 1e-3), 0.25, 4);
    }
    return 1;
}

function parseDurationSeconds(interval) {
    const directFields = [interval?.duration_s, interval?.duration_seconds, interval?.duration_sec];
    for (const value of directFields) {
        const num = Number(value);
        if (Number.isFinite(num) && num > 0) {
            return num;
        }
    }
    const text = interval?.duration_text;
    if (typeof text !== 'string') {
        return null;
    }
    const trimmed = text.trim();
    if (!trimmed) {
        return null;
    }
    const colonParts = trimmed.split(':').map(part => part.trim());
    if (colonParts.length === 3) {
        const [h, m, s] = colonParts.map(Number);
        if (colonParts.every(part => /^\d+$/.test(part)) && Number.isFinite(h) && Number.isFinite(m) && Number.isFinite(s)) {
            return h * 3600 + m * 60 + s;
        }
    }
    if (colonParts.length === 2) {
        const [m, s] = colonParts;
        if (/^\d+$/.test(m) && /^\d+$/.test(s)) {
            return Number(m) * 60 + Number(s);
        }
    }
    const unitsMatch = trimmed.toLowerCase().match(/(?:(\d+(?:\.\d+)?)\s*h)?\s*(?:(\d+(?:\.\d+)?)\s*m)?\s*(?:(\d+(?:\.\d+)?)\s*s)?/);
    if (unitsMatch) {
        const hours = Number(unitsMatch[1]) || 0;
        const minutes = Number(unitsMatch[2]) || 0;
        const seconds = Number(unitsMatch[3]) || 0;
        const total = hours * 3600 + minutes * 60 + seconds;
        if (total > 0) {
            return total;
        }
    }
    const numeric = Number(trimmed.replace(/[^0-9.]/g, ''));
    if (Number.isFinite(numeric) && numeric > 0) {
        return numeric;
    }
    return null;
}

function shareFinishPrediction(prediction) {
    const signature = prediction
        ? `${Math.round(prediction.predictedSeconds * 10)}|${Math.round(prediction.remainingSeconds * 10)}|${Math.round(prediction.deltaSeconds * 10)}`
        : 'none';
    if (state.sharedPredictionSignature === signature) {
        return;
    }
    state.sharedPredictionSignature = signature;
    // BroadcastChannel-based sharing for ephemeral prediction state.
    // Avoid using storage to prevent grid resets.
    try {
        initPredictionChannel();
        if (!state.predictionChan) {
            return;
        }
        const now = Date.now();
        // De-dupe is already handled via signature; optional light rate cap
        if (now - (state.lastPredictionBroadcastMs || 0) < 400) {
            // too soon; skip burst
        }
        const msg = {
            type: 'finish-prediction',
            instanceId: INSTANCE_ID,
            athleteId: normalizeAthleteId(state.homeAthleteId),
            signature,
            payload: prediction ? {
                predictedSeconds: prediction.predictedSeconds,
                predictedText: prediction.predictedText,
                deltaSeconds: prediction.deltaSeconds,
                remainingSeconds: prediction.remainingSeconds,
                elapsedSeconds: prediction.elapsedSeconds,
                updatedAt: now,
                publisherId: INSTANCE_ID,
            } : null,
        };
        state.predictionChan.postMessage(msg);
        state.lastPredictionBroadcastMs = now;
    } catch (err) {
        console.warn('[shareFinishPrediction] Broadcast failed:', err);
    }
}

function shareIntervalAvgPower(avgPower) {
    const normalized = Number.isFinite(avgPower) ? avgPower : null;
    const signature = normalized != null ? Math.round(normalized) : 'none';
    const now = Date.now();
    // De-dupe identical values and rate-limit bursts
    if (signature === state.lastIntervalAvgSignature && now - (state.lastIntervalAvgBroadcastMs || 0) < 700) {
        return;
    }
    try {
        initIntervalAvgChannel();
        if (!state.intervalAvgChan) {
            return;
        }
        state.intervalAvgChan.postMessage({
            type: 'interval-avg',
            instanceId: INSTANCE_ID,
            athleteId: normalizeAthleteId(state.homeAthleteId),
            avgPower: normalized,
            updatedAt: now,
        });
        state.lastIntervalAvgSignature = signature;
        state.lastIntervalAvgBroadcastMs = now;
    } catch (err) {
        console.warn('[shareIntervalAvgPower] Broadcast failed:', err);
    }
}

function sumDurations(intervals) {
    let totalSeconds = 0;
    let totalWork = 0;
    for (const interval of intervals || []) {
        const duration = parseDurationSeconds(interval);
        const power = Number(interval?.power_w);
        if (Number.isFinite(duration) && duration > 0) {
            totalSeconds += duration;
            if (Number.isFinite(power)) {
                totalWork += power * duration;
            }
        }
    }
    return {totalSeconds, totalWork};
}

function computePlanSignature(plan) {
    if (!plan) {
        return null;
    }
    const intervals = Array.isArray(plan.intervals) ? plan.intervals : [];
    const intervalParts = intervals.map(interval => {
        const duration = parseDurationSeconds(interval);
        return [
            normalizeSignatureNumber(interval?.start_km),
            normalizeSignatureNumber(interval?.end_km),
            normalizeSignatureNumber(interval?.power_w),
            normalizeSignatureNumber(duration),
        ];
    });
    const routeName = typeof plan.route?.name === 'string' ? plan.route.name : null;
    const distanceKm = normalizeSignatureNumber(plan.summary?.distance_km ?? plan.route?.distance_km);
    return JSON.stringify({
        routeName,
        distanceKm,
        intervalCount: intervalParts.length,
        intervals: intervalParts,
    });
}

function normalizeSignatureNumber(value) {
    const num = Number(value);
    if (!Number.isFinite(num)) {
        return null;
    }
    return Number(num.toFixed(3));
}

function normalizeVersionString(raw) {
    if (!raw) return null;
    return String(raw).trim().replace(/^v/i, '');
}

function compareVersions(a, b) {
    // Simple semver-ish compare with optional pre-release suffix
    const parse = v => {
        const [core, pre = ''] = v.split('-');
        const parts = core.split('.').map(n => parseInt(n, 10) || 0);
        return {parts, pre};
    };
    const va = parse(a);
    const vb = parse(b);
    const len = Math.max(va.parts.length, vb.parts.length);
    for (let i = 0; i < len; i++) {
        const da = va.parts[i] ?? 0;
        const db = vb.parts[i] ?? 0;
        if (da !== db) return da - db;
    }
    // If numeric parts equal, treat pre-release as lower precedence
    if (va.pre && !vb.pre) return -1;
    if (!va.pre && vb.pre) return 1;
    return 0;
}
