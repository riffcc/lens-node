import inquirer from 'inquirer';
import { select } from '@inquirer/prompts';
import { Libp2pCreateOptions, Peerbit } from 'peerbit';
import type { CommandModule } from 'yargs';
import { GlobalOptions } from '../types.js';
import { logOperationSuccess, readConfig, saveConfig } from '../utils.js';
import {
  DEDICATED_SITE_ARGS, 
  ADMIN_SITE_ARGS,
  LensService,
  SITE_ADDRESS_PROPERTY,
  SUBSCRIPTION_NAME_PROPERTY,
} from '@riffcc/lens-sdk';
import { DEFAULT_LISTEN_PORT_LIBP2P } from '../constants.js';
import fs from 'node:fs';
import { dirOption } from './commonOptions.js';
import { logger, logPeerEvent, logError, logSubscriptionEvent } from '../logger.js';


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
    let client: Peerbit | undefined;
    let lensService: LensService | undefined;
    let isShuttingDown = false;

    const shutdown = async (signal: string) => {
      if (isShuttingDown) return;
      isShuttingDown = true;

      logger.info('Shutdown initiated', { signal });

      try {
        if (lensService) {
          await lensService.stop();
        }
        if (client) {
          await client.stop();
          logger.info('Peerbit client closed succesfully')
        }
        logger.info('Cleanup finished');
      } catch (error) {
        logError('Error during shutdown', error);
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
      let siteAddress = process.env.SITE_ADDRESS;
      const bootstrappers = process.env.BOOTSTRAPPERS;
      
      // Read configuration
      if (siteAddress && onlyReplicate) {
        logger.info(`Using bootstrapped site address ${siteAddress}, resetting the config..`);
        fs.rmSync(dir, { recursive: true, force: true });
        fs.mkdirSync(dir, { recursive: true });
        logger.info(`Node directory cleared and ready for new configuration at: ${dir}`);
        saveConfig({ address: siteAddress }, dir);
      }

      const siteConfig = readConfig(argv.dir);
      siteAddress = siteConfig.address;

      logger.info('Starting Lens Node', {
        directory: dir,
        onlyReplicate,
        siteAddress,
        bootstrappers: bootstrappers?.split(',').map(b => b.trim()),
        nodeVersion: process.version,
        platform: process.platform,
        pid: process.pid,
      });

      // Set up libp2p configuration if domains are provided
      let libp2pConfig: Libp2pCreateOptions | undefined;
      const { domain, listenPort } = argv
      const bindHost = onlyReplicate ? '0.0.0.0' : '127.0.0.1';
      libp2pConfig = {
        addresses: {
          announce: domain ?
            [
              `/dns4/${domain}/tcp/4002`,
              `/dns4/${domain}/tcp/4003/wss`,
            ] :
            undefined,
          listen: [
            `/ip4/${bindHost}/tcp/${listenPort}`,
            `/ip4/${bindHost}/tcp/${listenPort !== 0 ? listenPort + 1 : listenPort
            }/ws`,
          ],
        },
      };

      // Initialize Peerbit client
      logger.info('Initializing Peerbit client', {
        directory: dir,
        relay: argv.relay,
        libp2pConfig: JSON.stringify(libp2pConfig, null, 2),
      });
      
      client = await Peerbit.create({
        directory: dir,
        relay: argv.relay,
        libp2p: libp2pConfig,
      });
      
      logger.info('Peerbit client created successfully');
      
      // Add peer connection event listeners
      client.libp2p.addEventListener('peer:connect', (evt) => {
        logPeerEvent('peer:connect', { peerId: evt.detail.toString() });
      });
      
      client.libp2p.addEventListener('peer:disconnect', (evt) => {
        logPeerEvent('peer:disconnect', { peerId: evt.detail.toString() });
      });

      if (bootstrappers) {
        const bootstrappersList = bootstrappers.split(',').map(b => b.trim());
        logger.info('Dialing bootstrappers', { 
          bootstrappers: bootstrappersList,
          count: bootstrappersList.length,
        });
        
        const promises = bootstrappersList.map((b) => client?.dial(b));
        const dialingResult = await Promise.allSettled(promises);
        
        const successful = dialingResult.filter(x => x.status === 'fulfilled').length;
        const failed = dialingResult.filter(x => x.status === 'rejected');
        
        logger.info('Bootstrapper dialing complete', {
          successful,
          failed: failed.length,
          total: dialingResult.length,
          failures: failed.map((f, i) => ({ 
            bootstrapper: bootstrappersList[i],
            error: (f as PromiseRejectedResult).reason?.message || 'Unknown error',
          })),
        });
      }

      // Initialize LensService
      logger.info('Initializing LensService...');
      lensService = new LensService({ client, debug: Boolean(process.env.DEBUG) });
      
      logger.info(`Opening site with address :${siteConfig.address}`);

      await lensService.openSite(siteConfig.address, {
        siteArgs: onlyReplicate ? DEDICATED_SITE_ARGS : ADMIN_SITE_ARGS,
        federate: true,
      })
      
      logger.info('LensService configured');

      logOperationSuccess({
        startMessage: 'Lens Node is running. Press Ctrl+C to stop OR use the menu below.',
        directory: dir,
        peerId: await lensService.getPeerId(),
        publicKey: await lensService.getPublicKey(),
        siteAddress,
        listeningOn: client.getMultiaddrs().map(m => m.toString()),
      });

      // Start periodic sync status logging
      if (onlyReplicate) {
        logger.info('Running in replication-only mode, starting periodic status logging');
        const statusInterval = setInterval(async () => {
          try {
            const connections = client!.libp2p.getConnections();
            const subscriptions = await lensService!.getSubscriptions();
            
            // Get release counts for each store
            const releaseCount = await lensService!.siteProgram!.releases.index.getSize();
            const featuredCount = await lensService!.siteProgram!.featuredReleases.index.getSize();
            const subscriptionCount = await lensService!.siteProgram!.subscriptions.index.getSize();
            
            logger.info('Replication status', {
              connections: connections.length,
              connectedPeers: connections.map(c => c.remotePeer.toString()),
              subscriptions: subscriptions.length,
              stores: {
                releases: releaseCount,
                featured: featuredCount,
                subscriptions: subscriptionCount,
              },
              uptime: process.uptime(),
              memoryUsage: process.memoryUsage(),
            });
          } catch (error) {
            logError('Error logging replication status', error);
          }
        }, 60000); // Log every minute
        
        // Clear interval on shutdown
        process.on('SIGINT', () => clearInterval(statusInterval));
        process.on('SIGTERM', () => clearInterval(statusInterval));
      } else {
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
                    { name: 'Manage Subscriptions', value: 'subscriptions' },
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
                  logger.info('Authorizing account', {
                    publicKey: stringPubkicKey,
                    accountType: accountType === 1 ? 'Member' : 'Admin',
                  });
                  await lensService.siteProgram!.authorise(accountType, stringPubkicKey);
                  logger.info('Account authorized successfully', {
                    publicKey: stringPubkicKey,
                    accountType: accountType === 1 ? 'Member' : 'Admin',
                  });
                  console.log('Account authorized successfully.');
                } catch (error) {
                  logError('Error authorizing account', error, {
                    publicKey: stringPubkicKey,
                    accountType,
                  });
                }
                break;
              case 'subscriptions':
                await handleSubscriptionMenu(lensService!);
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
              logError('Error in menu loop:', error.message || error);
            }
          }
        }
      }

    } catch (error) {
      logError('Fatal error in run command', error);
      await shutdown('fatal_error');
    }
  },
};

