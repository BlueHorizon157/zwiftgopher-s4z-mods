// Module hooks for sauce-env.mjs: the mod's pages import Sauce's common.mjs by an absolute URL
// path ('/pages/src/common.mjs'); the tests give them common-stub.mjs.
export async function resolve(specifier, context, next) {
    if (specifier === '/pages/src/common.mjs') {
        return {url: new URL('./common-stub.mjs', import.meta.url).href, shortCircuit: true};
    }
    return next(specifier, context);
}
