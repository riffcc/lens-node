#!/usr/bin/env node

import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import runCommand from './commands/run.js';
import setupCommand from './commands/setup.js';
import { getDefaultDir } from './utils.js';

yargs(hideBin(process.argv))
  .scriptName('lens-node')
  .option('dir', {
    alias: 'd',
    type: 'string',
    description: 'Directory to storing node data',
    default: getDefaultDir(),
  })
  .command(setupCommand)
  .command(runCommand)
  .demandCommand(1, 'A command must be specified.')
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