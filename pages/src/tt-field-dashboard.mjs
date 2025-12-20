import * as common from '/pages/src/common.mjs';

const AUTO_CENTER_DELAY_MS = 5000;
const CHECKPOINT_SPACING_METERS = 10;
const MAX_CHECKPOINT_HISTORY = 6000;
const SETTINGS_KEY = 'tt-field-dashboard-settings';
const state = {
    riders: [],
    lastUpdated: null,
    activeAthleteId: null,
    manualScrollHoldUntil: 0,
    checkpointTimes: new Map(),
    showAllRiders: false,
    persistentRiders: new Map(), // athleteId -> {entry, lastSeen, metrics}
};

const els = {};
let autoCenterResumeTimer = null;

export function main() {
    common.initInteractionListeners();
    queryEls();
    loadSettings();
    initManualScrollPause();
    initStorageListener();
    updateMeta();
    renderRows();
    common.subscribe('nearby', handleNearby);
    document.addEventListener('contextmenu', () => {
        if (els.titlebar) {
            els.titlebar.style.display = 'block';
        }
    });
}

function loadSettings() {
    const settings = common.storage.get(SETTINGS_KEY) || {};
    state.showAllRiders = settings.showAllRiders === true;
}

function initStorageListener() {
    common.storage.addEventListener(SETTINGS_KEY, () => {
        loadSettings();
        renderRows();
    });
}

function queryEls() {
    els.window = document.querySelector('.window');
    els.tableBody = document.querySelector('#rider-table tbody');
    els.tableWrapper = document.querySelector('.table-wrapper');
    els.emptyState = document.getElementById('empty-state');
    els.titlebar = document.querySelector('#titlebar');
    els.positionCounter = document.getElementById('position-counter');
}

function initManualScrollPause() {
    if (!els.tableWrapper) {
        return;
    }
    const pause = () => pauseAutoCentering();
    const passive = {passive: true};
    els.tableWrapper.addEventListener('wheel', pause, passive);
    els.tableWrapper.addEventListener('touchstart', pause, passive);
    els.tableWrapper.addEventListener('pointerdown', pause);
    els.tableWrapper.addEventListener('scroll', pause, passive);
}

function handleNearby(payload = []) {
    const now = Date.now();
    if (Array.isArray(payload)) {
        state.riders = payload.filter(entry => entry);
        const activeEntry = payload.find(entry => entry?.watching);
        state.activeAthleteId = getAthleteId(activeEntry);
        
        // Update persistent rider tracking
        for (const entry of state.riders) {
            const athleteId = getAthleteId(entry);
            if (athleteId) {
                const metrics = computeMetrics(entry);
                state.persistentRiders.set(athleteId, {
                    entry,
                    metrics,
                    lastSeen: now,
                    inCurrentFeed: true,
                });
            }
        }
        // Mark riders not in current feed
        for (const [athleteId, data] of state.persistentRiders) {
            if (!state.riders.some(e => getAthleteId(e) === athleteId)) {
                data.inCurrentFeed = false;
            }
        }
    } else {
        state.riders = [];
        state.activeAthleteId = null;
        // Mark all persistent riders as not in feed
        for (const data of state.persistentRiders.values()) {
            data.inCurrentFeed = false;
        }
    }
    trackCheckpointTimes(payload);
    state.lastUpdated = now;
    updateMeta();
    renderRows();
}

function updateMeta() {
    // No meta to update
}

