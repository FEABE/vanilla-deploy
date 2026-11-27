/**
 * Optional Cloudflare cache purge. Off unless the config has a `cloudflare` section AND the token / zone
 * environment variables are set. The token is read from the environment only, is never printed, and is
 * scrubbed from any error text before it reaches the log.
 */

export function cloudflareAuth(cf, env = process.env) {
    if (!cf) return { ok: false, configured: false, why: 'not configured' };
    const token = String(env[cf.tokenEnv] || '').trim();
    const zone = String(env[cf.zoneEnv] || '').trim();
    if (!token) return { ok: false, configured: true, why: cf.tokenEnv + ' is not set' };
    if (!/^[0-9a-f]{32}$/i.test(zone)) return { ok: false, configured: true, why: cf.zoneEnv + ' is not set or is not a 32-character hex zone id' };
    return { ok: true, configured: true, token, zone };
}

export function redact(text, secrets) {
    let s = String(text);
    for (const v of secrets) if (v && v.length >= 4) s = s.split(v).join('***');
    return s;
}

async function post(url, token, body, fetchImpl) {
    const res = await fetchImpl(url, {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15000)
    });
    let j = null;
    try { j = JSON.parse((await res.text()).slice(0, 20000)); } catch { /* not JSON */ }
    if (res.status === 200 && j && j.success) return { ok: true };
    const msg = j && Array.isArray(j.errors) && j.errors.length ? j.errors.map((e) => e.message).join('; ') : 'HTTP ' + res.status;
    return { ok: false, why: msg };
}

/**
 * urls: list of full URLs to purge, or null for "purge everything".
 * Returns { ok, why?, requests } - never throws.
 */
export async function purgeCache(cf, auth, urls, { fetchImpl = globalThis.fetch } = {}) {
    const endpoint = cf.apiBase + '/zones/' + auth.zone + '/purge_cache';
    const bodies = urls === null ? [{ purge_everything: true }] : [];
    if (urls !== null) for (let i = 0; i < urls.length; i += cf.batchSize) bodies.push({ files: urls.slice(i, i + cf.batchSize) });
    let requests = 0;
    for (const body of bodies) {
        try {
            requests++;
            const r = await post(endpoint, auth.token, body, fetchImpl);
            if (!r.ok) return { ok: false, why: redact(r.why, [auth.token]), requests };
        } catch (e) {
            return { ok: false, why: redact(e && e.message, [auth.token]), requests };
        }
    }
    return { ok: true, requests };
}
