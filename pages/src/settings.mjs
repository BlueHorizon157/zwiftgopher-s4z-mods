// The one settings page (docs/REVAMP_PLAN.md 2.2, 4.6). ?for=hud|list|field picks the
// window's settings store (the page is opened as that window's child, so it shares its
// storage id); the plan library and the recorder are shared by every window.
import * as common from '/pages/src/common.mjs';
import * as store from './store.mjs';
import * as recorder from './recorder.mjs';
import {loadPlanByCode} from './views/plan-loader.mjs';
import {normalisePlan} from './engine/plan.mjs';
import {SETTINGS_DEFAULTS} from './views/runtime.mjs';
import {VERSION} from './version.mjs';

const KEYS = {hud: 'zg-tt-hud', list: 'zg-tt-list', field: 'zg-tt-field', rivals: 'zg-tt-rivals'};
const TITLES = {hud: 'TT HUD settings', list: 'TT interval list settings', field: 'TT field settings', rivals: 'TT rivals settings'};
const UPDATE_CHECK_MS = 24 * 3600 * 1000;
const RELEASES = 'https://github.com/BlueHorizon157/zwiftgopher-s4z-mods/releases';

export async function main() {
    common.initInteractionListeners();
    const q = new URLSearchParams(window.location.search);
    const forWindow = KEYS[q.get('for')] ? q.get('for') : 'hud';
    document.querySelector('#titlebar .title').textContent = TITLES[forWindow];
    document.title = TITLES[forWindow];
    for (const section of document.querySelectorAll('#settings .section[data-for]')) {
        section.hidden = !section.dataset.for.split(' ').includes(forWindow);
    }
    for (const label of document.querySelectorAll('#settings label[data-for]')) {
        label.hidden = !label.dataset.for.split(' ').includes(forWindow);
    }
    const settings = new common.SettingsStore(KEYS[forWindow]);
    settings.setDefault({...SETTINGS_DEFAULTS});
    for (const form of document.querySelectorAll('#settings form.section:not([hidden])')) {
        const update = common.initSettingsForm(form, {store: settings});
        await update();
        // Sauce's binder shows .display-field values once; keep the range read-outs live.
        form.addEventListener('input', ev => {
            const out = form.querySelector(`.display-field[name="${ev.target.name}"]`);
            if (out) {
                out.textContent = ev.target.value;
            }
        });
    }
    store.migrate();
    initPlans();
    initRecorder();
    initVersion();
}

// ---- plans ----

function initPlans() {
    const input = document.getElementById('plan-code');
    const button = document.getElementById('load-plan');
    const message = document.getElementById('plan-message');
    const say = (text, ok = false) => {
        message.textContent = text;
        message.classList.toggle('ok', ok);
    };
    const load = async () => {
        button.disabled = true;
        say('Loading…');
        try {
            const {code, raw} = await loadPlanByCode(input.value);
            say(`Plan ${code} loaded: ${raw.route?.name ?? 'custom route'}.`, true);
            input.value = '';
        } catch (err) {
            say(err.message);
        } finally {
            button.disabled = false;
            renderPlans();
        }
    };
    button.addEventListener('click', load);
    input.addEventListener('keydown', ev => {
        if (ev.key === 'Enter') {
            load();
        }
    });
    document.querySelector('#plan-table tbody').addEventListener('click', ev => {
        const btn = ev.target.closest('button[data-code]');
        if (!btn) {
            return;
        }
        if (btn.dataset.action === 'use') {
            store.setActive(btn.dataset.code);
        } else if (btn.dataset.action === 'remove') {
            store.removePlan(btn.dataset.code);
        }
        renderPlans();
    });
    document.getElementById('strategy-choices').addEventListener('change', ev => {
        if (ev.target.name === 'strategy') {
            store.setActiveCard(ev.target.value || null);
            renderPlans();
        }
    });
    store.onChange(renderPlans);
    renderPlans();
}

function renderPlans() {
    const tbody = document.querySelector('#plan-table tbody');
    const active = store.getActiveCode();
    const plans = store.listPlans();
    renderStrategy(active);
    if (!plans.length) {
        tbody.innerHTML = '<tr class="empty"><td colspan="5">No plans yet. Load one with its code above.</td></tr>';
        return;
    }
    tbody.innerHTML = plans.map(p => `
        <tr class="${p.code === active ? 'active' : ''}">
          <td>${esc(p.code)}</td>
          <td>${esc(p.routeName ?? 'custom route')}</td>
          <td>${esc(p.timeText ?? '—')}</td>
          <td>${esc(expiryWords(p.expiresAt))}</td>
          <td class="actions">
            ${p.code === active ? '' : `<button type="button" class="btn small" data-action="use" data-code="${esc(p.code)}">Use</button>`}
            <button type="button" class="btn small" data-action="remove" data-code="${esc(p.code)}">Remove</button>
          </td>
        </tr>`).join('');
}

