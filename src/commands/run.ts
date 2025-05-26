import inquirer from 'inquirer';
import { select } from '@inquirer/prompts';
import { Libp2pCreateOptions, Peerbit } from 'peerbit';
import type { CommandModule } from 'yargs';
import { GlobalOptions, SiteConfig } from '../types.js';
import { logOperationSuccess, readConfig, saveConfig } from '../utils.js';
import { 
  authorise, 
  Site, 
  DEDICATED_SITE_ARGS, 
  ADMIN_SITE_ARGS,
  LensService,
  SUBSCRIPTION_SITE_ID_PROPERTY,
  SUBSCRIPTION_NAME_PROPERTY,
  SUBSCRIPTION_RECURSIVE_PROPERTY,
  ID_PROPERTY,
} from '@riffcc/lens-sdk';
import { SearchRequest } from '@peerbit/document';
import { DEFAULT_LISTEN_PORT_LIBP2P } from '../constants.js';
import fs from 'node:fs';
import { dirOption } from './commonOptions.js';
import { logger, logSubscriptionEvent, logSyncEvent, logPeerEvent, logError } from '../logger.js';


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
    let lensService: LensService | undefined;
    let isShuttingDown = false;

    const shutdown = async (signal: string) => {
      if (isShuttingDown) return;
      isShuttingDown = true;

      logger.info('Shutdown initiated', { signal });
      console.log(`\nReceived ${signal}. Shutting down gracefully...`);

      try {
        if (site) {
          logger.info('Closing site');
          await site.close();
          logger.info('Site closed successfully');
        }
        if (client) {
          logger.info('Stopping Peerbit client');
          await client.stop();
          logger.info('Peerbit client stopped successfully');
        }
        logger.info('Cleanup finished successfully');
        console.log('Cleanup finished.');
      } catch (error) {
        logError('Error during shutdown', error);
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
      
      logger.info('Starting Lens Node', {
        directory: dir,
        onlyReplicate,
        siteAddress,
        bootstrappers: bootstrappers?.split(',').map(b => b.trim()),
        nodeVersion: process.version,
        platform: process.platform,
        pid: process.pid,
      });

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
      const bindHost = onlyReplicate ? '0.0.0.0' : '127.0.0.1';
      
      // Parse bootstrap peers for enhanced DHT operations
      const bootstrapPeers = bootstrappers 
        ? bootstrappers.split(',').map(b => b.trim()).filter(b => b.length > 0)
        : [];
      
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
        availableBootstrapPeers: bootstrapPeers.length,
        libp2pConfig: JSON.stringify(libp2pConfig, null, 2),
      });
      
      if (bootstrapPeers.length > 0) {
        console.log(`🔍 Enhanced DHT operations available with ${bootstrapPeers.length} bootstrap peers for content routing`);
      }
      
      client = await Peerbit.create({
        directory: dir,
        relay: argv.relay,
        libp2p: libp2pConfig,
      });
      
      logger.info('Peerbit client created successfully', {
        peerId: client.peerId.toString(),
        multiaddrs: client.getMultiaddrs().map(m => m.toString()),
      });
      
      // Add peer connection event listeners
      client.libp2p.addEventListener('peer:connect', (evt) => {
        logPeerEvent('peer:connect', { peerId: evt.detail.toString() });
      });
      
      client.libp2p.addEventListener('peer:disconnect', (evt) => {
        logPeerEvent('peer:disconnect', { peerId: evt.detail.toString() });
      });
      
      // Add stream debugging for PeerBit routing
      try {
        client.libp2p.addEventListener('connection:open', (evt) => {
          logger.debug('Connection opened', {
            remotePeer: evt.detail.remotePeer.toString(),
            direction: evt.detail.direction,
          });
        });
        
        client.libp2p.addEventListener('connection:close', (evt) => {
          logger.debug('Connection closed', {
            remotePeer: evt.detail.remotePeer.toString(),
          });
        });
      } catch (error) {
        logger.debug('Stream event listeners not available in this libp2p version');
      }

      if (bootstrappers) {
        const bootstrappersList = bootstrappers.split(',').map(b => b.trim());
        logger.info('Dialing bootstrappers', { 
          bootstrappers: bootstrappersList,
          count: bootstrappersList.length,
        });
        console.log('Dialing bootstrappers...');
        
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
        console.log(`
          ${successful}/${dialingResult.length}bootstrappers addresses were dialed successfuly.
        `);
      }

      // Initialize LensService
      logger.info('Initializing LensService');
      lensService = new LensService(client);
      
      // Add peer connection listeners
      client.libp2p.addEventListener('peer:connect', (evt) => {
        logPeerEvent('peer:connect', {
          peerId: evt.detail.toString(),
          connections: client!.libp2p.getConnections().length,
        });
      });
      
      client.libp2p.addEventListener('peer:disconnect', (evt) => {
        logPeerEvent('peer:disconnect', {
          peerId: evt.detail.toString(),
          remainingConnections: client!.libp2p.getConnections().length,
        });
      });
      
      logger.info('Opening site', {
        address: siteConfig.address,
        mode: onlyReplicate ? 'dedicated/replicate' : 'admin',
        args: onlyReplicate ? DEDICATED_SITE_ARGS : ADMIN_SITE_ARGS,
      });
      
      const siteOpenStart = Date.now();
      site = await client.open<Site>(
        siteConfig.address,
        {
          args: onlyReplicate ? DEDICATED_SITE_ARGS : ADMIN_SITE_ARGS
        }
      );
      
      const siteOpenDuration = Date.now() - siteOpenStart;
      logger.info('Site opened successfully', {
        address: site.address,
        duration: siteOpenDuration,
        durationSeconds: (siteOpenDuration / 1000).toFixed(2),
      });
      
      // Log site stores information
      logger.info('Site stores initialized', {
        releases: {
          address: site.releases.address,
        },
        featuredReleases: {
          address: site.featuredReleases.address,
        },
        subscriptions: {
          address: site.subscriptions.address,
        },
      });
      
      // Set the opened site in LensService
      lensService.siteProgram = site;
      
      // Advertise content in DHT for content routing
      try {
        logger.info('Advertising site content in DHT', {
          siteAddress: site.address,
        });
        
        // Advertise the main site
        if (client.libp2p.contentRouting && client.libp2p.contentRouting.provide) {
          // Convert site address to CID for DHT advertisement
          const { CID } = await import('multiformats/cid');
          const siteCID = CID.parse(site.address);
          await client.libp2p.contentRouting.provide(siteCID);
          
          // Also advertise individual stores
          const releasesCID = CID.parse(site.releases.address);
          const featuredCID = CID.parse(site.featuredReleases.address);
          const subscriptionsCID = CID.parse(site.subscriptions.address);
          
          await Promise.all([
            client.libp2p.contentRouting.provide(releasesCID),
            client.libp2p.contentRouting.provide(featuredCID),
            client.libp2p.contentRouting.provide(subscriptionsCID),
          ]);
          
          logger.info('Successfully advertised content in DHT', {
            siteAddress: site.address,
            stores: {
              releases: site.releases.address,
              featured: site.featuredReleases.address,
              subscriptions: site.subscriptions.address,
            },
          });
        } else {
          logger.warn('Content routing not available, DHT advertisement skipped');
        }
      } catch (error) {
        logError('Failed to advertise content in DHT', error, {
          siteAddress: site.address,
        });
      }
      
      // Set up comprehensive sync monitoring
      setupSyncMonitoring(site, lensService);
      logger.info('LensService configured with site program');
      
      // Monitor when new releases are added
      
      // Monitor when new releases are added
      site!.releases.events.addEventListener('change', (evt) => {
        logSyncEvent('releases:change', {
          added: evt.detail.added?.length || 0,
          removed: evt.detail.removed?.length || 0,
          addedIds: evt.detail.added?.map((doc: any) => doc[ID_PROPERTY]),
          removedIds: evt.detail.removed?.map((doc: any) => doc[ID_PROPERTY]),
        });
      });
      
      // Monitor subscription changes
      site.subscriptions.events.addEventListener('change', (evt) => {
        logSubscriptionEvent('subscription:change', {
          added: evt.detail.added?.length || 0,
          removed: evt.detail.removed?.length || 0,
          addedSites: evt.detail.added?.map((sub: any) => sub[SUBSCRIPTION_SITE_ID_PROPERTY]),
          removedSites: evt.detail.removed?.map((sub: any) => sub[SUBSCRIPTION_SITE_ID_PROPERTY]),
        });
      });
      
      // Monitor featured releases changes
      site.featuredReleases.events.addEventListener('change', (evt) => {
        logSyncEvent('featuredReleases:change', {
          added: evt.detail.added?.length || 0,
          removed: evt.detail.removed?.length || 0,
        });
      });
      
      // Monitor replication for all stores
      const stores = ['releases', 'featuredReleases', 'subscriptions'];
      stores.forEach(storeName => {
        const store = site![storeName as keyof Site] as any;
        if (store?.events) {
          store.events.addEventListener('peer:replicating', (evt: any) => {
            logSyncEvent(`${storeName}:peer:replicating`, {
              remotePeer: evt.detail.remotePeer?.toString(),
              direction: evt.detail.direction,
            });
          });
          
          store.events.addEventListener('replicate', (evt: any) => {
            logSyncEvent(`${storeName}:replicate`, {
              heads: evt.detail.heads?.length || 0,
              amount: evt.detail.amount,
            });
          });
        }
      });
      
      // Log initial subscription state
      try {
        const initialSubs = await lensService.getSubscriptions();
        logger.info('Initial subscriptions loaded', {
          count: initialSubs.length,
          subscriptions: initialSubs.map(sub => ({
            siteId: sub[SUBSCRIPTION_SITE_ID_PROPERTY],
            name: sub[SUBSCRIPTION_NAME_PROPERTY],
            recursive: sub[SUBSCRIPTION_RECURSIVE_PROPERTY],
          })),
        });
      } catch (error) {
        logError('Failed to load initial subscriptions', error);
      }
      
      // Log initial store sizes
      try {
        const releaseCount = (await site.releases.index.search(new SearchRequest({}))).length;
        const featuredCount = (await site.featuredReleases.index.search(new SearchRequest({}))).length;
        const subscriptionCount = (await site.subscriptions.index.search(new SearchRequest({}))).length;
        
        logger.info('Initial store sizes', {
          releases: releaseCount,
          featuredReleases: featuredCount,
          subscriptions: subscriptionCount,
        });
      } catch (error) {
        logError('Failed to get initial store sizes', error);
      }

      logOperationSuccess({
        startMessage: 'Lens Node is running. Press Ctrl+C to stop OR use the menu below.',
        directory: dir,
        peerId: client.peerId.toString(),
        publicKey: client.identity.publicKey.toString(),
        siteAddress: site.address,
        listeningOn: client.getMultiaddrs().map(m => m.toString()),
      });
      
      logger.info('Lens Node fully initialized', {
        mode: onlyReplicate ? 'replication-only' : 'admin',
        siteAddress: site.address,
        peerId: client.peerId.toString(),
        connections: client.libp2p.getConnections().length,
      });

      // Start periodic sync status logging
      if (onlyReplicate) {
        logger.info('Running in replication-only mode, starting periodic status logging');
        const statusInterval = setInterval(async () => {
          try {
            const connections = client!.libp2p.getConnections();
            const subscriptions = await lensService!.getSubscriptions();
            
            // Get release counts for each store
            const releaseCount = (await site!.releases.index.search(new SearchRequest({}))).length;
            const featuredCount = (await site!.featuredReleases.index.search(new SearchRequest({}))).length;
            const subscriptionCount = (await site!.subscriptions.index.search(new SearchRequest({}))).length;
            
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
            
            // Check sync status for each subscription
            for (const sub of subscriptions) {
              const siteId = sub[SUBSCRIPTION_SITE_ID_PROPERTY];
              try {
                logger.debug('Checking subscription sync status', {
                  siteId,
                  name: sub[SUBSCRIPTION_NAME_PROPERTY],
                });
              } catch (subError) {
                logError('Error checking subscription status', subError, { siteId });
              }
            }
          } catch (error) {
            logError('Error logging replication status', error);
          }
        }, 60000); // Log every minute
        
        // Clear interval on shutdown
        process.on('SIGINT', () => clearInterval(statusInterval));
        process.on('SIGTERM', () => clearInterval(statusInterval));
      }
      
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
                  await authorise(site, accountType, stringPubkicKey);
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
                  console.error(`Error on authorizing account: ${(error as Error).message}`);
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
              console.error('Error in menu loop:', error.message || error);
            }
          }
        }
      }

    } catch (error) {
      logError('Fatal error in run command', error);
      console.error('Fatal error:', (error as Error).message);
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
      console.log('\nNo subscriptions found.\n');
      return;
    }

    console.log('\nCurrent Subscriptions:');
    console.log('─'.repeat(80));
    
    subscriptions.forEach((sub, index) => {
      console.log(`${index + 1}. Site ID: ${sub[SUBSCRIPTION_SITE_ID_PROPERTY]}`);
      if (sub[SUBSCRIPTION_NAME_PROPERTY]) {
        console.log(`   Name: ${sub[SUBSCRIPTION_NAME_PROPERTY]}`);
      }
      console.log(`   Recursive: ${sub[SUBSCRIPTION_RECURSIVE_PROPERTY] ? 'Yes' : 'No'}`);
      console.log(`   Type: ${sub.subscriptionType || 'direct'}`);
      console.log('─'.repeat(80));
    });
    
    console.log('');
  } catch (error) {
    console.error('Error fetching subscriptions:', (error as Error).message);
  }
}

