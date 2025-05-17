#!/usr/bin/env node

import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import runCommand from './commands/run';

yargs(hideBin(process.argv))
  .scriptName('lens-node')
  .command(runCommand)
  .demandCommand(1, 'You need to specify a command.')
  .strict()
  .help()
  .alias('h', 'help')
  .version()
  .alias('v', 'version')
  .fail((msg, err, yargsInstance) => {
    if (err) {
      console.error('Error:', err.message);
    } else if (msg) {
      console.error('Error:', msg);
    }
    console.error('\nFor help, run: lens-node --help');
    process.exit(1);
  })
  .parse();