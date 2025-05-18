import type { CommandModule } from 'yargs';
import { getDefaultDir, saveConfig } from '../utils.js';
import fs from 'node:fs';
import confirm from "@inquirer/confirm";
import { Peerbit } from 'peerbit';
import { Site } from '@riffcc/lens-sdk';
import { GlobalOptions } from '../types.js';
import yargs from 'yargs';

const setupCommand: CommandModule<{}, GlobalOptions> = {
  command: 'setup',
  describe: 'Setup the lens node and generate a new ID.',
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
          console.log(`Setup aborted by user. Existing directory "${directory}" was not modified.`);
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

    const client = await Peerbit.create({
      directory
    })
    
    const siteProgram = new Site(client.identity.publicKey)
    const site = await client.open(siteProgram);

    const configFilePath = saveConfig({ address: site.address.toString() }, directory);

    console.log('\nLens Node setup complete!');
    console.log('--------------------------------------------------');
    console.log(`Node Directory: ${directory}`);
    console.log(`Configuration saved to: ${configFilePath}`);
    console.log(`Peer ID: ${client.peerId.toString()}`);
    console.log(`Node Public Key: ${client.identity.publicKey.toString()}`);
    console.log(`Site Address: ${site.address.toString()}`);
    console.log('--------------------------------------------------');
    console.log("You can now run your node using: lens-node run");
    process.exit(0)
  },
};

export default setupCommand;