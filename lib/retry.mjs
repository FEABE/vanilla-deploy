/**
 * SSH retry policy.
 *
 * Busy or bot-scanned servers make sshd drop new connections before key exchange (MaxStartups). At that
 * stage no remote command has started, so trying again is safe. Any other failure - including a connection
 * that dies while a command is running - is never retried: the command may have run halfway.
 */

const PRE_AUTH = /kex_exchange_identification|ssh_exchange_identification|banner exchange/i;

/** ssh exits 255 on its own errors; only the "dropped before key exchange" family counts. */
export function isPreAuthDrop(code, stderr) {
    return code === 255 && PRE_AUTH.test(String(stderr || ''));
}

/** Exponential backoff with jitter: 0.5s, 1s, 2s, 4s, 8s, 8s, ... plus 0-400ms. */
export function backoffMs(attempt, random = Math.random) {
    return Math.min(8000, 500 * 2 ** (attempt - 1)) + Math.floor(random() * 400);
}

export const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Runs fn(attempt) until it succeeds, fails with a non-retryable error, or `attempts` is reached.
 * shouldRetry(err) decides; onRetry(err, attempt, waitMs) is called before each wait.
 */
export async function withRetry(fn, { attempts = 8, shouldRetry = (e) => !!(e && e.preAuth), sleep = defaultSleep, random = Math.random, onRetry } = {}) {
    for (let i = 1; ; i++) {
        try {
            return await fn(i);
        } catch (e) {
            if (!shouldRetry(e) || i >= attempts) throw e;
            const ms = backoffMs(i, random);
            if (onRetry) onRetry(e, i, ms);
            await sleep(ms);
        }
    }
}
