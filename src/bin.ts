#!/usr/bin/env node

import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import runCommand from './commands/run.js';
import setupCommand from './commands/setup.js';
import importCommand from './commands/import.js';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const packageJsonPath = path.resolve(__dirname, '../package.json');
const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf-8'));

yargs(hideBin(process.argv))
  .scriptName('lens-node')
  .command(setupCommand)
  .command(runCommand)
  .command(importCommand)
  .demandCommand(1, 'A command must be specified.')
  .strict()
  .help()
  .alias('h', 'help')
  .version(packageJson.version)
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