/** The active plan's strategy cards (5.2), when the plan file carries their plans. */
function renderStrategy(code) {
    const box = document.getElementById('strategy');
    const plan = normalisePlan(store.getActivePlanRaw(), {code, card: store.getActiveCard()});
    const cards = (plan?.cards ?? []).filter(c => c.switchable);
    const shared = plan?.cards.some(c => c.isShared);
    const choices = cards.map(c => ({key: c.key, value: c.isShared ? '' : c.key, label: c.label, timeText: c.timeText, avgPowerW: c.avgPowerW, minWbalKj: c.minWbalKj, selected: c.selected}));
    if (cards.length && !shared) {
        choices.unshift({key: 'shared', value: '', label: 'As shared', timeText: plan.sharedTimeText, selected: plan.card == null});
    }
    box.hidden = choices.length < 2;
    if (box.hidden) {
        return;
    }
    document.getElementById('strategy-plan').textContent = `${code}, ${plan.routeName ?? 'custom route'}`;
    document.getElementById('strategy-choices').innerHTML = choices.map(c => `
        <label class="choice">
          <input type="radio" name="strategy" value="${esc(c.value)}" data-key="${esc(c.key)}"${c.selected ? ' checked' : ''}>
          <span class="name">${esc(c.label)}</span>
          <span class="tnum">${esc(c.timeText ?? '')}</span>
          <span class="tnum">${Number.isFinite(c.avgPowerW) ? `${Math.round(c.avgPowerW)} W` : ''}</span>
          <span class="tnum">${Number.isFinite(c.minWbalKj) ? `W′ low ${c.minWbalKj.toFixed(1)} kJ` : ''}</span>
        </label>`).join('');
}

function expiryWords(expiresAt) {
    if (!expiresAt) {
        return '—';
    }
    const ms = (typeof expiresAt === 'number' ? expiresAt * (expiresAt < 1e12 ? 1000 : 1) : Date.parse(expiresAt)) - Date.now();
    if (!Number.isFinite(ms)) {
        return '—';
    }
    if (ms <= 0) {
        return 'expired (still usable here)';
    }
    const days = Math.floor(ms / 86400000);
    const hours = Math.floor((ms % 86400000) / 3600000);
    return days > 0 ? `in ${days} day${days === 1 ? '' : 's'}` : `in ${Math.max(1, hours)} h`;
}

// ---- recorder ----

function initRecorder() {
    const checkbox = document.getElementById('record-telemetry');
    const status = document.getElementById('record-status');
    const saveBtn = document.getElementById('record-save');
    const clearBtn = document.getElementById('record-clear');
    checkbox.checked = recorder.isEnabled();
    const refresh = async () => {
        try {
            const s = await recorder.stats();
            checkbox.checked = s.enabled;
            const mb = (s.bytes / (1024 * 1024)).toFixed(1);
            const span = s.lastT != null && s.firstT != null ? formatSpan(s.lastT - s.firstT) : '0:00';
            status.textContent = s.enabled
                ? `Recording: ${s.rows} rows, ${mb} MB, ${span} so far.`
                : s.rows ? `Off. ${s.rows} rows, ${mb} MB, ${span} kept for saving.` : 'Off.';
            saveBtn.disabled = !s.rows;
            clearBtn.disabled = !s.rows;
        } catch (err) {
            status.textContent = `Recorder unavailable: ${err.message}`;
        }
    };
    checkbox.addEventListener('change', async () => {
        await recorder.setEnabled(checkbox.checked);
        refresh();
    });
    saveBtn.addEventListener('click', async () => {
        const text = await recorder.exportJsonl();
        const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 16);
        recorder.saveAs(`zg-tt-telemetry-${stamp}.jsonl`, text);
    });
    clearBtn.addEventListener('click', async () => {
        await recorder.clear();
        refresh();
    });
    refresh();
    setInterval(refresh, 5000);
}

function formatSpan(ms) {
    const total = Math.max(0, Math.round(ms / 1000));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}

// ---- version ----

async function initVersion() {
    document.getElementById('version-current').textContent = `v${VERSION}`;
    const status = document.getElementById('version-status');
    const cached = common.storage?.get('/zg-tt/update-check') || {};
    let latest = cached.latest ?? null;
    if (!cached.at || Date.now() - cached.at > UPDATE_CHECK_MS) {
        try {
            // Every release so far is a pre-release, so releases/latest is a 404: read the newest tag.
            const res = await fetch('https://api.github.com/repos/BlueHorizon157/zwiftgopher-s4z-mods/tags?per_page=1', {headers: {Accept: 'application/vnd.github+json'}});
            if (res.ok) {
                latest = String((await res.json())?.[0]?.name ?? '').replace(/^v/i, '') || null;
                common.storage?.set('/zg-tt/update-check', {at: Date.now(), latest});
            }
        } catch (err) {
            console.warn('[version] check failed', err);
        }
    }
    if (latest && compareVersions(latest, VERSION) > 0) {
        status.textContent = `Update available: v${latest}`;
        status.classList.add('alert');
        status.onclick = () => window.open(RELEASES, '_blank');
    } else {
        status.textContent = latest ? 'up to date' : '';
    }
}

function compareVersions(a, b) {
    const parse = v => {
        const [core, pre = ''] = String(v).split('-');
        return {parts: core.split('.').map(n => parseInt(n, 10) || 0), pre};
    };
    const va = parse(a);
    const vb = parse(b);
    for (let i = 0; i < Math.max(va.parts.length, vb.parts.length); i++) {
        const d = (va.parts[i] ?? 0) - (vb.parts[i] ?? 0);
        if (d !== 0) {
            return d;
        }
    }
    return va.pre && !vb.pre ? -1 : (!va.pre && vb.pre ? 1 : 0);
}

function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));
}
