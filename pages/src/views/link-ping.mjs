// Whether the planner offers linking, for the settings page. Pure apart from the fetch it is given.
import {serverSupportsLink} from './shelf-sync.mjs';

/**
 * 'yes' (the planner says it offers linking), 'no' (it answered without linking: an old planner,
 * HTML or a 404 where link.php should be) or 'away' (no answer, timeout or error page: unknown).
 */
export async function plannerLinkSupport(fetchFn) {
    let status = 0;
    const seen = async (...args) => {
        const resp = await fetchFn(...args);
        status = resp.status;
        return resp;
    };
    if (await serverSupportsLink(seen)) {
        return 'yes';
    }
    return status === 200 || status === 404 || status === 410 ? 'no' : 'away';
}
