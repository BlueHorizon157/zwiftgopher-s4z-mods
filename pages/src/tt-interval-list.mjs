import * as common from '/pages/src/common.mjs';
import {withSharedPlanSnapshot} from './shared-plan-utils.mjs';

const INSTANCE_ID = `tt-interval-list-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

const SHARED_STORAGE_KEY = '/tt-dashboards/shared-state';
const DEFAULT_WPRIME = 20000;
const AUTO_CENTER_DELAY_MS = 5000;
const TABLE_RENDER_COOLDOWN_MS = 400;
const MIN_PACING_SAMPLE_SECONDS = 60;
const MIN_AVERAGE_TIME_MS = 10000;
const INTERVAL_START_TOLERANCE_KM = 0.02;

const state = {
    plan: null,
    planSignature: null,
    intervals: [],
    enrichedIntervals: [],
    distanceOffset: 0,
    autoOffset: 0,
    usesEventProgress: false,
    powerBias: 1,
    currentIndex: -1,
    watching: null,
    metrics: {
        ftp: null,
        ftpSource: null,
        wPrime: null,
        wPrimeSource: null,
    },
    eventDistanceMeters: null,
    eventRemainingMeters: null,
    eventProgressMeters: null,
    eventComplete: false,
    eventCompleteTimestamp: null,
    planDurationSeconds: null,
    planDurationText: null,
    planAvgPower: null,
    planIfPercent: null,
    persisted: {},
    manualScrollHoldUntil: 0,
    homeAthleteId: null,
    lastValidWatching: null,
    spectateActive: false,
    spectateReason: null,
    spectatingAthleteId: null,
    intervalStats: [],
    sharedPredictionSignature: null,
    planSignature: null,
    lastTableRenderMs: 0,
    lastTablePlanSignature: null,
    lastRenderedActiveIndex: -1,
    lastClearStatsTimestamp: null,
};

let autoCenterResumeTimer = null;

const els = {};

export function main() {
    common.initInteractionListeners();
    queryEls();
    initManualScrollPause();
    initTitlebarReveal();
    loadSharedState();
    initStorageSync();
    initPlanBridge();
    common.subscribe('athlete/watching', handleWatching);
    render();
}

function queryEls() {
    els.window = document.querySelector('.window');
    els.planRoute = document.getElementById('plan-route');
    els.planDistance = document.getElementById('plan-distance');
    els.offsetPill = document.getElementById('offset-pill');
    els.summaryDuration = document.getElementById('summary-duration');
    els.summaryFtp = document.getElementById('summary-ftp');
    els.summaryWprime = document.getElementById('summary-wprime');
    els.summaryAvgPower = document.getElementById('summary-avg-power');
    els.summaryIf = document.getElementById('summary-if');
    els.tableBody = document.querySelector('#interval-table tbody');
    els.tableWrapper = document.querySelector('.table-wrapper');
    els.emptyState = document.getElementById('empty-state');
    els.titlebar = document.getElementById('titlebar');
    els.spectateBanner = document.getElementById('spectate-banner');
    updateSpectateBanner();
}

function initManualScrollPause() {
    const container = document.querySelector('.table-wrapper');
    if (!container) {
        return;
    }
    const pause = () => pauseAutoCentering();
    const passive = {passive: true};
    container.addEventListener('wheel', pause, passive);
    container.addEventListener('touchstart', pause, passive);
    container.addEventListener('pointerdown', pause);
    container.addEventListener('scroll', pause, passive);
}

function initTitlebarReveal() {
    document.addEventListener('contextmenu', () => {
        if (els.titlebar) {
            els.titlebar.style.display = 'block';
        }
    });
}

function loadSharedState() {
    if (!common.storage) {
        return;
    }
    const persisted = common.storage.get(SHARED_STORAGE_KEY) || {};
    state.persisted = persisted;
    applyStoragePayload(persisted);
}

function initStorageSync() {
    if (!common.storage) {
        return;
    }
    common.storage.addEventListener('globalupdate', ev => {
        if (!ev?.data || ev.data.key !== SHARED_STORAGE_KEY) {
            return;
        }
        state.persisted = ev.data.value || {};
        applyStoragePayload(state.persisted);
    });
}

function applyStoragePayload(payload) {
    let needsRecompute = false;
    let needsRender = false;

    const nextOffset = Number(payload?.distanceOffset);
    if (Number.isFinite(nextOffset) && nextOffset !== state.distanceOffset) {
        state.distanceOffset = nextOffset;
        needsRecompute = true;
        needsRender = true;
    }
    const nextBias = Number(payload?.powerBias);
    if (Number.isFinite(nextBias) && nextBias > 0 && nextBias !== state.powerBias) {
        state.powerBias = nextBias;
        needsRecompute = true;
        needsRender = true;
    }
    if (payload && Object.prototype.hasOwnProperty.call(payload, 'plan')) {
        const incomingPlan = payload.plan ?? null;
        const incomingSignature = computePlanSignature(incomingPlan);
        const currentSignature = state.planSignature;
        if (incomingSignature !== currentSignature) {
            setPlan(incomingPlan, {share: false, resetHome: false});
            // setPlan handles recompute and render internally
            return;
        }
    }
    if (payload && Object.prototype.hasOwnProperty.call(payload, 'homeAthleteId')) {
        const normalized = normalizeAthleteId(payload.homeAthleteId);
        if (normalized !== state.homeAthleteId) {
            state.homeAthleteId = normalized;
            needsRender = true;
        }
    }
    const hasSpectate = payload && (
        Object.prototype.hasOwnProperty.call(payload, 'spectateActive')
        || Object.prototype.hasOwnProperty.call(payload, 'spectateReason')
        || Object.prototype.hasOwnProperty.call(payload, 'spectatingAthleteId')
    );
    if (hasSpectate) {
        const prevActive = state.spectateActive;
        const prevReason = state.spectateReason;
        const prevAthleteId = state.spectatingAthleteId;
        state.spectateActive = Boolean(payload.spectateActive);
        state.spectateReason = payload.spectateReason ?? null;
        state.spectatingAthleteId = normalizeAthleteId(payload.spectatingAthleteId);
        if (prevActive !== state.spectateActive || prevReason !== state.spectateReason || prevAthleteId !== state.spectatingAthleteId) {
            updateSpectateBanner();
            needsRender = true;
        }
    }

    // Check if finishPrediction changed - if so, render but don't recompute
    if (payload && Object.prototype.hasOwnProperty.call(payload, 'finishPrediction')) {
        needsRender = true;
    }

    // Check if stats should be cleared (manual refresh or reset)
    if (payload && Object.prototype.hasOwnProperty.call(payload, 'clearStatsTimestamp')) {
        const timestamp = payload.clearStatsTimestamp;
        if (Number.isFinite(timestamp) && timestamp !== state.lastClearStatsTimestamp) {
            console.log('[INTERVAL LIST] Clearing interval stats due to reset signal');
            state.intervalStats = [];
            state.lastClearStatsTimestamp = timestamp;
            needsRecompute = true;
            needsRender = true;
        }
    }

    if (needsRecompute) {
        recomputeIntervals();
    }
    if (needsRender) {
        render();
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
        } else if (data.type === 'tt-plan:clear') {
            clearPlan();
        }
    });

    const api = {
        setPlan(plan) {
            setPlan(plan);
        },
        clearPlan() {
            clearPlan();
        },
        setOffset(valueMeters) {
            state.distanceOffset = Number(valueMeters) || 0;
            persistSharedState({distanceOffset: state.distanceOffset});
            recomputeIntervals();
            render();
        },
        lockHomeToCurrent() {
            const source = state.watching || state.lastValidWatching;
            const athleteId = getWatchingAthleteId(source);
            if (athleteId) {
                setHomeAthleteId(athleteId);
            }
        },
        setHomeAthleteId(athleteId) {
            setHomeAthleteId(athleteId);
        },
        clearHomeAthlete() {
            setHomeAthleteId(null);
        },
        setPowerBias(value) {
            const next = Number(value);
            if (!Number.isFinite(next) || next <= 0) {
                return;
            }
            state.powerBias = next;
            recomputeIntervals();
            render();
        },
    };

    window.ttIntervalList = api;
    // Preserve compatibility with existing integrations that expect this name.
    window.ttIntervalDashboard = api;
}

function persistSharedState(patch) {
    if (!common.storage || !patch || typeof patch !== 'object') {
        return;
    }
    const base = common.storage.get(SHARED_STORAGE_KEY) || {};
    const next = {...base, ...withSharedPlanSnapshot(patch)};
    try {
        common.storage.set(SHARED_STORAGE_KEY, next);
        state.persisted = next;
    } catch (err) {
        console.error('Failed to persist shared TT interval state', err);
    }
}

function setPlan(plan, {share=true, resetHome=true}={}) {
    state.plan = plan ?? null;
    state.intervals = Array.isArray(plan?.intervals) ? plan.intervals : [];
    // Reset power bias to match the online planner defaults when loading a new plan locally
    state.powerBias = 1;
    resetEventCompletionState();
    computePlanSummaryStats();
    recomputeIntervals();
    if (resetHome) {
        clearHomeAthleteId();
    }
    state.intervalStats = [];
    state.planSignature = computePlanSignature(state.plan);
    if (share) {
        persistSharedState({plan: state.plan, powerBias: state.powerBias});
    }
    // Force render immediately when plan is loaded
    render();
    renderTable({force: true});
}

function clearPlan({share=true, resetHome=true}={}) {
    state.plan = null;
    state.intervals = [];
    resetEventCompletionState({clearStats: true});
    state.planDurationSeconds = null;
    state.planDurationText = null;
    state.planAvgPower = null;
    state.planIfPercent = null;
    state.enrichedIntervals = [];
    state.currentIndex = -1;
    if (resetHome) {
        clearHomeAthleteId();
    }
    state.intervalStats = [];
    state.planSignature = null;
    if (share) {
        persistSharedState({plan: null});
    }
}

function computePlanSummaryStats() {
    const summary = state.plan?.summary || {};
    const durationSeconds = Number(summary.duration_s);
    const durationText = summary.time_text || null;
    const fallbackDuration = sumDurations(state.intervals);
    state.planDurationSeconds = Number.isFinite(durationSeconds) && durationSeconds > 0
        ? durationSeconds
        : fallbackDuration.seconds;
    state.planDurationText = durationText || fallbackDuration.text;

    const avgPower = Number(summary.avg_power_w);
    if (Number.isFinite(avgPower)) {
        state.planAvgPower = avgPower;
    } else {
        state.planAvgPower = fallbackDuration.totalSeconds > 0
            ? fallbackDuration.totalWork / fallbackDuration.totalSeconds
            : null;
    }

    const ifPercent = Number(summary.if_percent);
    state.planIfPercent = Number.isFinite(ifPercent) ? ifPercent : null;
}

function recomputeIntervals() {
    if (!state.plan || !state.intervals.length) {
        state.enrichedIntervals = [];
        return;
    }
    const offsetKm = getEffectiveOffsetKm();
    const ftp = getResolvedFtp();
    const wPrime = getResolvedWPrime();
    const bias = getEffectivePowerBias();

    state.enrichedIntervals = state.intervals.map((interval, idx) => {
        const durationSec = parseDurationSeconds(interval);
        const planPower = Number(interval?.power_w);
        const startPlan = getScaledDistanceKm(interval?.start_km);
        const endPlan = getScaledDistanceKm(interval?.end_km);
        const stats = state.intervalStats[idx] || null;
        const applyOffset = !(stats?.finished);
        const intervalOffsetKm = applyOffset ? offsetKm : 0;
        const actualStart = Number.isFinite(startPlan) ? Math.max(startPlan - intervalOffsetKm, 0) : null;
        const actualEnd = Number.isFinite(endPlan) ? Math.max(endPlan - intervalOffsetKm, 0) : null;
        const targetPower = getBiasedPower(planPower, stats, bias);

        const actualDuration = stats?.elapsedMs ? stats.elapsedMs / 1000 : null;
        const actualAvgPower = stats?.avgPower ?? null;
        const durationDelta = Number.isFinite(actualDuration) && Number.isFinite(durationSec)
            ? actualDuration - durationSec
            : null;
        const powerDelta = Number.isFinite(actualAvgPower) && Number.isFinite(targetPower)
            ? actualAvgPower - targetPower
            : null;

        // Use W'bal from plan data directly instead of recalculating
        const planWbalKj = Number(interval?.wbal_kj);
        const wbalJ = Number.isFinite(planWbalKj) ? planWbalKj * 1000 : null;

        const wbalPercent = Number.isFinite(wPrime) && wPrime > 0 && Number.isFinite(wbalJ)
            ? clamp((wbalJ / wPrime) * 100, -100, 200)
            : null;

        return {
            index: idx + 1,
            startKm: actualStart,
            endKm: actualEnd,
            power: targetPower,
            planPower,
            biasApplied: hasActivePowerBias(stats, bias),
            durationText: interval?.duration_text ?? formatDuration(durationSec),
            durationSec,
            grade: Number(interval?.avg_gradient),
            wbalJ: wbalJ,
            wbalPercent,
            planStartKm: startPlan,
            planEndKm: endPlan,
            actualDurationSec: actualDuration,
            actualAvgPower,
            durationDelta,
            powerDelta,
            intervalStats: stats,
        };
    });
}

function advancePlanWbal(current, cp, wPrime, targetPower, durationSec) {
    if (!Number.isFinite(current) || !Number.isFinite(cp) || !Number.isFinite(wPrime) || wPrime <= 0 || !Number.isFinite(durationSec)) {
        return current;
    }
    if (!Number.isFinite(targetPower)) {
        return current;
    }
    let next = current;
    if (targetPower > cp) {
        next -= (targetPower - cp) * durationSec;
    } else {
        const recovery = cp - targetPower;
        const expTerm = Math.exp(-(recovery * durationSec) / wPrime);
        next = wPrime - (wPrime - current) * expTerm;
    }
    return clamp(next, -wPrime, wPrime);
}

function getEffectivePowerBias() {
    const bias = Number(state.powerBias);
    return Number.isFinite(bias) && bias > 0 ? bias : 1;
}

function isPowerBiasActive(biasValue) {
    const value = Number.isFinite(biasValue) ? biasValue : getEffectivePowerBias();
    return Math.abs(value - 1) > 1e-3;
}

function hasActivePowerBias(stats, biasValue) {
    if (!isPowerBiasActive(biasValue)) {
        return false;
    }
    if (!stats) {
        return true;
    }
    return stats.finished !== true;
}

function getBiasedPower(planPower, stats, biasValue) {
    if (!Number.isFinite(planPower)) {
        return planPower;
    }
    if (!hasActivePowerBias(stats, biasValue)) {
        return planPower;
    }
    const bias = Number.isFinite(biasValue) && biasValue > 0 ? biasValue : getEffectivePowerBias();
    return planPower * bias;
}

function handleWatching(watching) {
    const athleteId = getWatchingAthleteId(watching);
    maybeAdoptHomeAthleteId(athleteId);
    if (shouldBlockTelemetry(athleteId)) {
        setSpectateState(true, formatSpectateReason(watching), {spectatingAthleteId: athleteId});
        state.watching = state.lastValidWatching;
        render();
        return;
    }

    state.watching = watching ?? null;
    if (watching) {
        state.lastValidWatching = watching;
    }
    setSpectateState(false);

    const power = watching?.state?.power ?? watching?.stats?.power?.cur ?? null;
    updateResolvedMetrics(watching);
    const distanceMeters = deriveDistanceMeters(watching);
    updateEventTelemetryAndOffset(watching, distanceMeters);
    if (state.eventComplete) {
        render();
        return;
    }

    const eventProgressKm = getEventProgressKm();
    const baseDistanceKm = Number.isFinite(eventProgressKm)
        ? eventProgressKm
        : (Number.isFinite(distanceMeters) ? distanceMeters / 1000 : NaN);
    const planDistanceKm = Number.isFinite(baseDistanceKm)
        ? baseDistanceKm + getEffectiveOffsetKm()
        : NaN;
    const previousIndex = state.currentIndex;
    const nextIndex = findCurrentInterval(planDistanceKm);
    
    // Fallback: If we're on first interval and event has started but no tracking yet, initialize everything
    const firstIntervalFallback = checkFirstIntervalFallback(nextIndex, eventProgressKm, distanceMeters);
    if (firstIntervalFallback) {
        console.log('[INTERVAL LIST] First interval fallback triggered - initializing tracking mid-interval');
        resetAllStatsAndPredictions();
        const now = Date.now();
        beginIntervalStats(nextIndex, {timestamp: now, planDistanceKm});
    }
    
    const intervalChanged = previousIndex !== nextIndex;
    updateIntervalTracking(previousIndex, nextIndex, power, planDistanceKm);
    state.currentIndex = nextIndex;
    // Only recompute enriched intervals when interval changes, not every tick
    if (intervalChanged) {
        recomputeIntervals();
    }
    render();
}

function updateResolvedMetrics(watching) {
    const ftpResolved = resolveMetric(getPlanFtp(), getTelemetryFtp(watching));
    const wPrimeResolved = resolveMetric(getPlanWPrime(), getTelemetryWPrime(watching));
    if (ftpResolved.changed) {
        state.metrics.ftp = ftpResolved.value;
        state.metrics.ftpSource = ftpResolved.source;
    }
    if (wPrimeResolved.changed) {
        state.metrics.wPrime = wPrimeResolved.value;
        state.metrics.wPrimeSource = wPrimeResolved.source;
    }
}

function render() {
    const hasPlan = Boolean(state.plan && state.intervals.length);
    if (els.window) {
        els.window.classList.toggle('empty', !hasPlan);
    }
    updateSummary();
    renderTable();
}

function updateSummary() {
    if (!els.planRoute) {
        return;
    }
    const route = state.plan?.route?.name ?? 'Custom plan';
    const planDistance = getPlanTotalDistanceKm();
    els.planRoute.textContent = state.plan ? route : 'Load a TT plan';
    els.planDistance.textContent = state.plan && Number.isFinite(planDistance)
        ? `${planDistance.toFixed(1)} km`
        : 'No plan distance';

    const manual = Math.round(state.distanceOffset ?? 0);
    const auto = Math.round((state.usesEventProgress ? 0 : state.autoOffset) ?? 0);
    const total = Math.round(getEffectiveOffsetMeters());
    if (els.offsetPill) {
        els.offsetPill.textContent = `Offset ${formatMeters(total)}`;
        const courseDelta = getCourseDiscrepancyMeters();
        const parts = [`Manual ${formatMeters(manual)}`, `${state.usesEventProgress ? 'auto (locked)' : 'auto'} ${formatMeters(auto)}`];
        if (Number.isFinite(courseDelta)) {
            parts.push(`course Δ ${formatMeters(courseDelta)}`);
        }
        els.offsetPill.title = parts.join(' · ');
    }

    updateSummaryDuration();
    const ftp = getResolvedFtp();
    const wPrime = getResolvedWPrime();
    els.summaryFtp.textContent = formatMetric(ftp, 'W');
    els.summaryWprime.textContent = formatMetric(wPrime != null ? wPrime / 1000 : null, 'kJ');

    const planTargetPower = Number.isFinite(state.planAvgPower) ? state.planAvgPower : null;
    const expectedPowerStats = computeExpectedPowerSoFar();
    const expectedAvgPower = Number.isFinite(expectedPowerStats.expectedAvgPower) ? expectedPowerStats.expectedAvgPower : null;
    const actualPowerStats = computeActualPowerStats();
    const actualAvgPower = Number.isFinite(actualPowerStats.avgPower) ? actualPowerStats.avgPower : null;

    const expectedText = formatPower(expectedAvgPower);
    const actualText = formatPower(actualAvgPower);
    const planLine = planTargetPower != null ? `Plan target ${formatPower(planTargetPower)}` : 'Plan target —';
    els.summaryAvgPower.innerHTML = `<span class="stat-line">${expectedText} exp / ${actualText} act</span><span class="subtext">${planLine}</span>`;

    // Fix: Use planTargetPower for IF calculation
    const ifValue = computeIfValue(planTargetPower, ftp);
    const actualIf = computeActualIf(actualAvgPower, ftp);
    els.summaryIf.textContent = formatTargetActualMetric(ifValue, actualIf, {
        formatter: value => value.toFixed(2),
        precision: 2,
    });
}

function updateSummaryDuration() {
    if (!els.summaryDuration) {
        return;
    }
    if (!state.plan) {
        els.summaryDuration.textContent = '—';
        return;
    }
    const planText = state.planDurationText
        ?? (Number.isFinite(state.planDurationSeconds) ? formatDuration(state.planDurationSeconds) : null)
        ?? '—';
    // Consume prediction from shared storage instead of computing independently
    const prediction = state.persisted?.finishPrediction;
    if (prediction && prediction.predictedText) {
        const deltaHtml = formatDurationDelta(prediction.deltaSeconds);
        const planLabel = `plan ${planText}`;
        const predLabel = `pred ${prediction.predictedText}${deltaHtml ? ` ${deltaHtml}` : ''}`;
        els.summaryDuration.innerHTML = `<span class="plan-time">${planLabel}</span><span class="prediction-line">${predLabel}</span>`;
    } else {
        els.summaryDuration.textContent = planText;
    }
}

function renderTable({force = false} = {}) {
    if (!els.tableBody) {
        return;
    }
    const now = Date.now();
    const planSignature = state.planSignature;
    const activeIndex = state.currentIndex;
    const planChanged = planSignature !== state.lastTablePlanSignature;
    const activeChanged = activeIndex !== state.lastRenderedActiveIndex;
    const cooldownElapsed = !Number.isFinite(state.lastTableRenderMs)
        || now - state.lastTableRenderMs >= TABLE_RENDER_COOLDOWN_MS;

    if (!force && !planChanged && !cooldownElapsed) {
        if (activeChanged) {
            syncActiveRowHighlight(activeIndex);
        }
        return;
    }

    if (!state.enrichedIntervals.length) {
        if (els.tableBody.childNodes.length) {
            els.tableBody.replaceChildren();
        }
        state.lastTableRenderMs = now;
        state.lastTablePlanSignature = planSignature;
        state.lastRenderedActiveIndex = -1;
        return;
    }

    const total = state.enrichedIntervals.length;
    const rows = state.enrichedIntervals.map(interval => {
        const tr = document.createElement('tr');
        if (interval.index - 1 === activeIndex) {
            tr.classList.add('active');
        }
        tr.append(
            makeCell('col-index', `#${String(interval.index).padStart(2, '0')}`),
            makeCell('col-distance', formatKm(interval.startKm)),
            makeCell('col-distance', formatKm(interval.endKm)),
            makeCell('col-power', renderPowerCell(interval)),
            makeCell('col-duration', renderDurationCell(interval)),
            makeCell('col-grade', formatGrade(interval.grade)),
            makeCell('col-wbal', formatWbal(interval.wbalJ, interval.wbalPercent))
        );
        tr.dataset.index = String(interval.index);
        if (interval.index === 1 || interval.index === total) {
            tr.dataset.edge = interval.index === 1 ? 'start' : 'end';
        }
        return tr;
    });
    els.tableBody.replaceChildren(...rows);
    state.lastTableRenderMs = now;
    state.lastTablePlanSignature = planSignature;
    state.lastRenderedActiveIndex = activeIndex;
    centerActiveRow();
}

