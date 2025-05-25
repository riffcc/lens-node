import inquirer from 'inquirer';
import { select } from '@inquirer/prompts';
import { Libp2pCreateOptions, Peerbit } from 'peerbit';
import type { CommandModule } from 'yargs';
import { GlobalOptions, SiteConfig } from '../types.js';
import { logOperationSuccess, readConfig, saveConfig } from '../utils.js';
import { authorise, Site, DEDICATED_SITE_ARGS, ADMIN_SITE_ARGS } from '@riffcc/lens-sdk';
import { DEFAULT_LISTEN_PORT_LIBP2P } from '../constants.js';
import fs from 'node:fs';
import { dirOption } from './commonOptions.js';


type RunCommandArgs = {
  relay?: boolean;
  domains?: string[];
  listenPort: number;
  onlyReplicate?: boolean;
};

const runCommand: CommandModule<{}, GlobalOptions & RunCommandArgs> = {
  command: 'run',
  describe: 'Starts node daemon.',
  builder: (yargs) =>
    yargs
      .option('dir', dirOption)
      .option('relay', {
        type: 'boolean',
        description: 'Enable relay mode for the node',
        default: false,
      })
      .option('domain', {
        type: 'string',
        description: 'Domain to announce for libp2p configuration',
      })
      .option('listenPort', {
        type: 'number',
        description: 'Port to listen on for libp2p configuration',
        default: DEFAULT_LISTEN_PORT_LIBP2P,
      })
      .option('onlyReplicate', {
        type: 'boolean',
        description: 'Run the node in replicator mode',
      }),
  handler: async (argv) => {
    let siteConfig: SiteConfig | undefined;
    let client: Peerbit | undefined;
    let site: Site | undefined;
    let isShuttingDown = false;

    const shutdown = async (signal: string) => {
      if (isShuttingDown) return;
      isShuttingDown = true;

      console.log(`\nReceived ${signal}. Shutting down gracefully...`);

      try {
        if (site) await site.close();
        if (client) await client.stop();
        console.log('Cleanup finished.');
      } catch (error) {
        console.error('Error during shutdown:', (error as Error).message);
      } finally {
        process.exit(0);
      }
    };

    // Handle termination signals
    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));

    process.on('unhandledRejection', (reason, promise) => {
      console.error('Unhandled Rejection at:', promise, 'reason:', reason);
    });
    process.on('uncaughtException', (error) => {
      console.error('Uncaught Exception:', error);
    });

    try {
      const { dir, onlyReplicate } = argv;
      const siteAddress = process.env.SITE_ADDRESS;
      const bootstrappers = process.env.BOOTSTRAPPERS;

      // Read configuration
      if (siteAddress && onlyReplicate) {
        console.log(`Using bootstrapped site address ${siteAddress}, resetting the config..`);
        fs.rmSync(dir, { recursive: true, force: true });
        fs.mkdirSync(dir, { recursive: true });
        console.log(`Node directory cleared and ready for new configuration at: ${dir}`);
        saveConfig({ address: siteAddress }, dir);
      }

      siteConfig = readConfig(argv.dir);

      // Set up libp2p configuration if domains are provided
      let libp2pConfig: Libp2pCreateOptions | undefined;
      const { domain, listenPort } = argv
      libp2pConfig = {
        addresses: {
          announce: domain ?
            [
              `/dns4/${domain}/tcp/4002`,
              `/dns4/${domain}/tcp/4003/wss`,
            ] :
            undefined,
          listen: [
            `/ip4/127.0.0.1/tcp/${listenPort}`,
            `/ip4/127.0.0.1/tcp/${listenPort !== 0 ? listenPort + 1 : listenPort
            }/ws`,
          ],
        },
      };

      // Initialize Peerbit client
      client = await Peerbit.create({
        directory: dir,
        relay: argv.relay,
        libp2p: libp2pConfig,
      });

      if (bootstrappers) {
        console.log('Dialing bootstrappers...');
        const promises = bootstrappers
          .split(',')
          .map((b) => client?.dial(b.trim()));
        const dialingResult = await Promise.allSettled(promises);
        console.log(`
          ${dialingResult.filter(x => x.status === 'fulfilled').length}/${dialingResult.length}bootstrappers addresses were dialed successfuly.
        `);
      }

      site = await client.open<Site>(
        siteConfig.address,
        {
          args: onlyReplicate ? DEDICATED_SITE_ARGS : ADMIN_SITE_ARGS
        }
      );

      logOperationSuccess({
        startMessage: 'Lens Node is running. Press Ctrl+C to stop OR use the menu below.',
        directory: dir,
        peerId: client.peerId.toString(),
        publicKey: client.identity.publicKey.toString(),
        siteAddress: site.address,
        listeningOn: client.getMultiaddrs().map(m => m.toString()),
      });

      // Menu loop
      if (!onlyReplicate) {
        while (!isShuttingDown) {
          try {
            const answers = await inquirer.prompt(
              [
                {
                  type: 'list',
                  name: 'action',
                  message: 'Actions:',
                  choices: [
                    { name: 'Authorise an account', value: 'authorise' },
                    new inquirer.Separator(),
                    { name: 'Shutdown Node', value: 'shutdown' },
                  ],
                },
              ],
              {
                signal: {
                  addEventListener: (event: string, _listener: (...args: any[]) => void) => {
                    if (event === 'SIGINT') {
                      shutdown('SIGINT');
                    }
                  },
                  removeEventListener: () => { },
                },
              }
            );

            switch (answers.action) {
              case 'authorise':
                const { stringPubkicKey } = await inquirer.prompt([
                  {
                    type: 'input',
                    name: 'stringPubkicKey',
                    message: 'Enter the string public key of the account:',
                  },
                ]);
                const accountType = await select({
                  message: 'Select the account type',
                  choices: [
                    { name: 'Member', value: 1 },
                    { name: 'Admin', value: 2 },
                  ],
                });

                try {
                  await authorise(site, accountType, stringPubkicKey);
                  console.log('Account authorized successfully.');
                } catch (error) {
                  console.error(`Error on authorizing account: ${(error as Error).message}`);
                }
                break;
              case 'shutdown':
                await shutdown('menu_shutdown_request');
                break;
            }
          } catch (error: any) {
            if (isShuttingDown) {
              break;
            }
            if (error.message.includes('User force closed the prompt with SIGINT')) {
              await shutdown('SIGINT');
            } else {
              console.error('Error in menu loop:', error.message || error);
            }
          }
        }
      }

    } catch (error) {
      console.error('Fatal error:', (error as Error).message);
      await shutdown('fatal_error');
    }
  },
};

export default runCommand;