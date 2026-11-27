// Fake ssh for tests: accepts real ssh arguments, then runs the remote command with a local bash.
//   FAKE_SSH_BASH        bash executable
//   FAKE_SSH_DROPS       file holding a number: while > 0, fail like sshd dropping the connection pre-auth
//   FAKE_SSH_MIDCOMMAND  if set: print some output, then fail like a connection lost mid-command
//   FAKE_SSH_LOG         file: one line per invocation
import fs from 'node:fs';
import { spawn } from 'node:child_process';

const args = process.argv.slice(2);
const remoteCommand = args[args.length - 1];
const dest = args[args.length - 2];
if (args[args.length - 3] !== '--' || !/^[^@\s]+@[^@\s]+$/.test(dest) || args[args.indexOf('-F') + 1] !== 'none') {
    process.stderr.write('fake ssh: unexpected arguments: ' + JSON.stringify(args) + '\n');
    process.exit(2);
}
if (process.env.FAKE_SSH_LOG) fs.appendFileSync(process.env.FAKE_SSH_LOG, 'call\n');

let drop = false;
const dropsFile = process.env.FAKE_SSH_DROPS;
if (dropsFile && fs.existsSync(dropsFile)) {
    const n = Number(fs.readFileSync(dropsFile, 'utf8')) || 0;
    if (n > 0) { fs.writeFileSync(dropsFile, String(n - 1)); drop = true; }
}

function failAfterInput(stdout, stderr) {
    process.stdin.on('data', () => {});
    process.stdin.on('end', () => {
        if (stdout) process.stdout.write(stdout);
        process.stderr.write(stderr);
        process.exit(255);
    });
}

if (drop) {
    failAfterInput('', 'kex_exchange_identification: read: Connection reset by peer\r\nConnection reset by 203.0.113.10 port 22\r\n');
} else if (process.env.FAKE_SSH_MIDCOMMAND) {
    failAfterInput('partial output\n', 'Connection to 203.0.113.10 closed by remote host.\n');
} else {
    const child = spawn(process.env.FAKE_SSH_BASH, ['-c', 'export PATH="/usr/bin:$PATH"; ' + remoteCommand], { stdio: ['pipe', 'inherit', 'inherit'] });
    process.stdin.pipe(child.stdin);
    child.on('close', (code) => process.exit(code === null ? 1 : code));
}
