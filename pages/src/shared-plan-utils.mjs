const HEAVY_PLAN_KEYS = new Set([
    'points',
    'points_full',
    'pointsFull',
    'points3d',
    'samples',
    'sampled_points',
    'track',
    'polyline',
    'route_polyline',
    'routePoints',
    'route_points',
    'segment_points',
    'segmentPoints',
    'gpx',
    'gpx_xml',
    'chart',
    'chartData',
    'chart_data',
    'chartSamples',
    'chart_samples',
    'profile',
    'elevation_profile',
    'elevationProfile',
]);

function isPlainObject(value) {
    if (!value || typeof value !== 'object') {
        return false;
    }
    const proto = Object.getPrototypeOf(value);
    return proto === Object.prototype || proto === null;
}

function cloneWithoutHeavyFields(value) {
    if (Array.isArray(value)) {
        return value.map(cloneWithoutHeavyFields);
    }
    if (isPlainObject(value)) {
        const result = {};
        for (const [key, child] of Object.entries(value)) {
            if (HEAVY_PLAN_KEYS.has(key)) {
                continue;
            }
            result[key] = cloneWithoutHeavyFields(child);
        }
        return result;
    }
    return value;
}

export function createSharedPlanSnapshot(plan) {
    if (!plan || typeof plan !== 'object') {
        return plan ?? null;
    }
    return cloneWithoutHeavyFields(plan);
}

export function withSharedPlanSnapshot(patch) {
    if (!patch || typeof patch !== 'object') {
        return patch;
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'plan')) {
        return {
            ...patch,
            plan: patch.plan ? createSharedPlanSnapshot(patch.plan) : patch.plan,
        };
    }
    return patch;
}