async function handleSubscriptionMenu(lensService: LensService) {
  try {
    const action = await select({
      message: 'Subscription Management:',
      choices: [
        { name: 'View Current Subscriptions', value: 'view' },
        { name: 'Subscribe to a Site', value: 'subscribe' },
        { name: 'Unsubscribe from a Site', value: 'unsubscribe' },
        { name: 'Back to Main Menu', value: 'back' },
      ],
    });

    switch (action) {
      case 'view':
        await viewSubscriptions(lensService);
        break;
      case 'subscribe':
        await subscribeSite(lensService);
        break;
      case 'unsubscribe':
        await unsubscribeSite(lensService);
        break;
      case 'back':
        return;
    }
  } catch (error) {
    console.error('Error in subscription menu:', (error as Error).message);
  }
}

async function viewSubscriptions(lensService: LensService) {
  try {
    logger.info('Fetching current subscriptions');
    const subscriptions = await lensService.getSubscriptions();
    
    logSubscriptionEvent('subscriptions:viewed', {
      count: subscriptions.length,
    });
    
    if (subscriptions.length === 0) {
      logger.info('\nNo subscriptions found.\n');
      return;
    }

    console.log('\nCurrent Subscriptions:');
    console.log('─'.repeat(80));
    
    subscriptions.forEach((sub, index) => {
      logger.info({
        siteAddress: sub[SITE_ADDRESS_PROPERTY],
        name: sub[SUBSCRIPTION_NAME_PROPERTY] ?? 'Unnamed'
      })
    });
  } catch (error) {
    console.error('Error fetching subscriptions:', (error as Error).message);
  }
}