function syncActiveRowHighlight(activeIndex) {
    if (!els.tableBody) {
        return;
    }
    const desiredIndex = Number.isInteger(activeIndex) && activeIndex >= 0 ? activeIndex + 1 : null;
    const currentActive = els.tableBody.querySelector('tr.active');
    if (currentActive) {
        const currentIdx = Number(currentActive.dataset.index);
        if (currentIdx === desiredIndex) {
            return;
        }
        currentActive.classList.remove('active');
    }
    if (desiredIndex != null) {
        const next = els.tableBody.querySelector(`tr[data-index="${desiredIndex}"]`);
        if (next) {
            next.classList.add('active');
            centerActiveRow();
        }
    }
    state.lastRenderedActiveIndex = activeIndex;
}

function makeCell(className, content) {
    const td = document.createElement('td');
    td.className = className;
    if (content instanceof HTMLElement) {
        td.append(content);
    } else {
        td.innerHTML = content ?? '—';
    }
    return td;
}

function centerActiveRow({ignoreHold = false} = {}) {
    if (!els.tableWrapper) {
        return;
    }
    if (!ignoreHold && isAutoCenterPaused()) {
        return;
    }
    requestAnimationFrame(() => {
        const activeRow = els.tableBody.querySelector('tr.active');
        if (!activeRow) {
            return;
        }
        const container = els.tableWrapper;
        const containerHeight = container.clientHeight;
        const rowCenter = activeRow.offsetTop + activeRow.clientHeight / 2;
        const target = rowCenter - containerHeight / 2;
        const maxScroll = Math.max(0, container.scrollHeight - containerHeight);
        const nextScroll = clamp(target, 0, maxScroll);
        if (Math.abs(container.scrollTop - nextScroll) > 1) {
            container.scrollTop = nextScroll;
        }
    });
}