function renderRows() {
    if (!els.tableBody || !els.window) {
        return;
    }
    // Build rows from persistent riders (includes both in-feed and historical)
    const activeEntry = state.activeAthleteId 
        ? (state.riders.find(entry => getAthleteId(entry) === state.activeAthleteId) || 
           state.persistentRiders.get(state.activeAthleteId)?.entry)
        : null;
    const activeSubgroupId = activeEntry?.state?.eventSubgroupId;
    
    // Filter persistent riders by category if needed
    let filteredPersistent = Array.from(state.persistentRiders.values());
    if (!state.showAllRiders && activeSubgroupId) {
        filteredPersistent = filteredPersistent.filter(data => 
            data.entry?.state?.eventSubgroupId === activeSubgroupId
        );
    }

    const allRows = filteredPersistent
        .map(data => ({
            entry: data.entry,
            metrics: data.metrics,
            isActive: getAthleteId(data.entry) === state.activeAthleteId,
            inCurrentFeed: data.inCurrentFeed,
        }))
        .filter(({metrics}) => metrics)
        .sort((a, b) => {
            const aDelta = getSortDelta(a);
            const bDelta = getSortDelta(b);
            if (aDelta !== bDelta) {
                return aDelta - bDelta;
            }
            const aDistance = Number.isFinite(a.metrics.completedKm) ? a.metrics.completedKm : -Infinity;
            const bDistance = Number.isFinite(b.metrics.completedKm) ? b.metrics.completedKm : -Infinity;
            if (aDistance !== bDistance) {
                return bDistance - aDistance;
            }
            const aSpeed = Number.isFinite(a.metrics.avgSpeedKph) ? a.metrics.avgSpeedKph : -Infinity;
            const bSpeed = Number.isFinite(b.metrics.avgSpeedKph) ? b.metrics.avgSpeedKph : -Infinity;
            return bSpeed - aSpeed;
        });

    const riders = allRows;

    els.tableBody.replaceChildren(...riders.map(renderRow));
    const isEmpty = riders.length === 0;
    els.window.classList.toggle('empty', isEmpty);
    if (els.emptyState) {
        els.emptyState.hidden = !isEmpty ? true : false;
    }
    
    // Update position counter
    if (els.positionCounter && state.activeAthleteId) {
        const activeIndex = riders.findIndex(r => r.isActive);
        if (activeIndex !== -1) {
            els.positionCounter.textContent = `Position ${activeIndex + 1} / ${riders.length}`;
            els.positionCounter.hidden = false;
        } else {
            els.positionCounter.hidden = true;
        }
    } else if (els.positionCounter) {
        els.positionCounter.hidden = true;
    }
    
    centerActiveRow();
}

function renderRow({entry, metrics, inCurrentFeed}) {
    const tr = document.createElement('tr');
    tr.dataset.id = entry.athleteId;
    const isActive = getAthleteId(entry) === state.activeAthleteId;
    if (isActive) {
        tr.classList.add('active');
    }
    if (!inCurrentFeed) {
        tr.classList.add('stale');
    }

    tr.append(
        makeCell('col-name', metrics.displayName, metrics.teamLabel),
        makeCell('col-speed', formatNumber(metrics.avgSpeedKph, 2)),
    makeCell('col-dist', Number.isFinite(metrics.completedKm) ? formatNumber(metrics.completedKm, 1) : '—'),
        makeCell('col-gap', renderGapCell(metrics.checkpointDeltaSeconds, isActive)),
        makeCell('col-wkg', formatNumber(metrics.avgWkg, 2)),
        makeCell('col-if', formatNumber(metrics.ifPercent, 1)),
        makeCell('col-wbal', createWbalBar(metrics.wbalKj, metrics.wPrimeKj))
    );
    if (metrics.wbalKj != null && metrics.wPrimeKj != null) {
        const ratio = metrics.wbalKj / metrics.wPrimeKj;
        if (ratio <= 0.2) {
            tr.querySelector('.col-wbal').classList.add('wbal-low');
        }
    }
    return tr;
}

function getSortDelta(row) {
    if (!row) {
        return Infinity;
    }
    if (row.isActive) {
        return 0;
    }
    const delta = row.metrics?.checkpointDeltaSeconds;
    return Number.isFinite(delta) ? delta : Infinity;
}

function makeCell(className, value, subtext) {
    const td = document.createElement('td');
    td.className = className;
    if (value instanceof HTMLElement) {
        td.append(value);
    } else {
        td.textContent = value ?? '—';
    }
    if (subtext) {
        const small = document.createElement('span');
        small.className = 'subtle';
        small.textContent = subtext;
        td.appendChild(small);
    }
    return td;
}

