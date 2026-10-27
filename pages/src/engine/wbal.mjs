// The planner's W'bal kernel (inc/wprimebalance.class.php, WPrimeBalance::update with the
// TT planner's recovery cap, TT::RECOVERY_CAP = 1.0), so the live W'bal spends and refills
// exactly as the plan's wbal_kj figures were computed (decision 3, 2026-10-27).
//
// Depletion above CP is (P - CP) * dt. Below CP the deficit refills on the Bartram 2018
// time constant tau = 2287.2 * DCP^-0.688 divided by the calibrated gain, with the refill
// rate capped at recoveryCap * DCP J/s (energy balance: no faster than the power held
// back). A step of any length equals the same time in shorter steps, so one step per
// interval reproduces the planner's per-point integration.

export const DEFAULT_RECOVERY_GAIN = 1.75;
export const RECOVERY_CAP = 1.0;
export const TOLERANCE_W = 0.5;

const LEVEL_RECOVERY = {
    untrained: 0.90,
    recreational: 0.95,
    trained: 1.00,
    competitive: 1.00,
    elite: 1.05,
    pro: 1.10,
};

export function levelRecovery(level) {
    return LEVEL_RECOVERY[String(level ?? '').toLowerCase()] ?? LEVEL_RECOVERY.competitive;
}

/**
 * One constant-power step. Returns the new W'bal in joules, capped at wPrime (it may go
 * below zero: exhaustion).
 */
export function update(current, power, cp, duration, wPrime, {level = 'competitive', recoveryCap = RECOVERY_CAP, gain = DEFAULT_RECOVERY_GAIN} = {}) {
    if (!(duration > 0)) {
        return Math.min(wPrime, current);
    }
    if (power > cp + TOLERANCE_W) {
        return Math.min(wPrime, current - (power - cp) * duration);
    }
    if (power < cp - TOLERANCE_W) {
        const dcp = Math.max(0, cp - power);
        const g = Math.max(0.05, gain * levelRecovery(level));
        const deficit = Math.max(0, wPrime - current);
        const tau = (2287.2 * Math.pow(Math.max(1, dcp), -0.688)) / g;
        const next = recoveryCap != null
            ? recoverCapped(wPrime, deficit, tau, recoveryCap * dcp, duration)
            : wPrime - deficit * Math.exp(-duration / tau);
        return Math.min(wPrime, next);
    }
    return Math.min(wPrime, current);
}

/** Exponential recovery whose rate may not exceed rateCap J/s (WPrimeBalance::recoverCapped). */
export function recoverCapped(wPrime, deficit, tau, rateCap, duration) {
    const knee = rateCap * tau;
    if (rateCap > 0 && deficit > knee) {
        const linear = (deficit - knee) / rateCap;
        if (duration <= linear) {
            return wPrime - deficit + rateCap * duration;
        }
        return wPrime - knee * Math.exp(-(duration - linear) / tau);
    }
    return wPrime - deficit * Math.exp(-duration / tau);
}

/** W'bal after riding a plan's intervals exactly, one value per interval end, in joules. */
export function traceAlongPlan(intervals, cp, wPrime, options = {}) {
    let w = wPrime;
    return intervals.map(iv => {
        w = update(w, iv.powerW, cp, iv.durationS, wPrime, options);
        return w;
    });
}
