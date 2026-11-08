// The race time the finish outlook works from (field window, rivals strip).

/** Your time to go: 0 once finished, null when not racing. */
export function remainingOf(v) {
    if (v?.status === 'finished') {
        return 0;
    }
    return v?.race?.running && Number.isFinite(v.race.remainingS) ? v.race.remainingS : null;
}