async function subscribeSite(lensService: LensService) {
  try {
    const { siteId } = await inquirer.prompt([
      {
        type: 'input',
        name: 'siteId',
        message: 'Enter the Site ID to subscribe to:',
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
      },
    ]);

    const { recursive } = await inquirer.prompt([
      {
        type: 'confirm',
        name: 'recursive',
        message: 'Enable recursive subscription (follow sites that this site follows)?',
        default: false,
      },
    ]);

    const subscriptionData = {
      [SUBSCRIPTION_SITE_ID_PROPERTY]: siteId.trim(),
      [SUBSCRIPTION_NAME_PROPERTY]: name.trim() || undefined,
      [SUBSCRIPTION_RECURSIVE_PROPERTY]: recursive,
      subscriptionType: 'direct',
      currentDepth: 0,
      followChain: [],
    };

    logSubscriptionEvent('subscription:add:start', subscriptionData);
    const result = await lensService.addSubscription(subscriptionData);

    if (result.success) {
      logSubscriptionEvent('subscription:add:success', {
        ...subscriptionData,
        id: result.id,
        hash: result.hash,
      });
      console.log('\n✅ Successfully subscribed to site!');
      console.log(`   Subscription ID: ${result.id}`);
      console.log(`   Hash: ${result.hash}\n`);
      
      // Trigger immediate sync check
      logger.info('Triggering sync check for new subscription', {
        siteId: subscriptionData[SUBSCRIPTION_SITE_ID_PROPERTY],
      });
      
      // Attempt to open the subscribed site to trigger sync
      try {
        logger.info('Attempting to open subscribed site for sync', {
          siteId: subscriptionData[SUBSCRIPTION_SITE_ID_PROPERTY],
        });
        const subscribedSite = await lensService!.client!.open<Site>(
          subscriptionData[SUBSCRIPTION_SITE_ID_PROPERTY],
          {
            args: DEDICATED_SITE_ARGS,
          }
        );
        
        logger.info('Subscribed site opened, checking releases', {
          siteId: subscriptionData[SUBSCRIPTION_SITE_ID_PROPERTY],
          address: subscribedSite.address,
        });
        
        // Check how many releases exist in the subscribed site
        const releaseCount = (await subscribedSite.releases.index.search(new SearchRequest({}))).length;
        logger.info('Subscribed site release count', {
          siteId: subscriptionData[SUBSCRIPTION_SITE_ID_PROPERTY],
          releaseCount,
        });
        
        // Close the subscribed site as we only needed to trigger sync
        await subscribedSite.close();
        logger.info('Closed subscribed site after sync check', {
          siteId: subscriptionData[SUBSCRIPTION_SITE_ID_PROPERTY],
        });
      } catch (syncError) {
        logError('Failed to open subscribed site for sync', syncError, {
          siteId: subscriptionData[SUBSCRIPTION_SITE_ID_PROPERTY],
        });
      }
    } else {
      logError('Failed to add subscription', new Error(result.error || 'Unknown error'), subscriptionData);
      console.error(`\n❌ Failed to subscribe: ${result.error}\n`);
    }
  } catch (error) {
    console.error('Error subscribing to site:', (error as Error).message);
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
      name: `${sub[SUBSCRIPTION_NAME_PROPERTY] || 'Unnamed'} - ${sub[SUBSCRIPTION_SITE_ID_PROPERTY]}`,
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
      siteId: subToDelete?.[SUBSCRIPTION_SITE_ID_PROPERTY],
    });
    
    const result = await lensService.deleteSubscription({ id: subscriptionId });

    if (result.success) {
      logSubscriptionEvent('subscription:delete:success', {
        id: subscriptionId,
        siteId: subToDelete?.[SUBSCRIPTION_SITE_ID_PROPERTY],
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

// Set up comprehensive monitoring for sync events
function setupSyncMonitoring(site: Site, lensService: LensService) {
  logger.info('Setting up sync monitoring');
  
  // Get reference to the client for peer information
  const client = lensService.client;
  
  // Monitor releases store events
  site.releases.events.addEventListener('change', (evt: any) => {
    logSyncEvent('releases:change', {
      operation: evt.detail?.operation,
      entries: evt.detail?.entries?.length || 0,
    });
  });
  
  // Monitor releases store sync events
  // Note: Specific replication events may not be available in current version
  
  // Monitor featured releases store events
  site.featuredReleases.events.addEventListener('change', (evt: any) => {
    logSyncEvent('featuredReleases:change', {
      operation: evt.detail?.operation,
      entries: evt.detail?.entries?.length || 0,
    });
  });
  
  // Monitor featured releases store sync events
  // Note: Specific replication events may not be available in current version
  
  // Monitor subscriptions store events
  site.subscriptions.events.addEventListener('change', (evt: any) => {
    logSyncEvent('subscriptions:change', {
      operation: evt.detail?.operation,
      entries: evt.detail?.entries?.length || 0,
    });
  });
  
  // Periodic subscription sync status logging
  let lastSubscriptionCheck = Date.now();
  setInterval(async () => {
    try {
      const subscriptions = await lensService.getSubscriptions();
      const currentTime = Date.now();
      const timeSinceLastCheck = currentTime - lastSubscriptionCheck;
      const connections = client!.libp2p.getConnections();
      const peers = client!.libp2p.getPeers();
      
      logger.info('Subscription sync status check', {
        subscriptionCount: subscriptions.length,
        timeSinceLastCheck: timeSinceLastCheck,
        connectionCount: connections.length,
        peerCount: peers.length,
        connectedPeers: connections.map((conn: any) => ({
          peerId: conn.remotePeer.toString(),
          status: conn.status,
          multiaddr: conn.remoteAddr.toString(),
        })),
        subscriptions: subscriptions.map(sub => ({
          siteId: sub[SUBSCRIPTION_SITE_ID_PROPERTY],
          name: sub[SUBSCRIPTION_NAME_PROPERTY],
          recursive: sub[SUBSCRIPTION_RECURSIVE_PROPERTY],
          type: sub.subscriptionType,
        })),
      });
      
      // If no connections, try to diagnose why
      if (connections.length === 0) {
        logger.warn('No peer connections detected', {
          multiaddrs: client!.getMultiaddrs().map(addr => addr.toString()),
          peerId: client!.peerId.toString(),
        });
        
        // Try to discover and connect to peers advertising the subscribed sites
        for (const subscription of subscriptions) {
          const siteId = subscription[SUBSCRIPTION_SITE_ID_PROPERTY];
          logger.info('Attempting to find peers for subscribed site', { siteId });
          
          try {
            // Try multiple discovery methods
            
            // Method 1: Direct dial attempt
            try {
              await client!.dial(`/p2p/${siteId}`);
              logger.info('Successfully dialed site directly', { siteId });
            } catch (directDialError) {
              logger.debug('Direct dial failed, trying peer discovery', { 
                siteId, 
                error: directDialError instanceof Error ? directDialError.message : directDialError 
              });
              
              // Method 2: Use Peerbit's peer discovery
              try {
                // Check if any connected peers have opened this site
                const connectedPeers = client!.libp2p.getPeers();
                logger.info('Checking connected peers for site content', {
                  siteId,
                  connectedPeerCount: connectedPeers.length,
                  connectedPeers: connectedPeers.map(p => p.toString())
                });
                
                // Try to query each peer about the site
                for (const peerId of connectedPeers) {
                  logger.debug('Checking peer for site content', {
                    siteId,
                    peerId: peerId.toString()
                  });
                }
                
              } catch (peerCheckError) {
                logger.debug('Failed to check peers for site content', {
                  siteId,
                  error: peerCheckError instanceof Error ? peerCheckError.message : peerCheckError
                });
              }
            }
            
          } catch (error) {
            logger.error('Peer discovery failed for site', {
              siteId,
              error: error instanceof Error ? error.message : error
            });
          }
        }
      }
      
      // Check if we should be syncing from any subscribed sites
      for (const subscription of subscriptions) {
        const siteId = subscription[SUBSCRIPTION_SITE_ID_PROPERTY];
        logger.info('Checking subscription sync for site', {
          siteId,
          subscriptionId: subscription.id,
          expectedReleases: 35,
          currentReleases: (await site.releases.index.search(new SearchRequest({}))).length,
        });
        
        // Try to actively sync from known peers using DHT queries
        try {
          // Parse bootstrap peers for this sync operation
          const bootstrappersEnv = process.env.BOOTSTRAPPERS;
          const availableBootstrapPeers = bootstrappersEnv 
            ? bootstrappersEnv.split(',').map((b: string) => b.trim()).filter((b: string) => b.length > 0)
            : [];
            
          // First, ensure we're connected to bootstrap peers for DHT operations
          if (availableBootstrapPeers.length > 0) {
            for (const bootstrapPeer of availableBootstrapPeers) {
              try {
                // Check if we're already connected to this peer (by trying to dial)
                const connections = client!.libp2p.getConnections();
                const isConnected = connections.some(conn => 
                  conn.remoteAddr.toString().includes(bootstrapPeer.split('/p2p/')[1])
                );
                
                if (!isConnected) {
                  logger.debug('Ensuring connection to bootstrap peer for DHT', {
                    siteId,
                    bootstrapPeer,
                  });
                  await client!.dial(bootstrapPeer);
                }
              } catch (bootstrapDialError) {
                logger.debug('Failed to dial bootstrap peer', {
                  siteId,
                  bootstrapPeer,
                  error: bootstrapDialError instanceof Error ? bootstrapDialError.message : bootstrapDialError,
                });
              }
            }
          }
          
          // Try DHT content routing to find providers
          if (client!.libp2p.contentRouting) {
            try {
              const { CID } = await import('multiformats/cid');
              const targetCID = CID.parse(siteId);
              
              logger.info('Querying DHT for content providers', {
                siteId,
                targetCID: targetCID.toString(),
                availableBootstrapPeers: availableBootstrapPeers.length,
                totalConnections: client!.libp2p.getConnections().length,
              });
              
              // Query DHT for providers of this content with timeout
              const providers = [];
              const queryTimeout = 10000; // 10 second timeout
              const queryPromise = (async () => {
                for await (const provider of client!.libp2p.contentRouting.findProviders(targetCID)) {
                  providers.push(provider);
                  logger.info('Found content provider via DHT', {
                    siteId,
                    providerId: provider.id.toString(),
                    multiaddrs: provider.multiaddrs?.map(addr => addr.toString()) || [],
                  });
                  
                  // Try to connect to this provider if not already connected
                  if (!client!.libp2p.getPeers().some(p => p.equals(provider.id))) {
                    try {
                      logger.info('Connecting to content provider', {
                        siteId,
                        providerId: provider.id.toString(),
                      });
                      await client!.dial(provider.multiaddrs?.[0] || provider.id);
                    } catch (dialError) {
                      logger.debug('Failed to dial content provider', {
                        siteId,
                        providerId: provider.id.toString(),
                        error: dialError instanceof Error ? dialError.message : dialError,
                      });
                    }
                  }
                  
                  // Stop after finding a reasonable number of providers
                  if (providers.length >= 3) break;
                }
                return providers;
              })();
              
              // Race the query against timeout
              try {
                await Promise.race([
                  queryPromise,
                  new Promise((_, reject) => 
                    setTimeout(() => reject(new Error('DHT query timeout')), queryTimeout)
                  )
                ]);
              } catch (timeoutError) {
                logger.debug('DHT query timed out, proceeding with found providers', {
                  siteId,
                  providersFound: providers.length,
                });
              }
              
              logger.info('DHT content query completed', {
                siteId,
                providersFound: providers.length,
              });
              
              // If we found providers, try to open the site for replication
              if (providers.length > 0) {
                try {
                  logger.info('Attempting to open subscribed site for replication', {
                    siteId,
                    providersAvailable: providers.length,
                  });
                  
                  const subscribedSite = await client!.open<Site>(siteId, {
                    args: DEDICATED_SITE_ARGS,
                  });
                  
                  const replicatedReleases = (await subscribedSite.releases.index.search(new SearchRequest({}))).length;
                  logger.info('Successfully opened and synced subscribed site', {
                    siteId,
                    replicatedReleases,
                    expectedReleases: 35,
                    syncPercentage: Math.round((replicatedReleases / 35) * 100),
                  });
                  
                  // Keep the site open for a bit to allow full sync
                  setTimeout(async () => {
                    try {
                      await subscribedSite.close();
                      logger.info('Closed subscribed site after sync period', { siteId });
                    } catch (closeError) {
                      logger.debug('Error closing subscribed site', { siteId, error: closeError });
                    }
                  }, 60000); // Keep open for 1 minute to allow sync
                  
                } catch (openError) {
                  logger.debug('Failed to open subscribed site for replication', {
                    siteId,
                    error: openError instanceof Error ? openError.message : openError,
                  });
                }
              }
              
            } catch (dhtError) {
              logger.debug('DHT content query failed', {
                siteId,
                error: dhtError instanceof Error ? dhtError.message : dhtError,
              });
            }
          }
          
          // Fallback: Check if any connected peers might have this site open
          for (const peerId of client!.libp2p.getPeers()) {
            if (siteId === site.address) continue; // Skip self
            logger.debug('Checking if peer has subscribed site content', {
              peerId: peerId.toString(),
              targetSiteId: siteId,
            });
          }
        } catch (syncCheckError) {
          logger.debug('Error checking sync status', {
            siteId,
            error: syncCheckError instanceof Error ? syncCheckError.message : syncCheckError,
          });
        }
      }
      
      lastSubscriptionCheck = currentTime;
    } catch (error) {
      logError('Error checking subscription sync status', error);
    }
  }, 30000); // Check every 30 seconds
  
  // Log initial store sizes
  setTimeout(async () => {
    try {
      const releasesCount = (await site.releases.index.search(new SearchRequest({}))).length;
      const featuredCount = (await site.featuredReleases.index.search(new SearchRequest({}))).length;
      const subscriptionsCount = (await site.subscriptions.index.search(new SearchRequest({}))).length;
      
      logger.info('Initial store sizes', {
        releases: releasesCount,
        featuredReleases: featuredCount,
        subscriptions: subscriptionsCount,
      });
      
      // Log that this node is ready to replicate content
      logger.info('Node ready for content replication', {
        siteAddress: site.address,
        peerId: client!.peerId.toString(),
        mode: 'admin',
        replicationEnabled: true,
      });
    } catch (error) {
      logError('Error getting initial store sizes', error);
    }
  }, 5000); // Wait 5 seconds after startup
}

export default runCommand;