function computeMetrics(entry) {
    if (!entry) {
        return null;
    }
    const avgSpeedMs = Number(entry?.stats?.speed?.avg);
    const avgSpeedKph = Number.isFinite(avgSpeedMs) ? avgSpeedMs : null;
    const avgPower = Number(entry?.stats?.power?.avg);
    const weight = Number(entry?.athlete?.weight);
    const avgWkg = Number.isFinite(avgPower) && Number.isFinite(weight) && weight > 0
        ? avgPower / weight
        : null;
    const np = Number(entry?.stats?.power?.np);
    const ftp = Number(entry?.athlete?.ftp);
    const ifPercent = Number.isFinite(np) && Number.isFinite(ftp) && ftp > 0
        ? (np / ftp) * 100
        : null;
    const wbalJ = Number(entry?.wBal);
    const wPrimeJ = Number(entry?.athlete?.wPrime);
    const wbalKj = Number.isFinite(wbalJ) ? wbalJ / 1000 : null;
    const wPrimeKj = Number.isFinite(wPrimeJ) ? wPrimeJ / 1000 : null;
    const displayName = entry?.athlete?.sanitizedFullname ?? entry?.athlete?.fullname ?? '—';
    const teamLabel = entry?.athlete?.team ?? '';
    const completedMeters = getEntryDistanceMeters(entry);
    const completedKm = Number.isFinite(completedMeters) ? completedMeters / 1000 : null;
    const checkpointDeltaSeconds = computeCheckpointDeltaSeconds(entry);

    return {
        displayName,
        teamLabel,
    avgSpeedKph,
    completedKm,
        avgWkg,
        ifPercent,
        wbalKj,
        wPrimeKj,
        checkpointDeltaSeconds,
    };
}

function renderGapCell(deltaSeconds, isActive) {
    if (isActive || !Number.isFinite(deltaSeconds)) {
        return '—';
    }
    const span = document.createElement('span');
    span.className = `gap-pill ${deltaSeconds >= 0 ? 'gap-positive' : 'gap-negative'}`;
    const sign = deltaSeconds > 0 ? '+' : '';
    span.textContent = `${sign}${deltaSeconds.toFixed(0)}s`;
    return span;
}

function formatNumber(value, digits = 1) {
    if (!Number.isFinite(value)) {
        return '—';
    }
    return value.toFixed(digits);
}

function getEntryDistanceMeters(entry) {
    if (!entry) {
        return null;
    }
    const candidates = [
        entry.state?.distance,
        entry.state?.progress?.distance,
        entry.state?.lapDistance,
        entry.stats?.distance,
        entry.stats?.activeDistance,
    ];
    for (const value of candidates) {
        const num = Number(value);
        if (Number.isFinite(num) && num >= 0) {
            return num;
        }
    }
    return null;
}

function getEntryElapsedSeconds(entry) {
    if (!entry) {
        return null;
    }
    const candidates = [
        entry.state?.time,
        entry.state?.elapsed,
        entry.state?.timer,
        entry.stats?.elapsed,
    ];
    for (const value of candidates) {
        const num = Number(value);
        if (Number.isFinite(num) && num >= 0) {
            return num;
        }
    }
    return null;
}

function trackCheckpointTimes(riders = []) {
    if (!Array.isArray(riders) || riders.length === 0) {
        return;
    }
    for (const entry of riders) {
        const athleteId = getAthleteId(entry);
        if (!athleteId) {
            continue;
        }
        const distanceMeters = getEntryDistanceMeters(entry);
        const elapsedSeconds = getEntryElapsedSeconds(entry);
        if (!Number.isFinite(distanceMeters) || !Number.isFinite(elapsedSeconds)) {
            continue;
        }
        recordCheckpoint(athleteId, distanceMeters, elapsedSeconds);
    }
}

function recordCheckpoint(athleteId, distanceMeters, elapsedSeconds) {
    if (!athleteId) {
        return;
    }
    let record = state.checkpointTimes.get(athleteId);
    if (!record) {
        record = createCheckpointRecord();
        state.checkpointTimes.set(athleteId, record);
    }

    const previousDistance = record.lastSampleDistance;
    const previousElapsed = record.lastSampleElapsed;
    if (Number.isFinite(previousDistance) && distanceMeters + CHECKPOINT_SPACING_METERS < previousDistance) {
        record.times.clear();
        record.lastCheckpoint = null;
        record.minCheckpoint = null;
    }

    const startDistance = Number.isFinite(previousDistance) ? previousDistance : distanceMeters;
    const startElapsed = Number.isFinite(previousElapsed) ? previousElapsed : elapsedSeconds;
    const startIndex = Math.max(0, Math.floor(startDistance / CHECKPOINT_SPACING_METERS));
    const endIndex = Math.floor(distanceMeters / CHECKPOINT_SPACING_METERS);

    if (!Number.isFinite(endIndex) || endIndex < 0) {
        record.lastSampleDistance = distanceMeters;
        record.lastSampleElapsed = elapsedSeconds;
        return;
    }

    if (!Number.isFinite(previousDistance)) {
        addCheckpointTime(record, endIndex, elapsedSeconds);
    } else if (distanceMeters > previousDistance) {
        const distanceDelta = distanceMeters - previousDistance;
        const elapsedDelta = elapsedSeconds - previousElapsed;
        for (let idx = startIndex + 1; idx <= endIndex; idx++) {
            const checkpointMeters = idx * CHECKPOINT_SPACING_METERS;
            const ratio = distanceDelta > 0 ? (checkpointMeters - previousDistance) / distanceDelta : 1;
            const timeAtCheckpoint = previousElapsed + ratio * elapsedDelta;
            addCheckpointTime(record, idx, timeAtCheckpoint);
        }
    }

    record.lastSampleDistance = distanceMeters;
    record.lastSampleElapsed = elapsedSeconds;
}

