import type { CommandModule } from 'yargs';
import { Peerbit } from 'peerbit';
import { CID } from 'multiformats';
import { input } from '@inquirer/prompts';
import { handleDirectorySetup, logOperationSuccess, saveConfig } from '../utils.js';
import type { GlobalOptions } from '../types.js';
import { dirOption } from './commonOptions.js';

const importCommand: CommandModule<{}, GlobalOptions> = {
  command: 'import',
  describe: 'Import an existing site ID to become a lens for that site.',
  builder: (yargs) => 
    yargs.option('dir', dirOption),
  handler: async (argv) => {
    const directory = argv.dir;

    try {
      const proceed = await handleDirectorySetup(directory, 'import');
      if (!proceed) {
        process.exit(0);
      }

      const siteAddress = await input({
        message: 'Enter the site address to import:',
        validate: (value) => {
          
          if (!value || value.trim().length === 0) {
            return 'Site address cannot be empty';
          }
          try {
            CID.parse(value)
          } catch (error) {
            console.log('error');
            return 'Invalid Site address.';
          }
          return true;
        }
      });

      const client = await Peerbit.create({ directory });
      const configFilePath = saveConfig({ address: siteAddress }, directory);

      logOperationSuccess({
        startMessage: 'Lens Node config import complete!',
        directory,
        configFilePath,
        peerId: client.peerId.toString(),
        publicKey: client.identity.publicKey.toString(),
        siteAddress,
        finalMessage: "You can now run your node using: lens-node run"
      });
      await client.stop();
      process.exit(0);
    } catch (e) {
      console.error(`Error during import: ${(e as Error).message}`);
      process.exit(1);
    }
  },
};

export default importCommand;
