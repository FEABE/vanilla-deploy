/**
 * Shell quoting helpers for the remote bash scripts.
 *
 * shq()     single-quotes any string for bash ('it'\''s'). Nothing inside single quotes is expanded.
 * heredoc() feeds lines to a command through a *quoted* heredoc (<<'TAG'), so the body is never expanded
 *           either. A line containing CR/LF/NUL, or equal to the delimiter, would break the framing and is
 *           rejected (file names with those characters never get this far - see paths.mjs).
 */

export const HEREDOC_TAG = '__VANILLA_DEPLOY_EOF__';

export function shq(s) {
    const str = String(s);
    if (str.includes('\0')) throw new Error('cannot quote a string containing NUL');
    return "'" + str.replace(/'/g, "'\\''") + "'";
}

/** Returns "<<'TAG'\n<lines>\nTAG\n" - put it at the end of a command line; the next command starts after it. */
export function heredoc(lines) {
    for (const l of lines) {
        const s = String(l);
        if (/[\r\n\0]/.test(s)) throw new Error('heredoc line contains CR, LF or NUL: ' + JSON.stringify(s));
        if (s === HEREDOC_TAG) throw new Error('heredoc line equals the delimiter');
    }
    return "<<'" + HEREDOC_TAG + "'\n" + lines.map(String).map((l) => l + '\n').join('') + HEREDOC_TAG + '\n';
}