function createCheckpointRecord() {
    return {
        times: new Map(),
        lastCheckpoint: null,
        minCheckpoint: null,
        lastSampleDistance: null,
        lastSampleElapsed: null,
    };
}

function addCheckpointTime(record, checkpointIndex, elapsedSeconds) {
    if (!Number.isFinite(checkpointIndex) || checkpointIndex < 0 || !Number.isFinite(elapsedSeconds)) {
        return;
    }
    if (!record.times.has(checkpointIndex)) {
        record.times.set(checkpointIndex, elapsedSeconds);
    }
    if (!Number.isFinite(record.minCheckpoint) || checkpointIndex < record.minCheckpoint) {
        record.minCheckpoint = checkpointIndex;
    }
    record.lastCheckpoint = Number.isFinite(record.lastCheckpoint)
        ? Math.max(record.lastCheckpoint, checkpointIndex)
        : checkpointIndex;
    trimCheckpointHistory(record);
}

function trimCheckpointHistory(record) {
    while (record.times.size > MAX_CHECKPOINT_HISTORY) {
        const first = record.times.keys().next();
        if (first.done) {
            break;
        }
        record.times.delete(first.value);
    }
    const next = record.times.keys().next();
    record.minCheckpoint = next.done ? null : next.value;
}

function computeCheckpointDeltaSeconds(entry) {
    const riderId = getAthleteId(entry);
    const activeId = state.activeAthleteId;
    if (!riderId || !activeId || riderId === activeId) {
        return null;
    }
    const activeRecord = state.checkpointTimes.get(activeId);
    const riderRecord = state.checkpointTimes.get(riderId);
    if (!activeRecord || !riderRecord || !activeRecord.times.size || !riderRecord.times.size) {
        return null;
    }
    const latestCandidate = Math.min(
        Number.isFinite(activeRecord.lastCheckpoint) ? activeRecord.lastCheckpoint : -1,
        Number.isFinite(riderRecord.lastCheckpoint) ? riderRecord.lastCheckpoint : -1
    );
    if (!Number.isFinite(latestCandidate) || latestCandidate < 0) {
        return null;
    }
    const lowerBound = Math.max(
        Number.isFinite(activeRecord.minCheckpoint) ? activeRecord.minCheckpoint : 0,
        Number.isFinite(riderRecord.minCheckpoint) ? riderRecord.minCheckpoint : 0
    );
    for (let idx = latestCandidate; idx >= lowerBound; idx--) {
        const activeTime = activeRecord.times.get(idx);
        const riderTime = riderRecord.times.get(idx);
        if (Number.isFinite(activeTime) && Number.isFinite(riderTime)) {
            return riderTime - activeTime;
        }
    }
    return null;
}

function createWbalBar(valueKj, maxKj) {
    if (!Number.isFinite(valueKj) || !Number.isFinite(maxKj) || maxKj <= 0) {
        return '—';
    }
    const ratio = clamp(valueKj / maxKj, 0, 1);
    const bar = document.createElement('div');
    bar.className = 'wbal-bar';
    bar.style.setProperty('--wbal-ratio', ratio);
    return bar;
}

function getAthleteId(entry) {
    if (!entry) {
        return null;
    }
    return entry.athleteId ?? entry.athlete?.id ?? null;
}

function centerActiveRow({ignoreHold = false} = {}) {
    if (!els.tableWrapper || !els.tableBody) {
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

function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
}
