import type { CommandModule } from 'yargs';
import { getDefaultDir, saveConfig } from '../utils.js';
import fs from 'node:fs';
import confirm from "@inquirer/confirm";
import { Peerbit } from 'peerbit';
import { GlobalOptions } from '../types.js';
import { input } from '@inquirer/prompts';

const importCommand: CommandModule<{}, GlobalOptions> = {
  command: 'import',
  describe: 'Import an existing site ID to become a lens for that site.',
  builder: (yargs) => 
    yargs
      .option('dir', {
        alias: 'd',
        type: 'string',
        description: 'Directory to storing node data',
        default: getDefaultDir(),
      })
    ,
  handler: async (argv) => {
    const directory = argv.dir;

    try {
      if (fs.existsSync(directory)) {
        const overwrite = await confirm({
          message: `The node directory "${directory}" already exists. Do you want to reconfigure? This action is irreversible.`,
          default: false,
        });

        if (overwrite) {
          fs.rmSync(directory, { recursive: true, force: true });
          fs.mkdirSync(directory, { recursive: true });
          console.log(`Node directory cleared and ready for new configuration at: ${directory}`);
        } else {
          console.log(`Import aborted by user. Existing directory "${directory}" was not modified.`);
          process.exit(0);
        }
      } else {
        fs.mkdirSync(directory, { recursive: true });
        console.log(`Node directory created at: ${directory}`);
      }
    } catch (e) {
      console.error(`Error during directory setup at "${directory}": ${(e as Error).message}`);
      process.exit(1);
    }

    const siteAddress = await input({
      message: 'Enter the site address to import:',
      validate: (input) => {
        if (!input || input.trim().length === 0) {
          return 'Site address cannot be empty';
        }
        return true;
      }
    });

    const client = await Peerbit.create({
      directory
    });

    const configFilePath = saveConfig({ address: siteAddress }, directory);

    console.log('\nLens Node import complete!');
    console.log('--------------------------------------------------');
    console.log(`Node Directory: ${directory}`);
    console.log(`Configuration saved to: ${configFilePath}`);
    console.log(`Peer ID: ${client.peerId.toString()}`);
    console.log(`Node Public Key: ${client.identity.publicKey.toString()}`);
    console.log(`Imported Site Address: ${siteAddress}`);
    console.log('--------------------------------------------------');
    console.log("You can now run your node using: lens-node run");
    process.exit(0)
  },
};

export default importCommand; 