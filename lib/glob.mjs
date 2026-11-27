/**
 * Small glob matcher for include / exclude lists. Patterns match the whole repo-relative path:
 *   *      any characters except "/"
 *   ?      one character except "/"
 *   **     any characters including "/" ("**\/" also matches zero directories)
 *   [abc]  character class ([!abc] negates)
 *   dir/   a trailing slash means everything below dir ("dir/**")
 * Examples: "**" (everything), "public/**", "**\/*.md", "src/*.js".
 */

const SPECIAL = /[.+^${}()|\\\]]/g;

export function globToRegExp(glob) {
    let g = String(glob);
    if (g.endsWith('/')) g += '**';
    let re = '^';
    for (let i = 0; i < g.length; i++) {
        const c = g[i];
        if (c === '*') {
            if (g[i + 1] === '*') {
                const atStart = i === 0 || g[i - 1] === '/';
                if (atStart && g[i + 2] === '/') { re += '(?:.*/)?'; i += 2; continue; }
                re += '.*'; i += 1; continue;
            }
            re += '[^/]*';
        } else if (c === '?') {
            re += '[^/]';
        } else if (c === '[') {
            const end = g.indexOf(']', i + 2);
            if (end < 0) { re += '\\['; continue; }
            let cls = g.slice(i + 1, end).replace(/\\/g, '\\\\').replace(/\[/g, '\\[');
            const neg = cls.startsWith('!');
            if (neg) cls = cls.slice(1);
            re += neg ? '[^/' + cls + ']' : '[' + cls + ']';
            i = end;
        } else {
            re += c.replace(SPECIAL, '\\$&');
        }
    }
    return new RegExp(re + '$', 'su');   // s: "*" and "**" also match newlines, so odd names are never silently skipped
}

/** (path) => boolean: included by at least one include pattern and by no exclude pattern. */
export function makeMatcher(include = ['**'], exclude = []) {
    const inc = include.map(globToRegExp);
    const exc = exclude.map(globToRegExp);
    return (p) => inc.some((r) => r.test(p)) && !exc.some((r) => r.test(p));
}
