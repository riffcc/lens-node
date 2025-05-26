#!/usr/bin/env node

import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import runCommand from './commands/run.js';
import setupCommand from './commands/setup.js';
import importCommand from './commands/import.js';
import { followCommand } from './commands/follow.js';
import { unfollowCommand } from './commands/unfollow.js';

yargs(hideBin(process.argv))
  .scriptName('lens-node')
  .command(setupCommand)
  .command(runCommand)
  .command(importCommand)
  .command(followCommand)
  .command(unfollowCommand)
  .demandCommand(1, 'A command must be specified.')
  .strict()
  .help()
  .alias('h', 'help')
  .version()
  .alias('v', 'version')
  .fail((
    msg: any,
    err: { message: any; },
    yargsInstance: { showHelp: () => void; }
  ) => {
    if (err) {
      console.error('Error:', err.message);
    } else if (msg) {
      console.error(`Error: ${msg}\n`); // Then print the specific message
    }
    yargsInstance.showHelp(); // Show yargs generated help for context
    process.exit(1);
  })
  .parse();