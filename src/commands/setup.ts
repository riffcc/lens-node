import type { CommandModule } from 'yargs';
import { handleDirectorySetup, logOperationSuccess, saveConfig } from '../utils.js';
import { Peerbit } from 'peerbit';
import { ADMIN_SITE_ARGS, Site } from '@riffcc/lens-sdk';
import { GlobalOptions } from '../types.js';
import { dirOption } from './commonOptions.js';

const setupCommand: CommandModule<{}, GlobalOptions> = {
  command: 'setup',
  describe: 'Setup the lens node and generate a new ID.',
  builder: (yargs) =>
    yargs
      .option('dir', dirOption)
  ,
  handler: async (argv) => {
    const directory = argv.dir;

    try {
      const proceed = await handleDirectorySetup(directory, 'setup');
      if (!proceed) {
        process.exit(0);
      }

      const client = await Peerbit.create({ directory });
      const siteProgram = new Site(client.identity.publicKey);
      const site = await client.open(siteProgram, { args: ADMIN_SITE_ARGS });
      const configFilePath = saveConfig({ address: site.address }, directory);

      logOperationSuccess({
        startMessage: '\nLens Node setup complete!',
        directory,
        configFilePath,
        peerId: client.peerId.toString(),
        publicKey: client.identity.publicKey.toString(),
        siteAddress: site.address,
        finalMessage: "You can now run your node using: lens-node run"
      });

      await siteProgram.close();
      await client.stop();
      process.exit(0);
    } catch (e) {
      console.error(`Error during setup: ${(e as Error).message}`);
      process.exit(1);
    }
  }
};

export default setupCommand;