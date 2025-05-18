import { Libp2pCreateOptions, Peerbit } from 'peerbit';
import type { CommandModule } from 'yargs';
import { GlobalOptions, SiteConfig } from '../types';
import { readConfig } from '../utils.js';
import { Site } from '@riffcc/lens-sdk';

type RunCommandArgs = {
  relay?: boolean;
  domains?: string []
}
const runCommand: CommandModule<{}, GlobalOptions & RunCommandArgs> = {
  command: 'run',
  describe: 'Starts node daemon.',
  handler: async (argv) => {
    let siteConfig: SiteConfig | undefined;
    try {
      siteConfig = readConfig(argv.dir);
    } catch (error) {
      throw error;
    }

    let libp2pConfig: Libp2pCreateOptions | undefined = undefined;
    if (argv.domains) {
      libp2pConfig = {
        addresses: {
          announce: argv.domains
        }
      }
    }
    const client = await Peerbit.create({
      directory: argv.dir,
      relay: argv.relay,
      libp2p: libp2pConfig
    })

    const site = await client.open<Site>(siteConfig.address)

    console.log("Lens Node is running. Press Ctrl+C to stop.");
    console.log("--------------------------------------------------");
    console.log(`Node Directory: ${argv.dir}`);
    console.log(`Peer ID: ${client.peerId.toString()}`);
    console.log(`Node Public Key: ${client.identity.publicKey.toString()}`);
    console.log(`Site Address: ${site.address}`);

    console.log(`Listening on: ${
      JSON.stringify(client.getMultiaddrs(), null, 2)
    }`);
    let isShuttingDown = false;

    const shutdown = async (signal: string) => {
      if (isShuttingDown) return;
      isShuttingDown = true;

      console.log(`\nReceived ${signal}. Shutting down gracefully...`);

      await site.close();
      await client.stop();

      console.log('Cleanup finished.');

      process.exit(0);
    };

    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));

  },
};

export default runCommand;