function pauseAutoCentering() {
    state.manualScrollHoldUntil = Date.now() + AUTO_CENTER_DELAY_MS;
    if (autoCenterResumeTimer) {
        clearTimeout(autoCenterResumeTimer);
    }
    autoCenterResumeTimer = window.setTimeout(() => {
        autoCenterResumeTimer = null;
        state.manualScrollHoldUntil = 0;
        centerActiveRow({ignoreHold: true});
    }, AUTO_CENTER_DELAY_MS);
}

function isAutoCenterPaused() {
    return Number.isFinite(state.manualScrollHoldUntil) && state.manualScrollHoldUntil > Date.now();
}

function computeIfValue(avgPower, ftp) {
    if (Number.isFinite(state.planIfPercent)) {
        const value = state.planIfPercent > 10 ? state.planIfPercent / 100 : state.planIfPercent;
        return value;
    }
    if (Number.isFinite(avgPower) && Number.isFinite(ftp) && ftp > 0) {
        return avgPower / ftp;
    }
    return null;
}

function resolveMetric(planValue, telemetryValue) {
    if (Number.isFinite(planValue)) {
        return {value: planValue, source: 'plan', changed: true};
    }
    if (Number.isFinite(telemetryValue)) {
        return {value: telemetryValue, source: 'telemetry', changed: true};
    }
    return {value: null, source: null, changed: true};
}