async function subscribeSite(lensService: LensService) {
  try {
    const { siteAddress } = await inquirer.prompt([
      {
        type: 'input',
        name: 'siteAddress',
        message: 'Enter the Site Address to subscribe to:',
        required: true,
        validate: (input) => {
          if (!input.trim()) {
            return 'Site ID cannot be empty';
          }
          return true;
        },
      },
    ]);

    const { name } = await inquirer.prompt([
      {
        type: 'input',
        name: 'name',
        message: 'Enter a name for this subscription (optional):',
        required: false,
      },
    ]);

    const subscriptionData = {
      [SITE_ADDRESS_PROPERTY]: siteAddress.trim(),
      [SUBSCRIPTION_NAME_PROPERTY]: name.trim() || undefined,
    };

    logSubscriptionEvent('subscription:add:start', subscriptionData);
    const result = await lensService.addSubscription(subscriptionData);

    if (result.success) {
      logSubscriptionEvent('subscription:add:success', {
        ...subscriptionData,
        id: result.id,
        hash: result.hash,
      });
    } else {
      logError('Failed to add subscription', new Error(result.error || 'Unknown error'), subscriptionData);
    }
  } catch (error) {
    logError('Error subscribing to site:', (error as Error).message);
  }
}

async function unsubscribeSite(lensService: LensService) {
  try {
    const subscriptions = await lensService.getSubscriptions();
    
    if (subscriptions.length === 0) {
      console.log('\nNo subscriptions to remove.\n');
      return;
    }

    const choices = subscriptions.map((sub, index) => ({
      name: `${sub[SUBSCRIPTION_NAME_PROPERTY] || 'Unnamed'} - ${sub[SITE_ADDRESS_PROPERTY]}`,
      value: sub.id,
    }));

    const { subscriptionId } = await inquirer.prompt([
      {
        type: 'list',
        name: 'subscriptionId',
        message: 'Select a subscription to remove:',
        choices: [
          ...choices,
          new inquirer.Separator(),
          { name: 'Cancel', value: 'cancel' },
        ],
      },
    ]);

    if (subscriptionId === 'cancel') {
      return;
    }

    const { confirm } = await inquirer.prompt([
      {
        type: 'confirm',
        name: 'confirm',
        message: 'Are you sure you want to unsubscribe?',
        default: false,
      },
    ]);

    if (!confirm) {
      console.log('\nUnsubscribe cancelled.\n');
      return;
    }

    const subToDelete = subscriptions.find(s => s.id === subscriptionId);
    logSubscriptionEvent('subscription:delete:start', {
      id: subscriptionId,
      siteAddress: subToDelete?.[SITE_ADDRESS_PROPERTY],
    });
    
    const result = await lensService.deleteSubscription({ id: subscriptionId });

    if (result.success) {
      logSubscriptionEvent('subscription:delete:success', {
        id: subscriptionId,
        siteAddress: subToDelete?.[SITE_ADDRESS_PROPERTY],
      });
      console.log('\n✅ Successfully unsubscribed!\n');
    } else {
      logError('Failed to delete subscription', new Error(result.error || 'Unknown error'), {
        id: subscriptionId,
      });
      console.error(`\n❌ Failed to unsubscribe: ${result.error}\n`);
    }
  } catch (error) {
    console.error('Error unsubscribing:', (error as Error).message);
  }
}

export default runCommand;