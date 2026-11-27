#!/usr/bin/env node
// vanilla-deploy - see README.md. All logic lives in lib/; this file only wires up the process.
import { main } from '../lib/cli.mjs';

main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (e) => {
    process.stderr.write('error: ' + (e && e.stack ? e.stack : String(e)) + '\n');
    process.exitCode = 1;
});
