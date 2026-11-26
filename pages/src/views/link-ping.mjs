// Does the planner offer linking? The settings page's answer to the ping, in three parts so it can
// tell a planner that does not offer linking from one that could not be reached just now. Pure
// apart from the fetch it is given (test/ui-audit.test.mjs runs it in Node).
import {serverSupportsLink} from './shelf-sync.mjs';

/**
 * 'yes' (the planner answered that it offers linking), 'no' (it answered without linking: an old
 * planner, HTML or a 404 where link.php should be) or 'away' (no answer, a timeout or an error
 * page: try again in a while, nothing is known).
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
