// The tar writer: GNU tar (Git Bash on Windows) extracts it byte for byte, long and UTF-8 names included.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { buildTar, paxRecord } from '../lib/tar.mjs';
import { shq } from '../lib/shell.mjs';
import { toBashPath } from '../lib/paths.mjs';
import { tmpDir, runBash, SKIP_NO_BASH } from './helpers.mjs';

test('pax record length counts itself', () => {
    for (const v of ['a', 'x'.repeat(5), 'x'.repeat(89), 'x'.repeat(90), 'x'.repeat(994), 'x'.repeat(995), 'ünï']) {
        const r = paxRecord('path', v);
        assert.equal(Number(r.split(' ')[0]), Buffer.byteLength(r), v.length + ' chars');
    }
});

test('archive layout: 512-byte blocks, valid checksum, end marker', () => {
    const tar = buildTar([{ path: 'a.txt', data: Buffer.from('hello'), mode: 0o644 }], 1700000000);
    assert.equal(tar.length % 512, 0);
    assert.equal(tar.length, 512 + 512 + 1024);
    const h = tar.subarray(0, 512);
    assert.equal(h.subarray(0, 5).toString(), 'a.txt');
    assert.equal(h.subarray(257, 262).toString(), 'ustar');
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 32 : h[i];
    assert.equal(parseInt(h.subarray(148, 154).toString(), 8), sum);
    assert.equal(parseInt(h.subarray(124, 135).toString(), 8), 5);
    assert.ok(tar.subarray(1024).every((b) => b === 0));
});

test('GNU tar extracts every entry exactly (binary, empty, long, UTF-8, odd characters, exec bit)', { skip: SKIP_NO_BASH }, () => {
    const entries = [
        { path: 'plain.txt', data: Buffer.from('plain\n') },
        { path: 'crlf.txt', data: Buffer.from('a\r\nb\r\n') },
        { path: 'empty', data: Buffer.alloc(0) },
        { path: 'bin.dat', data: Buffer.from(Array.from({ length: 2000 }, (_, i) => (i * 7) % 256)) },
        { path: 'exactly512', data: Buffer.alloc(512, 0x41) },
        { path: 'run.sh', data: Buffer.from('#!/bin/sh\necho hi\n'), mode: 0o755 },
        { path: "a b/it's $(x) `y`;&.txt", data: Buffer.from('odd\n') },
        { path: 'ünïcödé/файл.txt', data: Buffer.from('utf8\n') },
        { path: 'd'.repeat(90) + '/' + 'e'.repeat(90) + '/' + 'f'.repeat(50) + '.txt', data: Buffer.from('long\n') }
    ];
    const dir = tmpDir('vd-tar-');
    const tarFile = path.join(tmpDir('vd-tarfile-'), 'x.tar');
    fs.writeFileSync(tarFile, buildTar(entries));
    const r = runBash('cd ' + shq(toBashPath(dir)) + ' && tar --no-same-owner -xf ' + shq(toBashPath(tarFile)));
    assert.equal(r.status, 0, r.stderr);
    for (const e of entries) assert.deepEqual(fs.readFileSync(path.join(dir, ...e.path.split('/'))), e.data, e.path);
    assert.equal(fs.existsSync(path.join(dir, 'PaxHeaders')), false, 'pax headers are not extracted as files');
    if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(dir, 'run.sh')).mode & 0o111, 0o111);
});
