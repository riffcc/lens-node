import type { CommandModule } from 'yargs';
import { handleDirectorySetup, logOperationSuccess, saveConfig } from '../utils.js';
import { Peerbit } from 'peerbit';
import { ADMIN_SITE_ARGS, Site } from '@riffcc/lens-sdk';
import { GlobalOptions } from '../types.js';
import { dirOption } from './commonOptions.js';
import { writeFileSync } from 'fs';
import { join } from 'path';

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

      // Write .env file with site address and bootstrappers
      const envPath = join(process.cwd(), '.env');
      const peerId = client.peerId.toString();
      const bootstrappers = [
        `/ip4/127.0.0.1/tcp/8002/ws/p2p/${peerId}`,
        '/dns4/4032881a26640025f9a4253104b7aaf6d4b55599.peerchecker.com/tcp/4003/wss/p2p/12D3KooWPYWLY5E7w1SyPJ18y77Wsyfo1fEJcwRonKNPxPam3teJ',
        '/dns4/65da3760cb3fd2926532310b0650ddca4f88ebd5.peerchecker.com/tcp/4003/wss/p2p/12D3KooWMQTwyWnvKyFPjs72bbrDMUDM7pmtF328X7iTfWws3A18'
      ].join(',');
      
      const envContent = `VITE_SITE_ADDRESS=${site.address}\nVITE_BOOTSTRAPPERS=${bootstrappers}\n`;
      writeFileSync(envPath, envContent);
      console.log(`\n.env file written to: ${envPath}`);

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