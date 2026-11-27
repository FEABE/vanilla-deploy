/**
 * Minimal tar writer (POSIX ustar + pax "path" records), enough for `tar -xf -` on the server.
 *
 * Files are written from git blob bytes (see git.mjs), so what arrives on the server is byte-for-byte the
 * committed blob: no CRLF conversion, no .gitattributes filters, no export-subst. That is exactly what the
 * post-transfer hash check expects (git hash-object --no-filters of the written file == blob id).
 * Owner is uid/gid 0 with empty names; extract with --no-same-owner so the deploy user owns the files.
 */

const BLOCK = 512;
const MAX_SIZE = 8 ** 11 - 1;   // 11 octal digits in the ustar size field (~8 GiB)

function octal(n, width) {
    const s = Math.floor(n).toString(8);
    if (s.length > width - 1) throw new Error('tar: value too large for header field: ' + n);
    return s.padStart(width - 1, '0') + '\0';
}

function header({ name, mode, size, mtime, type }) {
    const h = Buffer.alloc(BLOCK);
    if (Buffer.byteLength(name) > 100) throw new Error('tar: header name longer than 100 bytes');
    h.write(name, 0, 100, 'utf8');
    h.write(octal(mode, 8), 100, 'ascii');
    h.write(octal(0, 8), 108, 'ascii');           // uid
    h.write(octal(0, 8), 116, 'ascii');           // gid
    h.write(octal(size, 12), 124, 'ascii');
    h.write(octal(mtime, 12), 136, 'ascii');
    h.fill(' ', 148, 156);                       // checksum placeholder
    h.write(type, 156, 'ascii');
    h.write('ustar\0', 257, 'ascii');
    h.write('00', 263, 'ascii');
    let sum = 0;
    for (const b of h) sum += b;
    h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 'ascii');
    return h;
}

function padding(len) {
    const rest = len % BLOCK;
    return rest ? Buffer.alloc(BLOCK - rest) : Buffer.alloc(0);
}

/** One pax record: "<len> key=value\n", where <len> counts the whole record including its own digits. */
export function paxRecord(key, value) {
    const body = ' ' + key + '=' + value + '\n';
    const n = Buffer.byteLength(body);
    let total = n + String(n).length;
    if (String(total).length + n !== total) total = String(total).length + n;
    return total + body;
}

const PLAIN_NAME = /^[\x20-\x7e]{1,100}$/;

/**
 * entries: [{ path, data: Buffer, mode: 0o644 | 0o755 }]  ->  Buffer holding a complete tar archive.
 * Parent directories are not emitted; tar creates them when extracting.
 */
export function buildTar(entries, mtime = Math.floor(Date.now() / 1000)) {
    const parts = [];
    for (const e of entries) {
        const size = e.data.length;
        if (size > MAX_SIZE) throw new Error('tar: file too large: ' + e.path);
        let name = e.path;
        if (!PLAIN_NAME.test(name) || Buffer.byteLength(name) > 100) {
            const pax = Buffer.from(paxRecord('path', e.path), 'utf8');
            parts.push(header({ name: 'PaxHeaders/entry', mode: 0o644, size: pax.length, mtime, type: 'x' }), pax, padding(pax.length));
            name = e.path.replace(/[^\x20-\x7e]/g, '_').slice(-100);   // fallback name for readers without pax
        }
        parts.push(header({ name, mode: e.mode || 0o644, size, mtime, type: '0' }), e.data, padding(size));
    }
    parts.push(Buffer.alloc(BLOCK * 2));
    return Buffer.concat(parts);
}
