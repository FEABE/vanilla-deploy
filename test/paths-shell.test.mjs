// Path validation and shell quoting. The quoting tests run real bash: whatever goes in comes out unchanged
// and nothing gets executed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { checkRelPath, assertRelPath, checkRemoteRoot, checkRemoteDir, remoteJoin, dirsOverlap, ancestors, toBashPath, PathError } from '../lib/paths.mjs';
import { shq, heredoc, HEREDOC_TAG } from '../lib/shell.mjs';
import { globToRegExp, makeMatcher } from '../lib/glob.mjs';
import { BASH, SKIP_NO_BASH, tmpDir, runBash } from './helpers.mjs';

const ACCEPTED = ['a.txt', 'dir/sub/file.js', 'a b.txt', "it's.txt", '"double".txt', '$(touch pwned)', '`id`', 'semi;colon', 'a&b|c', '-rf', '*', '[x]', '#@CUR', 'ünï/файл', 'x'.repeat(300), '.hidden', 'a/.b/c', '~user', ':(glob)*', '%s%n'];
const REJECTED = ['', 'evil\nname', 'cr\rname', 'tab\tname', 'nul\0name', 'del\x7fname', '/abs', '../up', 'a/../b', 'a/./b', './a', 'a//b', 'a/', 'back\\slash', ' lead', 'trail ', 'dir /x', 'x'.repeat(5000)];

test('checkRelPath accepts odd but safe names and rejects what cannot be carried', () => {
    for (const p of ACCEPTED) assert.equal(checkRelPath(p), null, JSON.stringify(p));
    for (const p of REJECTED) assert.notEqual(checkRelPath(p), null, JSON.stringify(p));
    assert.throws(() => assertRelPath('a\nb', 'file'), PathError);
    assert.throws(() => assertRelPath('../x'), /"\.\.\/x" has a "\." or "\.\." segment/);
});

test('remoteRoot / remoteDir rules and remoteJoin stays under the root', () => {
    assert.equal(checkRemoteRoot('/srv/example'), null);
    for (const bad of ['srv', '/', '/srv/', '/srv/../etc', '/srv//x', '/srv/a\nb', 'C:/x', undefined]) assert.notEqual(checkRemoteRoot(bad), null, String(bad));
    assert.equal(checkRemoteDir('apps/site'), null);
    assert.match(checkRemoteDir('.deploy'), /reserved/);
    assert.match(checkRemoteDir('.deploy/state'), /reserved/);
    assert.notEqual(checkRemoteDir('../other'), null);
    assert.notEqual(checkRemoteDir('.'), null);
    assert.equal(remoteJoin('/srv/x', 'a/b'), '/srv/x/a/b');
    assert.throws(() => remoteJoin('/srv/x', '../y'), PathError);
    assert.throws(() => remoteJoin('/srv/x', '/etc'), PathError);
    assert.equal(dirsOverlap('a', 'a/b'), true);
    assert.equal(dirsOverlap('a', 'ab'), false);
    assert.deepEqual(ancestors('a/b/c.txt'), ['a', 'a/b']);
    assert.equal(toBashPath('C:\\Users\\x y\\z'), '/c/Users/x y/z');
    assert.equal(toBashPath('/srv/x'), '/srv/x');
});

test('heredoc refuses lines that would break the framing', () => {
    assert.throws(() => heredoc(['ok', 'evil\nline']), /CR, LF or NUL/);
    assert.throws(() => heredoc(['a\rb']), /CR, LF or NUL/);
    assert.throws(() => heredoc([HEREDOC_TAG]), /delimiter/);
    assert.equal(heredoc([]), "<<'" + HEREDOC_TAG + "'\n" + HEREDOC_TAG + '\n');
    assert.throws(() => shq('a\0b'), /NUL/);
});

test('shq and heredoc round-trip nasty strings through bash without executing anything', { skip: SKIP_NO_BASH }, () => {
    const dir = tmpDir('vd-quote-');
    const nasty = [...ACCEPTED, "'; touch pwned; '", '$HOME', '${IFS}', '\\', "a'b'c", '!!', '$((1+1))', 'with\nnewline (shq only)'];
    for (const s of nasty) {
        const r = runBash('cd ' + shq(toBashPath(dir)) + ' && printf %s ' + shq(s), { encoding: 'utf8' });
        assert.equal(r.status, 0, r.stderr);
        assert.equal(r.stdout, s, 'shq ' + JSON.stringify(s));
    }
    const lines = nasty.filter((s) => !/[\r\n]/.test(s));
    const r = runBash('cd ' + shq(toBashPath(dir)) + ' && while IFS= read -r l; do printf "[%s]\\n" "$l"; done ' + heredoc(lines));
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, lines.map((l) => '[' + l + ']\n').join(''));
    assert.deepEqual(fs.readdirSync(dir), [], 'nothing was executed');
    assert.ok(BASH);
});

test('glob matcher', () => {
    const m = (g, p) => globToRegExp(g).test(p);
    assert.equal(m('**', 'a/b/c'), true);
    assert.equal(m('public/**', 'public/a/b.css'), true);
    assert.equal(m('public/**', 'publicx/a'), false);
    assert.equal(m('public/', 'public/a'), true);
    assert.equal(m('**/*.md', 'README.md'), true);
    assert.equal(m('**/*.md', 'docs/x/y.md'), true);
    assert.equal(m('*.md', 'docs/y.md'), false);
    assert.equal(m('src/*.js', 'src/a.js'), true);
    assert.equal(m('src/*.js', 'src/x/a.js'), false);
    assert.equal(m('a?c', 'abc'), true);
    assert.equal(m('a?c', 'a/c'), false);
    assert.equal(m('[ab].txt', 'b.txt'), true);
    assert.equal(m('[!ab].txt', 'c.txt'), true);
    assert.equal(m('[!ab].txt', 'a.txt'), false);
    assert.equal(m('a.b', 'aXb'), false, 'dots are literal');
    assert.equal(m('(x)+$', '(x)+$'), true, 'regex characters are literal');
    assert.equal(m('**', 'evil\nname'), true, 'newline names are matched, then rejected by validation');
    const keep = makeMatcher(['**'], ['test/**', '**/*.md']);
    assert.deepEqual(['src/a.js', 'test/t.js', 'x/README.md'].filter(keep), ['src/a.js']);
});