function getPlanFtp() {
    return Number(state.plan?.rider?.ftp);
}

function getPlanWPrime() {
    return Number(state.plan?.settings?.wPrime);
}

function getTelemetryFtp(watching) {
    return Number(watching?.athlete?.ftp ?? watching?.stats?.ftp);
}

function getTelemetryWPrime(watching) {
    return Number(watching?.athlete?.wPrime ?? watching?.stats?.wPrime);
}

function getResolvedFtp() {
    const planFtp = getPlanFtp();
    if (Number.isFinite(planFtp)) {
        return planFtp;
    }
    return Number(state.metrics.ftp);
}

function getResolvedWPrime() {
    const planWPrime = getPlanWPrime();
    if (Number.isFinite(planWPrime)) {
        return planWPrime;
    }
    if (Number.isFinite(state.metrics.wPrime)) {
        return state.metrics.wPrime;
    }
    return DEFAULT_WPRIME;
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

function updateEventTelemetryAndOffset(watching, distanceMeters) {
    const info = deriveEventTelemetry(watching);
    const totalMeters = Number.isFinite(info.totalMeters) ? info.totalMeters : null;
    const remainingMeters = Number.isFinite(info.remainingMeters) ? info.remainingMeters : null;
    const progressMeters = Number.isFinite(info.progressMeters) ? info.progressMeters : null;

    if (totalMeters != null) {
        state.eventDistanceMeters = totalMeters;
    }
    if (remainingMeters != null) {
        state.eventRemainingMeters = remainingMeters;
    }
    if (progressMeters != null) {
        state.eventProgressMeters = progressMeters;
    }
    state.usesEventProgress = Number.isFinite(progressMeters);
    if (state.usesEventProgress && state.autoOffset !== 0) {
        state.autoOffset = 0;
    }
    updateEventCompletionState({totalMeters, remainingMeters, progressMeters});
}

function updateEventCompletionState({totalMeters, remainingMeters, progressMeters} = {}) {
    const remaining = Number.isFinite(remainingMeters)
        ? remainingMeters
        : (Number.isFinite(state.eventRemainingMeters) ? state.eventRemainingMeters : null);
    const progress = Number.isFinite(progressMeters)
        ? progressMeters
        : (Number.isFinite(state.eventProgressMeters) ? state.eventProgressMeters : null);
    const total = Number.isFinite(totalMeters)
        ? totalMeters
        : (Number.isFinite(state.eventDistanceMeters) ? state.eventDistanceMeters : null);
    if (state.eventComplete) {
        return;
    }
    const finished = isEventComplete({remaining, progress, total});
    if (finished) {
        markEventComplete();
    }
}

function isEventComplete({remaining, progress, total}) {
    if (Number.isFinite(remaining)) {
        return remaining <= 0.5;
    }
    if (Number.isFinite(total) && total > 0 && Number.isFinite(progress)) {
        return progress >= total;
    }
    return false;
}

function markEventComplete() {
    state.eventComplete = true;
    state.eventCompleteTimestamp = Date.now();
    finalizeAllIntervals();
    recomputeIntervals();
}

function finalizeAllIntervals() {
    const timestamp = Date.now();
    state.intervalStats.forEach((stats, index) => {
        if (stats && !stats.finished) {
            finalizeIntervalStats(index, {timestamp, power: null});
        }
    });
}

function resetEventCompletionState({clearStats = false, resetPrediction = true} = {}) {
    const wasComplete = state.eventComplete;
    state.eventComplete = false;
    state.eventCompleteTimestamp = null;
    // Interval list no longer manages prediction state; dashboard is sole source
    if (clearStats) {
        state.intervalStats = [];
        state.currentIndex = -1;
        recomputeIntervals();
    } else if (wasComplete) {
        recomputeIntervals();
    }
}

function updateIntervalTracking(previousIndex, nextIndex, power, planDistanceKm) {
    const now = Date.now();
    if (previousIndex !== nextIndex) {
        finalizeIntervalStats(previousIndex, {timestamp: now, power});
        beginIntervalStats(nextIndex, {timestamp: now, planDistanceKm});
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
    state.intervalStats[index] = {
        startMs: timestamp,
        lastUpdateMs: timestamp,
        elapsedMs: 0,
        powerIntegral: 0,
        timeIntegral: 0,
        avgPower: null,
        finished: false,
        partial: detectPartialInterval(index, planDistanceKm),
    };
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

function finalizeIntervalStats(index, {timestamp, power}) {
    if (!Number.isInteger(index) || index < 0) {
        return;
    }
    const stats = state.intervalStats[index];
    if (!stats || stats.finished) {
        return;
    }
    advanceIntervalStats(index, {timestamp, power});
    stats.finished = true;
}

function checkFirstIntervalFallback(currentIndex, eventProgressKm, distanceMeters) {
    // Only apply fallback for first interval (index 0)
    if (currentIndex !== 0) {
        return false;
    }
    
    // Check if we already have tracking initialized for first interval
    const firstIntervalStats = state.intervalStats[0];
    if (firstIntervalStats && (firstIntervalStats.startMs || firstIntervalStats.elapsedMs > 0)) {
        return false;
    }
    
    // Check if event has started (progress > 0)
    const hasEventProgress = Number.isFinite(eventProgressKm) && eventProgressKm > 0;
    const hasDistance = Number.isFinite(distanceMeters) && distanceMeters > 0;
    
    if (!hasEventProgress && !hasDistance) {
        return false;
    }
    
    // Fallback triggered: we're on first interval, event has started, but no tracking initialized
    return true;
}

function resetAllStatsAndPredictions() {
    // Clear all interval stats
    state.intervalStats = [];
    
    // Reset current index (will be set again immediately after)
    state.currentIndex = -1;
    
    // Clear finish prediction by signaling a reset
    const resetSignal = Date.now();
    persistSharedState({
        finishPrediction: null,
        clearStatsTimestamp: resetSignal,
    });
    state.lastClearStatsTimestamp = resetSignal;
    
    // Force recompute and render
    recomputeIntervals();
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

function getPlanTotalDistanceKm() {
    if (!state.plan) {
        return null;
    }
    const summaryDistance = Number(state.plan?.summary?.distance_km);
    if (Number.isFinite(summaryDistance) && summaryDistance > 0) {
        return summaryDistance;
    }
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

function getEventProgressKm() {
    return Number.isFinite(state.eventProgressMeters)
        ? state.eventProgressMeters / 1000
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

function getScaledDistanceKm(value) {
    if (!Number.isFinite(value)) {
        return value;
    }
    const planTotal = getPlanTotalDistanceKm();
    const eventTotal = getEventDistanceKm();
    if (!Number.isFinite(planTotal) || planTotal <= 0 || !Number.isFinite(eventTotal) || eventTotal <= 0) {
        return value;
    }
    const scale = eventTotal / planTotal;
    return value * scale;
}

function getEffectiveOffsetMeters() {
    const manual = Number(state.distanceOffset) || 0;
    const auto = state.usesEventProgress ? 0 : (Number(state.autoOffset) || 0);
    return manual + auto;
}

function getEffectiveOffsetKm() {
    return getEffectiveOffsetMeters() / 1000;
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

function formatDuration(seconds) {
    if (!Number.isFinite(seconds) || seconds <= 0) {
        return null;
    }
    const hrs = Math.floor(seconds / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);
    if (hrs > 0) {
        return `${hrs}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
    }
    return `${mins}:${String(secs).padStart(2, '0')}`;
}

function formatKm(value) {
    if (!Number.isFinite(value)) {
        return '—';
    }
    return `${value.toFixed(1)} km`;
}

function formatPower(value) {
    if (!Number.isFinite(value)) {
        return '—';
    }
    return `${Math.round(value)} W`;
}

function renderPowerCell(interval) {
    // Show interval target power, and if finished (and not partial), delta vs actual interval avg
    const base = formatPower(interval.power);
    const showDelta = interval.intervalStats?.finished && !interval.intervalStats?.partial;
    if (!showDelta) {
        return base;
    }
    const deltaHtml = decorateWithDelta('', interval.powerDelta, {
        unit: ' W',
        decimals: 0,
        threshold: 0.5,
        invertColor: true,
        formatter(delta, {unit, decimals}) {
            const sign = delta > 0 ? '+' : '-';
            return `${sign}${Math.abs(delta).toFixed(decimals)}${unit}`;
        }
    });
    return deltaHtml ? `${base}<br>${deltaHtml}` : base;
}

function renderDurationCell(interval) {
    const base = interval.durationText ?? '—';
    const showActual = interval.intervalStats?.finished && !interval.intervalStats?.partial;
    if (!showActual) {
        return base;
    }
    const deltaHtml = formatDurationDelta(interval.durationDelta);
    return deltaHtml ? `${base}<br>${deltaHtml}` : base;
}

function formatGrade(value) {
    if (!Number.isFinite(value)) {
        return '—';
    }
    const percent = value;
    return `${percent.toFixed(1)}%`;
}

function formatWbal(valueJ, percent) {
    if (!Number.isFinite(valueJ)) {
        return '—';
    }
    const kj = valueJ / 1000;
    const percentText = Number.isFinite(percent) ? `${percent.toFixed(0)}%` : '';
    return percentText ? `${kj.toFixed(1)} kJ<br><span class="subtext">${percentText}</span>` : `${kj.toFixed(1)} kJ`;
}

function formatDurationDelta(delta) {
    const html = decorateWithDelta('', delta, {
        unit: '',
        decimals: 1,
        threshold: 0,
        invertColor: false,
        formatter(deltaValue) {
            const sign = deltaValue >= 0 ? '+' : '-';
            const absDuration = formatDuration(Math.abs(deltaValue));
            return absDuration ? `${sign}${absDuration}` : '';
        },
    });
    return typeof html === 'string' ? html.trim() : '';
}

// Removed computeFinishPrediction() and shareFinishPrediction() - dashboard is sole source of predictions
// Interval list consumes predictions from state.persisted.finishPrediction instead

function computePacingRatio() {
    let planSeconds = 0;
    let actualSeconds = 0;
    state.intervals.forEach((interval, idx) => {
        const durationSec = parseDurationSeconds(interval);
        const stats = state.intervalStats[idx];
        if (!Number.isFinite(durationSec) || !stats?.finished || !Number.isFinite(stats.elapsedMs)) {
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

function computeActualPowerStats() {
    let totalPowerIntegral = 0;
    let totalTimeMs = 0;
    for (const stats of state.intervalStats) {
        if (!stats) {
            continue;
        }
        if (Number.isFinite(stats.powerIntegral) && Number.isFinite(stats.timeIntegral)) {
            totalPowerIntegral += stats.powerIntegral;
            totalTimeMs += stats.timeIntegral;
        }
    }
    if (totalTimeMs >= MIN_AVERAGE_TIME_MS && totalTimeMs > 0) {
        return {
            avgPower: totalPowerIntegral / totalTimeMs,
            totalSeconds: totalTimeMs / 1000,
        };
    }
    return {avgPower: null, totalSeconds: 0};
}

function computeExpectedPowerSoFar() {
    let totalWork = 0;
    let totalTimeSeconds = 0;

    for (const interval of state.enrichedIntervals) {
        const stats = interval?.intervalStats;
        const targetPower = Number(interval?.power);
        const timeMs = Number(stats?.timeIntegral);
        if (!Number.isFinite(targetPower) || !Number.isFinite(timeMs) || timeMs <= 0) {
            continue;
        }
        const timeSeconds = timeMs / 1000;
        totalWork += targetPower * timeSeconds;
        totalTimeSeconds += timeSeconds;
    }

    if (totalTimeSeconds > 0) {
        return {
            expectedAvgPower: totalWork / totalTimeSeconds,
            totalSeconds: totalTimeSeconds,
        };
    }
    return {expectedAvgPower: null, totalSeconds: 0};
}

function computeActualCumulativeAverage(upToIntervalIndex) {
    // Compute actual average power up to and including the specified interval
    let totalPowerIntegral = 0;
    let totalTimeMs = 0;
    
    for (let i = 0; i <= upToIntervalIndex && i < state.intervalStats.length; i++) {
        const stats = state.intervalStats[i];
        if (!stats) {
            continue;
        }
        if (Number.isFinite(stats.powerIntegral) && Number.isFinite(stats.timeIntegral)) {
            totalPowerIntegral += stats.powerIntegral;
            totalTimeMs += stats.timeIntegral;
        }
    }
    
    if (totalTimeMs > 0) {
        return totalPowerIntegral / totalTimeMs;
    }
    return null;
}

function computeActualIf(actualAvgPower, ftp) {
    if (Number.isFinite(actualAvgPower) && Number.isFinite(ftp) && ftp > 0) {
        return actualAvgPower / ftp;
    }
    return null;
}

function formatTargetActualMetric(target, actual, {unit = '', formatter} = {}) {
    const formatValue = (value) => {
        if (!Number.isFinite(value)) {
            return null;
        }
        if (typeof formatter === 'function') {
            return formatter(value);
        }
        if (unit === 'W') {
            return `${Math.round(value)} ${unit}`;
        }
        if (unit) {
            return `${value.toFixed(1)} ${unit}`;
        }
        return `${value}`;
    };
    const targetText = formatValue(target);
    const actualText = formatValue(actual);
    if (targetText && actualText) {
        return `${targetText} tgt / ${actualText} act`;
    }
    if (targetText) {
        return `${targetText} tgt`;
    }
    if (actualText) {
        return `${actualText} act`;
    }
    return '—';
}

function decorateWithDelta(base, delta, {unit = '', decimals = 1, threshold = 0, invertColor = false, formatter} = {}) {
    if (!Number.isFinite(delta) || Math.abs(delta) < threshold) {
        return base;
    }
    const defaultFormatter = (value) => {
        const sign = value > 0 ? '+' : '';
        return `${sign}${Math.abs(value).toFixed(decimals)}${unit}`;
    };
    const text = typeof formatter === 'function' ? formatter(delta, {unit, decimals}) : defaultFormatter(delta);
    const positiveClass = invertColor ? 'delta-negative' : 'delta-positive';
    const negativeClass = invertColor ? 'delta-positive' : 'delta-negative';
    const className = delta >= 0 ? positiveClass : negativeClass;
    return `${base} <span class="delta ${className}">${text}</span>`;
}

function formatMetric(value, unit = '', source) {
    if (!Number.isFinite(value)) {
        return '—';
    }
    const rounded = unit === 'W' ? Math.round(value) : value;
    const suffix = unit ? `${rounded} ${unit}` : `${rounded}`;
    return source ? `${suffix} (${source})` : suffix;
}

function formatMeters(value) {
    const sign = value > 0 ? '+' : '';
    return `${sign}${value} m`;
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
    return Number.isFinite(num) ? String(num) : null;
}

function getWatchingAthleteId(watching) {
    if (!watching) {
        return null;
    }
    const candidates = [watching.athleteId, watching.athlete?.id, watching.athlete?.athleteId];
    for (const candidate of candidates) {
        const normalized = normalizeAthleteId(candidate);
        if (normalized) {
            return normalized;
        }
    }
    return null;
}

function setHomeAthleteId(athleteId, {share = true} = {}) {
    const normalized = normalizeAthleteId(athleteId);
    if (state.homeAthleteId === normalized) {
        return false;
    }
    state.homeAthleteId = normalized;
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

function clearHomeAthleteId({share = true, resetTelemetry = true} = {}) {
    setHomeAthleteId(null, {share});
    if (resetTelemetry) {
        state.lastValidWatching = null;
        state.watching = null;
    }
}

function shouldBlockTelemetry(athleteId) {
    return Boolean(state.homeAthleteId && athleteId && state.homeAthleteId !== athleteId);
}

function formatSpectateReason(watching) {
    const name = watching?.athlete?.sanitizedFullname || watching?.athlete?.fullname || null;
    return name ? `Spectating ${name} — stats paused` : 'Spectating another rider — stats paused';
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
    return {
        totalSeconds,
        totalWork,
        seconds: totalSeconds,
        text: formatDuration(totalSeconds),
    };
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

function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
}
