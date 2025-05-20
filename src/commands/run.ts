import inquirer from 'inquirer';
import { select } from '@inquirer/prompts';
import { Libp2pCreateOptions, Peerbit } from 'peerbit';
import type { CommandModule } from 'yargs';
import { GlobalOptions, SiteConfig } from '../types';
import { getDefaultDir, readConfig } from '../utils.js';
import { authorise, Site } from '@riffcc/lens-sdk';

type RunCommandArgs = {
  relay?: boolean;
  domains?: string[];
};

const runCommand: CommandModule<{}, GlobalOptions & RunCommandArgs> = {
  command: 'run',
  describe: 'Starts node daemon.',
  builder: (yargs) =>
    yargs
      .option('relay', {
        type: 'boolean',
        description: 'Enable relay mode for the node',
        default: false,
      })
      .option('domains', {
        type: 'array',
        description: 'Domains to announce for libp2p configuration',
        string: true,
      })
      .option('dir', {
        alias: 'd',
        type: 'string',
        description: 'Directory to storing node data',
        default: getDefaultDir(),
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

    // Handle unhandled promise rejections to avoid process hanging
    process.on('unhandledRejection', (reason, promise) => {
      console.error('Unhandled Rejection at:', promise, 'reason:', reason);
      shutdown('unhandled_rejection');
    });

    try {
      // Read configuration
      siteConfig = readConfig(argv.dir);

      // Set up libp2p configuration if domains are provided
      let libp2pConfig: Libp2pCreateOptions | undefined;
      if (argv.domains && argv.domains.length > 0) {
        libp2pConfig = {
          addresses: {
            announce: argv.domains,
          },
        };
      }

      // Initialize Peerbit client
      client = await Peerbit.create({
        directory: argv.dir,
        relay: argv.relay,
        libp2p: libp2pConfig,
      });

      // Open the site
      site = await client.open<Site>(siteConfig.address);

      console.log('Lens Node is running. Press Ctrl+C to stop OR use the menu below.');
      console.log('--------------------------------------------------');
      console.log(`Node Directory: ${argv.dir}`);
      console.log(`Peer ID: ${client.peerId.toString()}`);
      console.log(`Node Public Key: ${client.identity.publicKey.toString()}`);
      console.log(`Site Address: ${site.address}`);
      console.log(`Listening on: ${JSON.stringify(client.getMultiaddrs(), null, 2)}`);
      console.log('--------------------------------------------------\n');

      // Menu loop
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
    } catch (error) {
      console.error('Fatal error:', (error as Error).message);
      await shutdown('fatal_error');
    }
  },
};

export default runCommand;