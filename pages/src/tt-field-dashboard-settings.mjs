import * as common from '/pages/src/common.mjs';

const STORAGE_KEY = 'tt-field-dashboard-settings';

export async function main() {
    common.initInteractionListeners();
    
    const els = {
        showAllRidersCheckbox: document.getElementById('show-all-riders'),
    };

    function loadSettings() {
        const settings = common.storage.get(STORAGE_KEY) || {};
        els.showAllRidersCheckbox.checked = settings.showAllRiders === true;
    }

    function saveSettings() {
        common.storage.set(STORAGE_KEY, {
            showAllRiders: els.showAllRidersCheckbox.checked,
        });
    }

    els.showAllRidersCheckbox.addEventListener('change', saveSettings);

    loadSettings();
}
