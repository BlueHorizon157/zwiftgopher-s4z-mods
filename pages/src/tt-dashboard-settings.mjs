import * as common from '/pages/src/common.mjs';

const STORAGE_KEY = 'tt-dashboard-state';
const DEFAULT_TARGET_BAND_WIDTH = 5;
const TARGET_BAND_MIN = 1;
const TARGET_BAND_MAX = 75;

let cachedState = null;

export function main() {
    document.body.classList.remove('transparent-bg');
    if (common.initInteractionListeners) {
        common.initInteractionListeners();
    }

    const bandRange = document.getElementById('band-range');
    const bandNumber = document.getElementById('band-number');
    const debugCheckbox = document.getElementById('debug-checkbox');
    const smoothingSelect = document.getElementById('smoothing-window');
    const smoothingValue = document.getElementById('smoothing-value');

    cachedState = getPersistedState();
    applyStateToInputs(cachedState, {bandRange, bandNumber, debugCheckbox, smoothingSelect, smoothingValue});

    const updateBandWidth = value => {
        const normalized = normalizeBandWidth(value);
        if (!Number.isFinite(normalized)) {
            return;
        }
        bandRange.value = normalized;
        bandNumber.value = normalized;
        savePartial({targetBandWidthW: normalized});
    };

    bandRange.addEventListener('input', () => updateBandWidth(Number(bandRange.value)));
    bandNumber.addEventListener('input', () => updateBandWidth(Number(bandNumber.value)));

    debugCheckbox.addEventListener('change', () => {
        savePartial({showDebug: debugCheckbox.checked});
    });

    const updateSmoothing = value => {
        const val = normalizeSmoothing(value);
        if (!Number.isFinite(val)) {
            return;
        }
        smoothingSelect.value = String(val);
        smoothingValue.textContent = val > 0 ? `${val.toFixed(1)}s` : 'Off';
        savePartial({powerSmoothingSec: val});
    };

    smoothingSelect.addEventListener('change', () => updateSmoothing(parseFloat(smoothingSelect.value)));

    if (common.storage) {
        common.storage.addEventListener('update', ev => {
            if (!ev?.data || ev.data.key !== STORAGE_KEY) {
                return;
            }
            cachedState = ev.data.value || {};
            applyStateToInputs(cachedState, {bandRange, bandNumber, debugCheckbox, smoothingSelect, smoothingValue});
        });
    }
}

function getPersistedState() {
    return common.storage?.get(STORAGE_KEY) || {};
}

function savePartial(partial) {
    if (!common.storage) {
        return;
    }
    cachedState = {...(cachedState || {}), ...partial};
    common.storage.set(STORAGE_KEY, cachedState);
}

function applyStateToInputs(state, elements) {
    const width = normalizeBandWidth(state?.targetBandWidthW);
    elements.bandRange.value = width;
    elements.bandNumber.value = width;
    elements.debugCheckbox.checked = !!state?.showDebug;
    const smoothing = normalizeSmoothing(state?.powerSmoothingSec);
    if (elements.smoothingSelect) {
        elements.smoothingSelect.value = String(smoothing);
    }
    if (elements.smoothingValue) {
        elements.smoothingValue.textContent = smoothing > 0 ? `${smoothing.toFixed(1)}s` : 'Off';
    }
}

function normalizeBandWidth(value) {
    const width = Number.isFinite(value) ? value : DEFAULT_TARGET_BAND_WIDTH;
    return clamp(width, TARGET_BAND_MIN, TARGET_BAND_MAX);
}

function normalizeSmoothing(value) {
    const raw = Number.isFinite(value) ? value : 0;
    const clamped = clamp(raw, 0, 5);
    // snap to 0.5s steps
    return Math.round(clamped * 2) / 2;
}

function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
}
