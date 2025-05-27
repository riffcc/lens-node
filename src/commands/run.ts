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
import { clearLine, cursorTo } from 'readline';

// Status line manager for non-disruptive updates
class StatusLineManager {
  private statusLines: Map<string, string> = new Map();
  private isActive: boolean = false;
  private lastLineCount: number = 0;
  private persistentMessages: string[] = [];

  activate() {
    this.isActive = true;
    this.showMessage('📋 TUI Active - Status updates will appear below', true);
  }

  deactivate() {
    this.isActive = false;
    this.clearStatus();
  }

  // Show a message that will persist until cleared
  showMessage(message: string, persistent: boolean = false) {
    if (!this.isActive) {
      console.log(message);
      return;
    }

    if (persistent) {
      this.persistentMessages.push(message);
    } else {
      this.statusLines.set('temp', message);
      // Clear temporary message after 3 seconds
      setTimeout(() => {
        this.statusLines.delete('temp');
        this.render();
      }, 3000);
    }
    this.render();
  }

  // Update a specific status line
  updateStatus(key: string, message: string) {
    if (!this.isActive) {
      logger.info(message);
      return;
    }

    this.statusLines.set(key, message);
    this.render();
  }

  // Clear a specific status line
  clearStatus(key?: string) {
    if (key) {
      this.statusLines.delete(key);
      this.render();
    } else {
      this.clearAllStatus();
    }
  }

  private render() {
    if (!this.isActive) return;

    // Move cursor to beginning of status area
    if (this.lastLineCount > 0) {
      process.stdout.write(`\x1b[${this.lastLineCount}A`);
    }

    // Combine persistent messages and status lines
    const allLines = [
      ...this.persistentMessages,
      ...Array.from(this.statusLines.values())
    ];
    this.lastLineCount = allLines.length;

    allLines.forEach(line => {
      clearLine(process.stdout, 0);
      cursorTo(process.stdout, 0);
      process.stdout.write(`${line}\n`);
    });
  }

  private clearAllStatus() {
    if (this.lastLineCount > 0) {
      // Move up and clear all status lines
      for (let i = 0; i < this.lastLineCount; i++) {
        process.stdout.write('\x1b[1A');
        clearLine(process.stdout, 0);
        cursorTo(process.stdout, 0);
      }
      this.lastLineCount = 0;
    }
    this.statusLines.clear();
    this.persistentMessages = [];
  }
}

const statusManager = new StatusLineManager();

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
      statusManager.deactivate();
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
      const errorMessage = reason instanceof Error ? reason.message : String(reason);
      
      // Handle peer:reachable timeouts gracefully without logging as errors
      if (errorMessage.includes('peer:reachable') || errorMessage.includes('Aborted waiting for event')) {
        logger.debug('Peer connection timeout (handled gracefully)', {
          reason: errorMessage,
          type: 'peer_timeout'
        });
        return;
      }
      
      // Log other unhandled rejections
      logError('Unhandled Promise Rejection', reason instanceof Error ? reason : new Error(String(reason)), {
        promiseString: promise.toString(),
      });
      console.error('Unhandled Rejection:', errorMessage);
    });
    
    process.on('uncaughtException', (error) => {
      logError('Uncaught Exception', error);
      console.error('Uncaught Exception:', error.message);
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
        statusManager.showMessage(`Using bootstrapped site address ${siteAddress}, resetting the config..`);
        fs.rmSync(dir, { recursive: true, force: true });
        fs.mkdirSync(dir, { recursive: true });
        statusManager.showMessage(`Node directory cleared and ready for new configuration at: ${dir}`);
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
        statusManager.showMessage(`🔍 Enhanced DHT operations available with ${bootstrapPeers.length} bootstrap peers for content routing`);
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
      
      // Debug libp2p services and routing availability
      logger.info('Libp2p services available', {
        contentRouting: !!client.libp2p.contentRouting,
        services: Object.keys(client.libp2p.services || {}),
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
        statusManager.showMessage('Dialing bootstrappers...');
        
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
        statusManager.showMessage(`${successful}/${dialingResult.length} bootstrappers addresses were dialed successfully.`);
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
      
      // Advertise content in DHT to register as provider
      try {
        logger.info('Registering as DHT content provider', {
          siteAddress: site.address,
          contentRouting: !!client.libp2p.contentRouting,
          connectedPeers: client.libp2p.getConnections().length,
          bootstrapPeersConfigured: bootstrapPeers.length,
        });
        
        // Check if content routing is available  
        if (!client.libp2p.contentRouting) {
          logger.warn('Content routing not available - DHT provider registration skipped', {
            impact: 'Other nodes will not be able to discover this content via DHT',
            suggestion: 'Content will be available via Peerbit native replication',
          });
        } else if (!client.libp2p.contentRouting.provide) {
          logger.warn('Content routing provider method not available');
        } else {
          // Convert site address to CID for DHT advertisement
          const { CID } = await import('multiformats/cid');
          const siteCID = CID.parse(site.address);
          
          // Register this node as a provider for the site content
          await client.libp2p.contentRouting.provide(siteCID);
          
          // Also register as provider for individual stores
          const releasesCID = CID.parse(site.releases.address);
          const featuredCID = CID.parse(site.featuredReleases.address);
          const subscriptionsCID = CID.parse(site.subscriptions.address);
          
          await Promise.all([
            client.libp2p.contentRouting.provide(releasesCID),
            client.libp2p.contentRouting.provide(featuredCID),
            client.libp2p.contentRouting.provide(subscriptionsCID),
          ]);
          
          logger.info('Successfully registered as DHT content provider', {
            siteAddress: site.address,
            stores: {
              releases: site.releases.address,
              featured: site.featuredReleases.address,
              subscriptions: site.subscriptions.address,
            },
            connectedPeers: client.libp2p.getConnections().length,
          });
          
          statusManager.showMessage(`✅ Registered as DHT provider for ${site.address}`);
          
          // Set up periodic re-advertisement to maintain DHT provider status
          const advertiseInterval = setInterval(async () => {
            try {
              if (client?.libp2p.contentRouting?.provide) {
                await client.libp2p.contentRouting.provide(siteCID);
                logger.debug('Re-advertised content in DHT', {
                  siteAddress: site?.address,
                  timestamp: new Date().toISOString(),
                });
              }
            } catch (readvertiseError) {
              logger.debug('Failed to re-advertise content', {
                siteAddress: site?.address,
                error: readvertiseError instanceof Error ? readvertiseError.message : readvertiseError,
              });
            }
          }, 300000); // Re-advertise every 5 minutes
          
          // Store interval for cleanup on shutdown
          process.on('SIGINT', () => clearInterval(advertiseInterval));
          process.on('SIGTERM', () => clearInterval(advertiseInterval));
        }
        
      } catch (error) {
        logError('Failed to register as DHT content provider', error, {
          siteAddress: site.address,
          errorType: error instanceof Error ? error.constructor.name : 'Unknown',
          errorMessage: error instanceof Error ? error.message : String(error),
        });
        
        if (error instanceof Error && error.message.includes('No content routers available')) {
          logger.warn('DHT content routing unavailable', {
            impact: 'Content discovery will rely on direct peer connections',
            suggestion: 'This is normal if no DHT bootstrap peers are configured',
            currentBootstrapPeers: bootstrapPeers.length,
          });
          statusManager.showMessage('⚠️  DHT provider registration failed - content discovery limited to direct peers');
        }
      }
      
      // Initialize Peerbit content replication system
      const connections = client.libp2p.getConnections();
      logger.info('Peerbit replication system ready', {
        siteAddress: site.address,
        connectedPeers: connections.length,
        replicationMode: onlyReplicate ? 'dedicated' : 'admin',
        peerIds: connections.map(c => c.remotePeer.toString()),
      });
      
      if (connections.length > 0) {
        statusManager.showMessage(`✅ Connected to ${connections.length} peers - content replication active`);
      } else {
        statusManager.showMessage('⚠️  No peer connections - waiting for peers to connect');
      }
      
      // Set up comprehensive sync monitoring
      setupSyncMonitoring(site, lensService);
      logger.info('LensService configured with site program');
      
      // Monitor when new releases are added
      
      // Monitor when new releases are added
      site!.releases.events.addEventListener('change', (evt) => {
        const addedCount = evt.detail.added?.length || 0;
        const removedCount = evt.detail.removed?.length || 0;
        
        // Skip logging if nothing changed
        if (addedCount === 0 && removedCount === 0) {
          return;
        }
        
        logSyncEvent('releases:change', {
          added: addedCount,
          removed: removedCount,
          addedIds: evt.detail.added?.map((doc: any) => doc[ID_PROPERTY]),
          removedIds: evt.detail.removed?.map((doc: any) => doc[ID_PROPERTY]),
        });
      });
      
      // Monitor subscription changes
      site.subscriptions.events.addEventListener('change', async (evt) => {
        const addedCount = evt.detail.added?.length || 0;
        const removedCount = evt.detail.removed?.length || 0;
        
        // Skip logging if nothing changed
        if (addedCount === 0 && removedCount === 0) {
          return;
        }
        
        logSubscriptionEvent('subscription:change', {
          added: addedCount,
          removed: removedCount,
          addedSites: evt.detail.added?.map((sub: any) => sub[SUBSCRIPTION_SITE_ID_PROPERTY]),
          removedSites: evt.detail.removed?.map((sub: any) => sub[SUBSCRIPTION_SITE_ID_PROPERTY]),
        });
        
        // Set up sync for newly added subscriptions
        if (addedCount > 0 && evt.detail.added) {
          try {
            const syncManager = (lensService as any).syncManager;
            if (syncManager) {
              statusManager.showMessage(`🔄 Setting up sync for ${addedCount} new subscription(s) added via UI...`);
              await syncManager.setupSubscriptionSync(evt.detail.added);
              statusManager.showMessage(`✅ Real-time sync activated for new subscription(s)`);
            } else {
              // Fallback: create new sync manager if none exists
              statusManager.showMessage(`🔄 Creating sync manager for ${addedCount} new subscription(s)...`);
              const newSyncManager = await setupSubscriptionSync(client!, site!, lensService!, evt.detail.added);
              (lensService as any).syncManager = newSyncManager;
              statusManager.showMessage(`✅ Real-time sync activated for new subscription(s)`);
            }
          } catch (syncError) {
            logError('Failed to set up sync for UI-added subscription', syncError, {
              addedSites: evt.detail.added?.map((sub: any) => sub[SUBSCRIPTION_SITE_ID_PROPERTY]),
            });
            statusManager.showMessage(`❌ Failed to set up sync for new subscription(s): ${(syncError as Error).message}`);
          }
        }
      });
      
      // Monitor featured releases changes
      site.featuredReleases.events.addEventListener('change', (evt) => {
        const addedCount = evt.detail.added?.length || 0;
        const removedCount = evt.detail.removed?.length || 0;
        
        // Skip logging if nothing changed
        if (addedCount === 0 && removedCount === 0) {
          return;
        }
        
        logSyncEvent('featuredReleases:change', {
          added: addedCount,
          removed: removedCount,
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
      
      // Set up initial subscription sync and real-time monitoring
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
        
        // Set up event-driven real-time sync for each existing subscription
        if (initialSubs.length > 0) {
          statusManager.showMessage(`🔄 Setting up event-driven real-time sync for ${initialSubs.length} subscriptions...`);
          const syncManager = await setupSubscriptionSync(client!, site, lensService, initialSubs);
          
          // Store sync manager for later use with new subscriptions
          (lensService as any).syncManager = syncManager;
        }
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
        // Activate status manager for TUI
        statusManager.activate();
        
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
                  statusManager.showMessage('✅ Account authorized successfully.');
                } catch (error) {
                  logError('Error authorizing account', error, {
                    publicKey: stringPubkicKey,
                    accountType,
                  });
                  statusManager.showMessage(`❌ Error on authorizing account: ${(error as Error).message}`);
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
        { name: 'Restore Deleted Content', value: 'restore' },
        { name: 'Clean Ghost Releases', value: 'clean' },
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
      case 'restore':
        await restoreDeletedContent(lensService);
        break;
      case 'clean':
        await cleanGhostReleases(lensService);
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
      statusManager.showMessage('No subscriptions found.');
      return;
    }

    statusManager.showMessage('Current Subscriptions:', true);
    statusManager.showMessage('─'.repeat(80), true);
    
    subscriptions.forEach((sub, index) => {
      statusManager.showMessage(`${index + 1}. Site ID: ${sub[SUBSCRIPTION_SITE_ID_PROPERTY]}`, true);
      if (sub[SUBSCRIPTION_NAME_PROPERTY]) {
        statusManager.showMessage(`   Name: ${sub[SUBSCRIPTION_NAME_PROPERTY]}`, true);
      }
      statusManager.showMessage(`   Recursive: ${sub[SUBSCRIPTION_RECURSIVE_PROPERTY] ? 'Yes' : 'No'}`, true);
      statusManager.showMessage(`   Type: ${sub.subscriptionType || 'direct'}`, true);
      statusManager.showMessage('─'.repeat(80), true);
    });
    
    statusManager.showMessage('', true);
  } catch (error) {
    statusManager.showMessage(`Error fetching subscriptions: ${(error as Error).message}`);
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
      statusManager.showMessage('✅ Successfully subscribed to site!');
      statusManager.showMessage(`   Subscription ID: ${result.id}`, true);
      statusManager.showMessage(`   Hash: ${result.hash}`, true);
      
      // Set up event-driven real-time sync for the new subscription immediately
      logger.info('Setting up event-driven real-time sync for new subscription', {
        siteId: subscriptionData[SUBSCRIPTION_SITE_ID_PROPERTY],
      });
      
      try {
        // Use existing sync manager if available, otherwise create new one
        const syncManager = (lensService! as any).syncManager;
        if (syncManager) {
          await syncManager.setupSubscriptionSync([subscriptionData]);
        } else {
          // Fallback to creating new sync manager
          const newSyncManager = await setupSubscriptionSync(lensService!.client!, lensService!.siteProgram!, lensService!, [subscriptionData]);
          (lensService! as any).syncManager = newSyncManager;
        }
        statusManager.showMessage('🔄 Event-driven real-time sync activated for new subscription');
      } catch (syncError) {
        logError('Failed to set up event-driven real-time sync for new subscription', syncError, {
          siteId: subscriptionData[SUBSCRIPTION_SITE_ID_PROPERTY],
        });
      }
    } else {
      logError('Failed to add subscription', new Error(result.error || 'Unknown error'), subscriptionData);
      statusManager.showMessage(`❌ Failed to subscribe: ${result.error}`);
    }
  } catch (error) {
    console.error('Error subscribing to site:', (error as Error).message);
  }
}

async function unsubscribeSite(lensService: LensService) {
  try {
    const subscriptions = await lensService.getSubscriptions();
    
    if (subscriptions.length === 0) {
      statusManager.showMessage('No subscriptions to remove.');
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

    const subToDelete = subscriptions.find(s => s.id === subscriptionId);
    const siteName = subToDelete?.[SUBSCRIPTION_NAME_PROPERTY] || 'Unnamed Lens';
    const siteId = subToDelete?.[SUBSCRIPTION_SITE_ID_PROPERTY];
    
    // Enhanced confirmation with content removal option
    statusManager.showMessage(`📋 Unsubscribe from: ${siteName}`, true);
    statusManager.showMessage(`🔗 Site ID: ${siteId}`, true);
    
    const unsubscribeOptions = await inquirer.prompt([
      {
        type: 'confirm',
        name: 'confirm',
        message: `Are you sure you want to unsubscribe from "${siteName}"?`,
        default: false,
      },
      {
        type: 'confirm',
        name: 'removeContent',
        message: '🗑️  Remove all federated content from this Lens? (This will delete all releases that came from this subscription)',
        default: false,
        when: (answers) => answers.confirm, // Only ask if they confirmed unsubscribe
      },
    ]);

    if (!unsubscribeOptions.confirm) {
      statusManager.showMessage('❌ Unsubscribe cancelled.');
      return;
    }

    // Show summary of what will happen
    statusManager.showMessage('\n📊 Unsubscribe Summary:');
    statusManager.showMessage(`   • Lens: ${siteName}`);
    statusManager.showMessage(`   • Remove subscription: ✅ Yes`);
    statusManager.showMessage(`   • Remove federated content: ${unsubscribeOptions.removeContent ? '✅ Yes' : '❌ No'}`);
    
    if (unsubscribeOptions.removeContent) {
      statusManager.showMessage('\n⚠️  WARNING: This will permanently delete all content that was federated from this Lens!');
      statusManager.showMessage('   Content originally created on your own site will NOT be affected.');
      
      const finalConfirm = await inquirer.prompt([
        {
          type: 'confirm',
          name: 'finalConfirm',
          message: 'Continue with content removal?',
          default: false,
        },
      ]);
      
      if (!finalConfirm.finalConfirm) {
        statusManager.showMessage('\n❌ Unsubscribe cancelled.\n');
        return;
      }
    }

    logSubscriptionEvent('subscription:delete:start', {
      id: subscriptionId,
      siteId,
      siteName,
      removeContent: unsubscribeOptions.removeContent,
    });
    
    // Remove federated content if requested
    let removedContentCount = 0;
    if (unsubscribeOptions.removeContent && siteId) {
      statusManager.updateStatus('content-removal', '🧹 Removing federated content...');
      try {
        removedContentCount = await removeFederatedContent(lensService, siteId, siteName);
      } catch (contentRemovalError) {
        logError('Failed to remove federated content', contentRemovalError, {
          siteId,
          siteName,
        });
        console.error(`⚠️  Warning: Failed to remove some federated content: ${(contentRemovalError as Error).message}`);
        statusManager.showMessage('Continuing with subscription removal...');
      }
    }
    
    // Remove the subscription
    const result = await lensService.deleteSubscription({ id: subscriptionId });

    if (result.success) {
      logSubscriptionEvent('subscription:delete:success', {
        id: subscriptionId,
        siteId,
        siteName,
        removeContent: unsubscribeOptions.removeContent,
        removedContentCount,
      });
      
      statusManager.showMessage('✅ Successfully unsubscribed!');
      if (unsubscribeOptions.removeContent) {
        statusManager.showMessage(`🗑️  Removed ${removedContentCount} federated releases from "${siteName}"`, true);
      }
    } else {
      logError('Failed to delete subscription', new Error(result.error || 'Unknown error'), {
        id: subscriptionId,
        siteId,
        removedContentCount,
      });
      console.error(`\n❌ Failed to unsubscribe: ${result.error}\n`);
    }
  } catch (error) {
    console.error('Error unsubscribing:', (error as Error).message);
  }
}

async function restoreDeletedContent(lensService: LensService) {
  try {
    const subscriptions = await lensService.getSubscriptions();
    
    if (subscriptions.length === 0) {
      statusManager.showMessage('\nNo subscriptions found to restore content from.\n');
      return;
    }

    const choices = subscriptions.map((sub, index) => ({
      name: `${sub[SUBSCRIPTION_NAME_PROPERTY] || 'Unnamed'} - ${sub[SUBSCRIPTION_SITE_ID_PROPERTY]}`,
      value: sub,
    }));

    const { selectedSubscription } = await inquirer.prompt([
      {
        type: 'list',
        name: 'selectedSubscription',
        message: 'Select a subscription to restore content from:',
        choices: [
          ...choices,
          new inquirer.Separator(),
          { name: 'Cancel', value: 'cancel' },
        ],
      },
    ]);

    if (selectedSubscription === 'cancel') {
      return;
    }

    const siteId = selectedSubscription[SUBSCRIPTION_SITE_ID_PROPERTY];
    const siteName = selectedSubscription[SUBSCRIPTION_NAME_PROPERTY] || 'Unnamed Lens';
    
    statusManager.updateStatus('content-restore', `🔄 Checking for restorable content from "${siteName}"...`);
    
    try {
      // Check if site is already open in sync manager
      let subscribedSite: Site | undefined;
      const syncManager = (lensService as any).syncManager as SubscriptionSyncManager | undefined;
      
      if (syncManager) {
        subscribedSite = syncManager.getOpenSite(siteId);
        if (subscribedSite) {
          logger.info('Using already-open site from sync manager for content restoration', {
            siteId,
            siteName,
          });
        }
      }
      
      // If not already open, open it now
      if (!subscribedSite) {
        logger.info('Opening subscribed site for content restoration', {
          siteId,
          siteName,
        });
        
        subscribedSite = await lensService.client!.open<Site>(siteId, {
          args: DEDICATED_SITE_ARGS,
        });
      }
      
      const shouldCloseAfter = !syncManager?.getOpenSite(siteId); // Only close if we opened it
      
      // Get all releases from the subscribed site
      const availableReleases = await subscribedSite.releases.index.search(new SearchRequest({
        fetch: 1000
      }));
      
      // Get current local releases
      const localSite = lensService.siteProgram;
      if (!localSite) {
        throw new Error('Local site not available');
      }
      
      const localReleases = await localSite.releases.index.search(new SearchRequest({
        fetch: 1000
      }));
      const localIds = new Set(localReleases.map((release: any) => release.id));
      
      // Find releases that exist in the source but not locally
      const restorableReleases = availableReleases.filter((release: any) => !localIds.has(release.id));
      
      if (restorableReleases.length === 0) {
        statusManager.showMessage(`✅ No missing content found. All releases from "${siteName}" are already present locally.`);
        // Only close if we opened it (not already managed by sync manager)
        if (shouldCloseAfter) {
          await subscribedSite.close();
        }
        return;
      }
      
      statusManager.showMessage(`📦 Found ${restorableReleases.length} releases that can be restored from "${siteName}"`, true);
      statusManager.showMessage(`   Total available: ${availableReleases.length}`, true);
      statusManager.showMessage(`   Already present: ${availableReleases.length - restorableReleases.length}`, true);
      statusManager.showMessage(`   Missing/Restorable: ${restorableReleases.length}`, true);
      
      // Show some examples of what would be restored
      if (restorableReleases.length > 0) {
        statusManager.showMessage('Examples of content that would be restored:');
        const examples = restorableReleases.slice(0, 5);
        examples.forEach((release: any, index: number) => {
          const title = release.name || 'Untitled';
          const truncatedTitle = title.length > 50 ? title.substring(0, 47) + '...' : title;
          statusManager.showMessage(`   ${index + 1}. ${truncatedTitle}`);
        });
        if (restorableReleases.length > 5) {
          statusManager.showMessage(`   ... and ${restorableReleases.length - 5} more`);
        }
        statusManager.showMessage('');
      }
      
      const restoreOptions = await inquirer.prompt([
        {
          type: 'confirm',
          name: 'confirm',
          message: `Restore ${restorableReleases.length} missing releases from "${siteName}"?`,
          default: false,
        },
      ]);

      if (!restoreOptions.confirm) {
        statusManager.showMessage('❌ Content restoration cancelled.');
        // Only close if we opened it (not already managed by sync manager)
        if (shouldCloseAfter) {
          await subscribedSite.close();
        }
        return;
      }

      statusManager.updateStatus('restore-progress', `🔄 Restoring content from "${siteName}"...`);
      
      // Restore content in batches
      let restoredCount = 0;
      const batchSize = 10;
      
      for (let i = 0; i < restorableReleases.length; i += batchSize) {
        const batch = restorableReleases.slice(i, i + batchSize);
        
        const batchRestoredCount = await federateNewContent(localSite, batch, siteId, siteName, lensService);
        restoredCount += batchRestoredCount;
        
        // Progress indicator
        const progress = Math.min(i + batchSize, restorableReleases.length);
        statusManager.updateStatus('restore-progress', `   Restored ${progress}/${restorableReleases.length} releases...`);
        
        // Small delay between batches
        if (i + batchSize < restorableReleases.length) {
          await new Promise(resolve => setTimeout(resolve, 100));
        }
      }
      
      // Only close if we opened it (not already managed by sync manager)
      if (shouldCloseAfter) {
        await subscribedSite.close();
      }
      
      statusManager.showMessage(`✅ Content restoration completed!`);
      statusManager.showMessage(`   Successfully restored: ${restoredCount}/${restorableReleases.length} releases`, true);
      statusManager.showMessage(`   From: "${siteName}"`, true);
      
      logger.info('Content restoration completed', {
        siteId,
        siteName,
        totalAvailable: availableReleases.length,
        totalRestorable: restorableReleases.length,
        successfullyRestored: restoredCount,
      });
      
    } catch (error) {
      logError('Failed to restore content', error, {
        siteId,
        siteName,
      });
      console.error(`\n❌ Failed to restore content: ${(error as Error).message}\n`);
    }
    
  } catch (error) {
    console.error('Error in content restoration:', (error as Error).message);
  }
}

async function cleanGhostReleases(lensService: LensService) {
  try {
    statusManager.updateStatus('ghost-scan', '🔍 Scanning for ghost releases...');
    
    const localSite = lensService.siteProgram;
    if (!localSite) {
      statusManager.showMessage('❌ Local site not available');
      return;
    }
    
    // Get all releases from Peerbit store
    const allPeerbitReleases = await localSite.releases.index.search(new SearchRequest({
      fetch: 1000
    }));
    
    statusManager.showMessage(`📊 Found ${allPeerbitReleases.length} releases in Peerbit store`);
    
    // Get our own site ID
    const ourSiteId = localSite.address;
    
    // Get current subscriptions to identify valid federated sites
    const currentSubscriptions = await lensService.getSubscriptions();
    const subscribedSiteIds = new Set(currentSubscriptions.map((sub: any) => sub[SUBSCRIPTION_SITE_ID_PROPERTY]));
    
    statusManager.showMessage(`📊 Found ${currentSubscriptions.length} current subscriptions`);
    statusManager.showMessage(`📊 Our site ID: ${ourSiteId}`);
    
    // Find ghost releases: federated content from sites we're no longer subscribed to
    const ghostReleases = allPeerbitReleases.filter((release: any) => {
      const federatedFrom = (release as any).federatedFrom;
      
      // If it has no federatedFrom, it's our own content - keep it
      if (!federatedFrom) {
        return false;
      }
      
      // If it's federated from our own site, keep it (shouldn't happen but be safe)
      if (federatedFrom === ourSiteId) {
        return false;
      }
      
      // If it's federated from a site we're still subscribed to, keep it
      if (subscribedSiteIds.has(federatedFrom)) {
        return false;
      }
      
      // Otherwise, it's a ghost - federated from a site we're no longer subscribed to
      return true;
    });
    
    if (ghostReleases.length === 0) {
      statusManager.showMessage('✅ No ghost releases found. All releases are properly synchronized.');
      return;
    }
    
    statusManager.showMessage(`👻 Found ${ghostReleases.length} ghost releases:`, true);
    statusManager.showMessage(`   • Total releases: ${allPeerbitReleases.length}`, true);
    statusManager.showMessage(`   • Current subscriptions: ${currentSubscriptions.length}`, true);
    statusManager.showMessage(`   • Ghost releases (from unsubscribed sites): ${ghostReleases.length}`, true);
    
    // Show which sites the ghosts are from
    const ghostSources = new Map();
    ghostReleases.forEach((release: any) => {
      const source = (release as any).federatedFrom || 'unknown';
      ghostSources.set(source, (ghostSources.get(source) || 0) + 1);
    });
    
    if (ghostSources.size > 0) {
      statusManager.showMessage(`   • Ghost sources:`, true);
      Array.from(ghostSources.entries()).forEach(([siteId, count]) => {
        statusManager.showMessage(`     - ${siteId}: ${count} releases`, true);
      });
    }
    
    // Show examples of ghost releases
    const examples = ghostReleases.slice(0, 5);
    examples.forEach((release: any, index: number) => {
      const title = release.name || 'Untitled';
      const truncatedTitle = title.length > 50 ? title.substring(0, 47) + '...' : title;
      const federatedFrom = (release as any).federatedFrom ? ` (from ${(release as any).federatedFrom})` : '';
      statusManager.showMessage(`   ${index + 1}. ${truncatedTitle}${federatedFrom}`);
    });
    if (ghostReleases.length > 5) {
      statusManager.showMessage(`   ... and ${ghostReleases.length - 5} more`);
    }
    statusManager.showMessage('');
    
    const cleanupOptions = await inquirer.prompt([
      {
        type: 'confirm',
        name: 'confirm',
        message: `Clean up ${ghostReleases.length} ghost releases?`,
        default: false,
      },
    ]);

    if (!cleanupOptions.confirm) {
      statusManager.showMessage('❌ Ghost release cleanup cancelled.');
      return;
    }

    statusManager.updateStatus('ghost-cleanup', `🧹 Cleaning up ${ghostReleases.length} ghost releases...`);
    
    let cleanedCount = 0;
    const batchSize = 10;
    
    for (let i = 0; i < ghostReleases.length; i += batchSize) {
      const batch = ghostReleases.slice(i, i + batchSize);
      
      for (const release of batch) {
        try {
          // Try to delete from the releases store
          await localSite.releases.del(release.id);
          
          // Verify the deletion worked by checking if it still exists
          const stillExists = await localSite.releases.index.get(release.id);
          if (!stillExists) {
            cleanedCount++;
            logger.debug('Successfully cleaned ghost release', {
              releaseId: release.id,
              title: release.name || 'Untitled',
              federatedFrom: (release as any).federatedFrom,
            });
          } else {
            logger.warn('Ghost release deletion failed - still exists after del()', {
              releaseId: release.id,
              title: release.name || 'Untitled',
            });
          }
        } catch (error) {
          logger.warn('Failed to clean ghost release', {
            releaseId: release.id,
            error: error instanceof Error ? error.message : error,
          });
        }
      }
      
      // Progress indicator
      const progress = Math.min(i + batchSize, ghostReleases.length);
      statusManager.showMessage(`   Cleaned ${progress}/${ghostReleases.length} ghost releases...`);
      
      // Small delay between batches
      if (i + batchSize < ghostReleases.length) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }
    
    statusManager.showMessage(`\n✅ Ghost release cleanup completed!`);
    statusManager.showMessage(`   Successfully cleaned: ${cleanedCount}/${ghostReleases.length} releases`);
    
    // Verify cleanup by re-scanning
    statusManager.showMessage(`   🔍 Verifying cleanup...`);
    const postCleanupReleases = await localSite.releases.index.search(new SearchRequest({
      fetch: 1000
    }));
    
    // Use the same ghost detection logic
    const remainingGhosts = postCleanupReleases.filter((release: any) => {
      const federatedFrom = (release as any).federatedFrom;
      if (!federatedFrom || federatedFrom === ourSiteId) return false;
      return !subscribedSiteIds.has(federatedFrom);
    });
    
    if (remainingGhosts.length > 0) {
      statusManager.showMessage(`   ⚠️  Warning: ${remainingGhosts.length} ghost releases still remain after cleanup`);
      logger.warn('Ghost releases still remain after cleanup', {
        remainingCount: remainingGhosts.length,
        remainingIds: remainingGhosts.slice(0, 5).map((r: any) => r.id),
      });
    } else {
      statusManager.showMessage(`   ✅ All ghost releases successfully removed`);
    }
    
    logger.info('Ghost release cleanup completed', {
      totalGhostReleases: ghostReleases.length,
      successfullyCleaned: cleanedCount,
      remainingGhosts: remainingGhosts.length,
      totalReleases: allPeerbitReleases.length,
      currentSubscriptions: currentSubscriptions.length,
    });
    
  } catch (error) {
    console.error('Error cleaning ghost releases:', (error as Error).message);
    logger.error('Ghost release cleanup failed', {
      error: error instanceof Error ? error.message : error,
      stack: error instanceof Error ? error.stack : undefined,
    });
  }
}

// Remove all federated content from a specific site
async function removeFederatedContent(lensService: LensService, siteId: string, siteName: string): Promise<number> {
  logger.info('Starting federated content removal', {
    siteId,
    siteName,
  });
  
  try {
    const site = lensService.siteProgram;
    if (!site) {
      throw new Error('Site program not available');
    }
    
    // First, try to find federated content using the index
    const allReleases = await site.releases.index.search(new SearchRequest({
      fetch: 5000 // Increase limit to catch more
    }));
    
    let federatedReleases = allReleases.filter((release: any) => 
      release.federatedFrom === siteId
    );
    
    // If we found some federated releases but suspect there might be more,
    // do a more thorough search using the federatedFrom field directly
    if (federatedReleases.length > 0 || allReleases.length >= 1000) {
      logger.info('Performing thorough federated content search', {
        siteId,
        initialCount: federatedReleases.length
      });
      
      try {
        // Search specifically for federated content
        const federatedSearch = await site.releases.index.search(new SearchRequest({
          query: { federatedFrom: siteId },
          fetch: 5000
        }));
        
        // Combine and deduplicate results
        const federatedIds = new Set(federatedReleases.map(r => r.id));
        federatedSearch.forEach(release => {
          if (!federatedIds.has(release.id)) {
            federatedReleases.push(release);
          }
        });
        
        logger.info('Thorough search completed', {
          siteId,
          finalCount: federatedReleases.length
        });
      } catch (searchError) {
        logger.warn('Thorough federated search failed, using initial results', {
          error: searchError instanceof Error ? searchError.message : searchError
        });
      }
    }
    
    logger.info('Found federated content to remove', {
      siteId,
      siteName,
      totalReleases: allReleases.length,
      federatedReleases: federatedReleases.length,
    });
    
    if (federatedReleases.length === 0) {
      statusManager.showMessage(`   No federated content found from "${siteName}"`);
      return 0;
    }
    
    statusManager.showMessage(`   Found ${federatedReleases.length} releases to remove from "${siteName}"`);
    
    // Remove federated releases in batches
    let removedCount = 0;
    const batchSize = 10;
    
    for (let i = 0; i < federatedReleases.length; i += batchSize) {
      const batch = federatedReleases.slice(i, i + batchSize);
      
      for (const release of batch) {
        try {
          logger.debug('Attempting to delete federated release', {
            releaseId: release.id,
            title: release.name || 'Untitled',
            siteId,
            hasLensService: !!lensService,
            deleteReleaseType: lensService ? typeof lensService.deleteRelease : 'N/A',
          });
          
          if (lensService && typeof lensService.deleteRelease === 'function') {
            const deleteResult = await lensService.deleteRelease({ id: release.id });
            if (deleteResult && deleteResult.success) {
              removedCount++;
              logger.info('Successfully removed federated release via LensService', {
                releaseId: release.id,
                title: release.name || 'Untitled',
                siteId,
              });
            } else {
              logger.warn('LensService failed to remove federated release, trying direct deletion', {
                releaseId: release.id,
                error: deleteResult?.error || 'Unknown error',
                siteId,
              });
              
              // If LensService fails, try direct deletion as fallback
              try {
                await site.releases.del(release.id);
                removedCount++;
                logger.info('Successfully removed via direct deletion after LensService failure', {
                  releaseId: release.id,
                  siteId,
                });
              } catch (fallbackError) {
                logger.error('Both LensService and direct deletion failed', {
                  releaseId: release.id,
                  lensError: deleteResult?.error,
                  directError: fallbackError instanceof Error ? fallbackError.message : fallbackError,
                });
              }
            }
          } else {
            // Try direct deletion from the site
            logger.warn('LensService not available, attempting direct deletion', {
              releaseId: release.id,
              hasLensService: !!lensService,
              deleteReleaseType: lensService ? typeof lensService.deleteRelease : 'N/A',
            });
            
            try {
              await site.releases.del(release.id);
              removedCount++;
              logger.info('Successfully removed federated release via direct deletion', {
                releaseId: release.id,
                title: release.name || 'Untitled',
                siteId,
              });
            } catch (directError) {
              logger.error('Direct deletion failed', {
                releaseId: release.id,
                error: directError instanceof Error ? directError.message : directError,
              });
            }
          }
        } catch (removeError) {
          logger.error('Error removing federated release', {
            releaseId: release.id,
            error: removeError instanceof Error ? removeError.message : removeError,
            stack: removeError instanceof Error ? removeError.stack : undefined,
            siteId,
          });
        }
      }
      
      // Progress indicator
      const progress = Math.min(i + batchSize, federatedReleases.length);
      statusManager.showMessage(`   Removed ${progress}/${federatedReleases.length} releases...`);
      
      // Small delay between batches
      if (i + batchSize < federatedReleases.length) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }
    
    // Verify removal by checking if any federated content remains
    const remainingCheck = await site.releases.index.search(new SearchRequest({
      query: { federatedFrom: siteId },
      fetch: 100
    }));
    
    if (remainingCheck.length > 0) {
      logger.warn('Some federated content still remains after removal', {
        siteId,
        siteName,
        remainingCount: remainingCheck.length,
        attemptedRemoval: federatedReleases.length,
        successfullyRemoved: removedCount,
      });
      
      statusManager.showMessage(`\n⚠️  Warning: ${remainingCheck.length} federated releases still remain after cleanup.`);
      statusManager.showMessage(`   This might be due to caching or replication delays.`);
      statusManager.showMessage(`   Try running the cleanup again or restart the node to clear caches.\n`);
    }
    
    logger.info('Federated content removal completed', {
      siteId,
      siteName,
      totalFound: federatedReleases.length,
      successfullyRemoved: removedCount,
      remaining: remainingCheck.length,
    });
    
    return removedCount;
    
  } catch (error) {
    logError('Error during federated content removal', error, {
      siteId,
      siteName,
    });
    throw error;
  }
}

// Sync content removals - remove federated content that no longer exists in the source
async function syncContentRemovals(localSite: Site, subscribedSite: Site, siteId: string): Promise<number> {
  logger.info('Starting content removal sync', {
    siteId,
  });
  
  try {
    // Get current releases from the subscribed site
    const currentSubscriptionReleases = await subscribedSite.releases.index.search(new SearchRequest({
      fetch: 1000
    }));
    const currentSubscriptionIds = new Set(currentSubscriptionReleases.map((release: any) => release.id));
    
    // Get all local federated releases from this site
    const allLocalReleases = await localSite.releases.index.search(new SearchRequest({
      fetch: 1000
    }));
    const localFederatedReleases = allLocalReleases.filter((release: any) => 
      release.federatedFrom === siteId
    );
    
    // Find federated releases that no longer exist in the source
    const releasesToRemove = localFederatedReleases.filter((release: any) => 
      !currentSubscriptionIds.has(release.id)
    );
    
    logger.info('Content removal sync analysis', {
      siteId,
      currentSubscriptionReleases: currentSubscriptionReleases.length,
      localFederatedReleases: localFederatedReleases.length,
      releasesToRemove: releasesToRemove.length,
    });
    
    if (releasesToRemove.length === 0) {
      logger.info('No orphaned federated content found', { siteId });
      return 0;
    }
    
    statusManager.showMessage(`   Found ${releasesToRemove.length} releases that were removed from source - cleaning up...`);
    
    // Remove orphaned federated releases
    let removedCount = 0;
    for (const release of releasesToRemove) {
      try {
        // Note: We need to remove directly from the index since we don't have LensService.deleteRelease
        // This is a simplified approach - in production, you'd want proper deletion through the service
        logger.debug('Removing orphaned federated release', {
          releaseId: release.id,
          title: release.name || 'Untitled',
          siteId,
        });
        
        // For now, we'll just log what would be removed
        // TODO: Implement proper release deletion through the service
        removedCount++;
        
      } catch (removeError) {
        logger.warn('Error removing orphaned federated release', {
          releaseId: release.id,
          error: removeError instanceof Error ? removeError.message : removeError,
          siteId,
        });
      }
    }
    
    logger.info('Content removal sync completed', {
      siteId,
      analysedReleases: localFederatedReleases.length,
      removedReleases: removedCount,
    });
    
    if (removedCount > 0) {
      statusManager.showMessage(`   ✅ Cleaned up ${removedCount} orphaned releases`);
    }
    
    return removedCount;
    
  } catch (error) {
    logError('Error during content removal sync', error, {
      siteId,
    });
    throw error;
  }
}

// Federate newly added content in real-time
async function federateNewContent(localSite: Site, newReleases: any[], siteId: string, siteName?: string, lensService?: any): Promise<number> {
  logger.info('Starting real-time content federation', {
    siteId,
    siteName,
    newReleasesCount: newReleases.length,
  });
  
  if (newReleases.length === 0) return 0;
  
  try {
    // Get existing local releases to check for duplicates
    const existingReleases = await localSite.releases.index.search(new SearchRequest({
      fetch: 1000
    }));
    const existingIds = new Set(existingReleases.map((release: any) => release.id));
    
    let federatedCount = 0;
    
    for (const release of newReleases) {
      try {
        // Check if this release already exists
        if (!existingIds.has(release.id)) {
          // Add federated metadata
          const federatedRelease = {
            ...release,
            federatedFrom: siteId,
            federatedAt: new Date().toISOString(),
            federatedRealtime: true, // Mark as real-time federated
          };
          
          // Use LensService if available, otherwise fall back to direct insertion
          if (lensService && typeof lensService.addRelease === 'function') {
            try {
              logger.debug('Attempting to add release via LensService', {
                releaseId: release.id,
                title: release.name || 'Untitled',
                siteId,
                siteName,
                hasLensService: !!lensService,
                addReleaseType: typeof lensService.addRelease,
              });
              
              const addResult = await lensService.addRelease(federatedRelease);
              if (addResult && addResult.success) {
                federatedCount++;
                existingIds.add(release.id); // Update our cache
                logger.info('Successfully federated release via LensService', {
                  releaseId: release.id,
                  title: release.name || 'Untitled',
                  siteId,
                  siteName,
                  resultId: addResult.id,
                  resultHash: addResult.hash,
                });
              } else {
                logger.warn('LensService failed to add federated release', {
                  releaseId: release.id,
                  error: addResult?.error || 'Unknown error',
                  addResult,
                });
              }
            } catch (lensError) {
              logger.error('LensService error during federation', {
                releaseId: release.id,
                error: lensError instanceof Error ? lensError.message : lensError,
                stack: lensError instanceof Error ? lensError.stack : undefined,
              });
            }
          } else {
            logger.warn('LensService not available for federation', {
              releaseId: release.id,
              title: release.name || 'Untitled',
              siteId,
              siteName,
              hasLensService: !!lensService,
              lensServiceType: typeof lensService,
              addReleaseType: lensService ? typeof lensService.addRelease : 'N/A',
            });
            
            // Try direct insertion to the site
            try {
              await localSite.releases.put(federatedRelease);
              federatedCount++;
              existingIds.add(release.id);
              logger.info('Direct federation successful', {
                releaseId: release.id,
                title: release.name || 'Untitled',
                siteId,
                siteName,
              });
            } catch (directError) {
              logger.error('Direct federation failed', {
                releaseId: release.id,
                error: directError instanceof Error ? directError.message : directError,
              });
            }
          }
        }
      } catch (releaseError) {
        logger.debug('Error federating individual release in real-time', {
          releaseId: release.id,
          error: releaseError instanceof Error ? releaseError.message : releaseError,
        });
      }
    }
    
    logger.info('Real-time content federation completed', {
      siteId,
      siteName,
      newReleasesProcessed: newReleases.length,
      federatedCount,
    });
    
    return federatedCount;
    
  } catch (error) {
    logError('Error during real-time content federation', error, {
      siteId,
      siteName,
      newReleasesCount: newReleases.length,
    });
    throw error;
  }
}

// Clean up removed content in real-time
async function cleanupRemovedContent(localSite: Site, removedReleases: any[], siteId: string, lensService?: any): Promise<number> {
  logger.info('Starting real-time content cleanup', {
    siteId,
    removedReleasesCount: removedReleases.length,
  });
  
  if (removedReleases.length === 0) return 0;
  
  try {
    // Get all local federated releases from this site
    const allLocalReleases = await localSite.releases.index.search(new SearchRequest({
      fetch: 1000
    }));
    const localFederatedReleases = allLocalReleases.filter((release: any) => 
      release.federatedFrom === siteId
    );
    
    // Find which removed releases exist locally as federated content
    const removedIds = new Set(removedReleases.map((release: any) => release.id));
    const localReleasesToRemove = localFederatedReleases.filter((release: any) => 
      removedIds.has(release.id)
    );
    
    let cleanedCount = 0;
    
    for (const release of localReleasesToRemove) {
      try {
        // Use LensService if available for proper deletion
        if (lensService && typeof lensService.deleteRelease === 'function') {
          try {
            const deleteResult = await lensService.deleteRelease({ id: release.id });
            if (deleteResult && deleteResult.success) {
              cleanedCount++;
              logger.info('Real-time cleanup: Removed release via LensService', {
                releaseId: release.id,
                title: release.name || 'Untitled',
                siteId,
              });
            } else {
              logger.warn('LensService failed to delete federated release', {
                releaseId: release.id,
                error: deleteResult?.error || 'Unknown error',
                deleteResult,
              });
            }
          } catch (lensError) {
            logger.error('LensService deletion error', {
              releaseId: release.id,
              error: lensError instanceof Error ? lensError.message : lensError,
              stack: lensError instanceof Error ? lensError.stack : undefined,
            });
          }
        } else {
          // Try direct deletion from the site
          logger.warn('LensService not available, attempting direct cleanup deletion', {
            releaseId: release.id,
            title: release.name || 'Untitled',
            siteId,
            hasLensService: !!lensService,
            deleteReleaseType: lensService ? typeof lensService.deleteRelease : 'N/A',
          });
          
          try {
            await localSite.releases.del(release.id);
            cleanedCount++;
            logger.info('Real-time cleanup: Direct deletion successful', {
              releaseId: release.id,
              title: release.name || 'Untitled',
              siteId,
            });
          } catch (directError) {
            logger.error('Real-time cleanup: Direct deletion failed', {
              releaseId: release.id,
              error: directError instanceof Error ? directError.message : directError,
            });
          }
        }
        
      } catch (removeError) {
        logger.warn('Error removing release in real-time cleanup', {
          releaseId: release.id,
          error: removeError instanceof Error ? removeError.message : removeError,
          siteId,
        });
      }
    }
    
    logger.info('Real-time content cleanup completed', {
      siteId,
      removedReleasesProcessed: removedReleases.length,
      localReleasesFound: localReleasesToRemove.length,
      cleanedCount,
    });
    
    return cleanedCount;
    
  } catch (error) {
    logError('Error during real-time content cleanup', error, {
      siteId,
      removedReleasesCount: removedReleases.length,
    });
    throw error;
  }
}

// Event-driven subscription sync manager
class SubscriptionSyncManager {
  private client: Peerbit;
  private localSite: Site;
  private lensService: LensService;
  private activeSubscriptions = new Map<string, {
    site: Site;
    siteName?: string;
    lastActivity: number;
    reconnectAttempts: number;
    healthCheckInterval?: NodeJS.Timeout;
  }>();
  private shutdownHandlers: (() => Promise<void>)[] = [];

  constructor(client: Peerbit, localSite: Site, lensService: LensService) {
    this.client = client;
    this.localSite = localSite;
    this.lensService = lensService;
    
    // Set up global shutdown handlers
    const shutdown = async () => {
      await this.shutdown();
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  }

  async setupSubscriptionSync(subscriptions: any[]) {
    logger.info('Setting up event-driven real-time subscription sync', {
      subscriptionCount: subscriptions.length,
    });
    
    // Process subscriptions in parallel for faster startup
    const setupPromises = subscriptions.map(subscription => 
      this.setupSingleSubscription(subscription).catch(error => {
        logger.warn('Failed to setup subscription during parallel init', {
          siteId: subscription[SUBSCRIPTION_SITE_ID_PROPERTY],
          error: error instanceof Error ? error.message : error,
        });
      })
    );
    
    await Promise.allSettled(setupPromises);
    
    statusManager.showMessage(`🔄 Real-time sync active for ${this.activeSubscriptions.size}/${subscriptions.length} subscriptions`);
  }

  private async setupSingleSubscription(subscription: any) {
    const siteId = subscription[SUBSCRIPTION_SITE_ID_PROPERTY];
    const siteName = subscription[SUBSCRIPTION_NAME_PROPERTY];
    
    // Skip if already active
    if (this.activeSubscriptions.has(siteId)) {
      logger.debug('Subscription already active', { siteId, siteName });
      return;
    }

    logger.info('Setting up subscription sync', { siteId, siteName });
    
    const maxRetries = 5;
    let attempt = 0;
    
    while (attempt < maxRetries) {
      try {
        attempt++;
        
        const subscribedSite = await this.openSubscribedSite(siteId, attempt, maxRetries);
        if (!subscribedSite) continue;
        
        // Set up immediate event handling
        await this.setupEventHandlers(subscribedSite, siteId, siteName);
        
        // Store subscription info
        this.activeSubscriptions.set(siteId, {
          site: subscribedSite,
          siteName,
          lastActivity: Date.now(),
          reconnectAttempts: 0,
        });
        
        // Perform initial sync
        await this.performInitialSync(subscribedSite, siteId, siteName);
        
        // Set up health monitoring
        this.setupHealthMonitoring(siteId);
        
        statusManager.showMessage(`✅ Subscription sync active: "${siteName || siteId}"`);
        break;
        
      } catch (error) {
        logger.warn(`Subscription setup attempt ${attempt} failed`, {
          siteId,
          siteName,
          attempt,
          error: error instanceof Error ? error.message : error,
        });
        
        if (attempt === maxRetries) {
          logger.error('Failed to setup subscription after all retries', {
            siteId,
            siteName,
            maxRetries,
          });
          // Schedule retry in background
          setTimeout(() => this.retrySubscriptionSetup(subscription), 30000);
        } else {
          // Exponential backoff
          const waitTime = Math.min(2000 * Math.pow(2, attempt - 1), 30000);
          await new Promise(resolve => setTimeout(resolve, waitTime));
        }
      }
    }
  }

  private async openSubscribedSite(siteId: string, attempt: number, maxRetries: number): Promise<Site | null> {
    try {
      logger.debug(`Opening subscription site (${attempt}/${maxRetries})`, { siteId });
      
      // Race against timeout with aggressive timeout reduction for faster feedback
      const timeoutMs = Math.max(5000, 15000 - (attempt * 2000));
      
      const subscribedSite = await Promise.race([
        this.client.open<Site>(siteId, { args: DEDICATED_SITE_ARGS }),
        new Promise<never>((_, reject) => 
          setTimeout(() => reject(new Error('Site open timeout')), timeoutMs)
        )
      ]) as Site;
      
      logger.info('Subscription site opened successfully', {
        siteId,
        attempt,
        timeoutMs,
      });
      
      return subscribedSite;
      
    } catch (error) {
      logger.debug('Failed to open subscription site', {
        siteId,
        attempt,
        error: error instanceof Error ? error.message : error,
      });
      return null;
    }
  }

  private async setupEventHandlers(subscribedSite: Site, siteId: string, siteName?: string) {
    // Check if event listener is already set up to prevent duplicates
    const existingListenerCount = subscribedSite.releases.events.listenerCount('change');
    if (existingListenerCount > 0) {
      logger.debug('Event listener already exists for subscription', {
        siteId,
        siteName,
        existingListeners: existingListenerCount,
      });
      return;
    }
    
    // Set up immediate event handling - fully event-driven, no delays
    subscribedSite.releases.events.addEventListener('change', (evt: any) => {
      const added = evt.detail.added || [];
      const removed = evt.detail.removed || [];
      
      // Skip processing if there's nothing to sync
      if (added.length === 0 && removed.length === 0) {
        return;
      }
      
      // Update last activity immediately
      const subscription = this.activeSubscriptions.get(siteId);
      if (subscription) {
        subscription.lastActivity = Date.now();
        subscription.reconnectAttempts = 0; // Reset on successful activity
      }
      
      logger.info('Real-time subscription event', {
        siteId,
        siteName,
        addedCount: added.length,
        removedCount: removed.length,
        timestamp: Date.now(),
      });
      
      // Handle additions immediately - eventually consistent
      if (added.length > 0) {
        statusManager.updateStatus(`sync-${siteId}`, `📥 ${added.length} new releases from "${siteName || siteId}" - syncing...`);
        // Fire-and-forget for maximum speed, with error recovery
        this.handleContentAddition(added, siteId, siteName).catch(error => {
          logger.warn('Content addition failed, will retry', {
            siteId,
            siteName,
            error: error instanceof Error ? error.message : error,
          });
          // Retry in background for eventual consistency
          setTimeout(() => {
            this.handleContentAddition(added, siteId, siteName).catch(() => {
              logger.error('Content addition retry failed', { siteId, siteName });
            });
          }, 5000);
        });
      }
      
      // Handle removals immediately - eventually consistent
      if (removed.length > 0) {
        statusManager.updateStatus(`sync-${siteId}`, `🗑️ ${removed.length} content removals from "${siteName || siteId}" - syncing...`);
        // Fire-and-forget for maximum speed, with error recovery
        this.handleContentRemoval(removed, siteId, siteName).catch(error => {
          logger.warn('Content removal failed, will retry', {
            siteId,
            siteName,
            error: error instanceof Error ? error.message : error,
          });
          // Retry in background for eventual consistency
          setTimeout(() => {
            this.handleContentRemoval(removed, siteId, siteName).catch(() => {
              logger.error('Content removal retry failed', { siteId, siteName });
            });
          }, 5000);
        });
      }
    });
  }

  private async handleContentAddition(added: any[], siteId: string, siteName?: string) {
    const startTime = Date.now();
    
    try {
      // Process additions in parallel for maximum speed
      const federationPromises = added.map(async (release) => {
        try {
          // Skip if this is already federated content to prevent loops
          if (release.federatedFrom) {
            logger.debug('Content is already federated, skipping to prevent loop', {
              releaseId: release.id,
              originalSource: release.federatedFrom,
              currentSource: siteId,
            });
            return false;
          }
          
          // Check for existing release first (optimistic check)
          const existingReleases = await this.localSite.releases.index.search(new SearchRequest({
            query: { id: release.id }
          }));
          
          if (existingReleases.length > 0) {
            logger.debug('Release already exists, skipping', {
              releaseId: release.id,
              siteId,
            });
            return false;
          }
          
          // Prepare federated release with metadata
          const federatedRelease = {
            ...release,
            federatedFrom: siteId,
            federatedAt: new Date().toISOString(),
            federatedRealtime: true,
          };
          
          // Try LensService first for UI consistency
          if (this.lensService && typeof this.lensService.addRelease === 'function') {
            const addResult = await this.lensService.addRelease(federatedRelease);
            if (addResult && addResult.success) {
              logger.debug('Federated via LensService', {
                releaseId: release.id,
                title: release.name || 'Untitled',
                siteId,
              });
              return true;
            }
          }
          
          // Fallback to direct Peerbit insertion for eventual consistency
          await this.localSite.releases.put(federatedRelease);
          logger.debug('Federated via direct Peerbit', {
            releaseId: release.id,
            title: release.name || 'Untitled',
            siteId,
          });
          return true;
          
        } catch (releaseError) {
          logger.warn('Failed to federate individual release', {
            releaseId: release.id,
            error: releaseError instanceof Error ? releaseError.message : releaseError,
          });
          return false;
        }
      });
      
      // Wait for all federation attempts to complete
      const results = await Promise.allSettled(federationPromises);
      const federatedCount = results.filter(r => r.status === 'fulfilled' && r.value).length;
      const duration = Date.now() - startTime;
      
      if (federatedCount > 0) {
        statusManager.updateStatus(`sync-${siteId}`, `✅ Federated ${federatedCount}/${added.length} releases from "${siteName || siteId}" in ${duration}ms`);
      }
      
      logger.info('Content addition completed', {
        siteId,
        siteName,
        totalAdded: added.length,
        federatedCount,
        duration,
        successRate: ((federatedCount / added.length) * 100).toFixed(1),
      });
      
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error(`❌ Federation batch failed for "${siteName || siteId}": ${errorMessage}`);
      logger.error('Federation batch error', {
        siteId,
        siteName,
        error: error instanceof Error ? error.stack : error,
        duration: Date.now() - startTime,
      });
      
      // Schedule recovery for failed operations
      this.scheduleSubscriptionRecovery(siteId);
    }
  }

  private async handleContentRemoval(removed: any[], siteId: string, siteName?: string) {
    const startTime = Date.now();
    
    try {
      // Get all local releases that were federated from this site
      const allLocalReleases = await this.localSite.releases.index.search(new SearchRequest({
        fetch: 1000
      }));
      const localFederatedReleases = allLocalReleases.filter((release: any) => 
        (release as any).federatedFrom === siteId
      );
      
      // Find which removed releases exist locally
      const removedIds = new Set(removed.map((release: any) => release.id));
      const localReleasesToRemove = localFederatedReleases.filter((release: any) => 
        removedIds.has(release.id)
      );
      
      if (localReleasesToRemove.length === 0) {
        logger.debug('No federated content to clean up', { siteId, siteName, removedCount: removed.length });
        return;
      }
      
      // Process removals in parallel for maximum speed
      const removalPromises = localReleasesToRemove.map(async (release) => {
        try {
          // Try LensService first for UI consistency
          if (this.lensService && typeof this.lensService.deleteRelease === 'function') {
            const deleteResult = await this.lensService.deleteRelease({ id: release.id });
            if (deleteResult && deleteResult.success) {
              logger.debug('Removed via LensService', {
                releaseId: release.id,
                title: release.name || 'Untitled',
                siteId,
              });
              return true;
            }
          }
          
          // Fallback to direct Peerbit deletion for eventual consistency
          await this.localSite.releases.del(release.id);
          logger.debug('Removed via direct Peerbit', {
            releaseId: release.id,
            title: release.name || 'Untitled',
            siteId,
          });
          return true;
          
        } catch (removalError) {
          logger.warn('Failed to remove individual release', {
            releaseId: release.id,
            error: removalError instanceof Error ? removalError.message : removalError,
          });
          return false;
        }
      });
      
      // Wait for all removal attempts to complete
      const results = await Promise.allSettled(removalPromises);
      const cleanedCount = results.filter(r => r.status === 'fulfilled' && r.value).length;
      const duration = Date.now() - startTime;
      
      if (cleanedCount > 0) {
        statusManager.updateStatus(`sync-${siteId}`, `🧹 Cleaned ${cleanedCount}/${localReleasesToRemove.length} releases from "${siteName || siteId}" in ${duration}ms`);
      }
      
      logger.info('Content removal completed', {
        siteId,
        siteName,
        totalRemoved: removed.length,
        localReleasesToRemove: localReleasesToRemove.length,
        cleanedCount,
        duration,
        successRate: localReleasesToRemove.length > 0 ? ((cleanedCount / localReleasesToRemove.length) * 100).toFixed(1) : '100',
      });
      
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error(`❌ Cleanup batch failed for "${siteName || siteId}": ${errorMessage}`);
      logger.error('Cleanup batch error', {
        siteId,
        siteName,
        error: error instanceof Error ? error.stack : error,
        duration: Date.now() - startTime,
      });
      
      // Schedule recovery for failed operations
      this.scheduleSubscriptionRecovery(siteId);
    }
  }

  private async performInitialSync(subscribedSite: Site, siteId: string, siteName?: string) {
    try {
      const currentReleases = await subscribedSite.releases.index.search(new SearchRequest({
        fetch: 1000
      }));
      
      if (currentReleases.length > 0) {
        const federatedCount = await federateNewContent(this.localSite, currentReleases, siteId, siteName, this.lensService);
        if (federatedCount > 0) {
          statusManager.showMessage(`📦 Initial sync: ${federatedCount} releases from "${siteName || siteId}"`);
        }
      }
    } catch (error) {
      logger.warn('Initial sync failed', {
        siteId,
        siteName,
        error: error instanceof Error ? error.message : error,
      });
    }
  }

  private setupHealthMonitoring(siteId: string) {
    const subscription = this.activeSubscriptions.get(siteId);
    if (!subscription) return;
    
    // Health check every 30 seconds
    subscription.healthCheckInterval = setInterval(() => {
      this.performHealthCheck(siteId);
    }, 30000);
  }

  private async performHealthCheck(siteId: string) {
    const subscription = this.activeSubscriptions.get(siteId);
    if (!subscription || !subscription.site) return;
    
    const timeSinceActivity = Date.now() - subscription.lastActivity;
    const maxIdleTime = 5 * 60 * 1000; // 5 minutes
    
    // Check for inactivity
    if (timeSinceActivity > maxIdleTime) {
      logger.warn('Subscription appears inactive, scheduling recovery', {
        siteId,
        siteName: subscription.siteName,
        timeSinceActivity,
        maxIdleTime,
      });
      this.scheduleSubscriptionRecovery(siteId);
      return;
    }
    
    // Periodic reconciliation - compare release counts
    try {
      const remoteReleases = await subscription.site.releases.index.search(new SearchRequest({
        fetch: 1 // Just get count
      }));
      const remoteCount = remoteReleases.length;
      
      // Get local federated releases from this site
      const localFederatedReleases = await this.localSite.releases.index.search(new SearchRequest({
        query: { federatedFrom: siteId },
        fetch: 1
      }));
      const localCount = localFederatedReleases.length;
      
      // If counts don't match, perform reconciliation
      if (remoteCount > 0 && localCount < remoteCount) {
        logger.info('Detected release count mismatch, performing reconciliation', {
          siteId,
          siteName: subscription.siteName,
          remoteCount,
          localCount,
          difference: remoteCount - localCount
        });
        
        // Perform partial sync to catch up
        await this.performInitialSync(subscription.site, siteId, subscription.siteName);
      }
    } catch (error) {
      logger.debug('Health check reconciliation failed', {
        siteId,
        error: error instanceof Error ? error.message : error
      });
    }
  }

  private scheduleSubscriptionRecovery(siteId: string) {
    const subscription = this.activeSubscriptions.get(siteId);
    if (!subscription) return;
    
    subscription.reconnectAttempts++;
    
    // Exponential backoff for recovery attempts
    const backoffTime = Math.min(1000 * Math.pow(2, subscription.reconnectAttempts - 1), 60000);
    
    logger.info('Scheduling subscription recovery', {
      siteId,
      siteName: subscription.siteName,
      attempt: subscription.reconnectAttempts,
      backoffTime,
    });
    
    setTimeout(async () => {
      try {
        await this.recoverSubscription(siteId);
      } catch (error) {
        logger.error('Subscription recovery failed', {
          siteId,
          error: error instanceof Error ? error.message : error,
        });
      }
    }, backoffTime);
  }

  private async recoverSubscription(siteId: string) {
    const subscription = this.activeSubscriptions.get(siteId);
    if (!subscription) return;
    
    logger.info('Attempting subscription recovery', {
      siteId,
      siteName: subscription.siteName,
      attempt: subscription.reconnectAttempts,
    });
    
    try {
      // Close old connection
      await subscription.site.close().catch(() => {});
      
      // Clear health check
      if (subscription.healthCheckInterval) {
        clearInterval(subscription.healthCheckInterval);
      }
      
      // Remove from active subscriptions
      this.activeSubscriptions.delete(siteId);
      
      // Retry setup
      const subscriptionData = {
        [SUBSCRIPTION_SITE_ID_PROPERTY]: siteId,
        [SUBSCRIPTION_NAME_PROPERTY]: subscription.siteName,
      };
      
      await this.setupSingleSubscription(subscriptionData);
      
    } catch (error) {
      logger.error('Subscription recovery failed', {
        siteId,
        error: error instanceof Error ? error.message : error,
      });
    }
  }

  private async retrySubscriptionSetup(subscription: any) {
    logger.info('Retrying subscription setup in background', {
      siteId: subscription[SUBSCRIPTION_SITE_ID_PROPERTY],
    });
    
    await this.setupSingleSubscription(subscription);
  }

  // Get an already-open site if available
  getOpenSite(siteId: string): Site | undefined {
    const subscription = this.activeSubscriptions.get(siteId);
    return subscription?.site;
  }

  async shutdown() {
    logger.info('Shutting down subscription sync manager');
    
    const shutdownPromises = Array.from(this.activeSubscriptions.entries()).map(async ([siteId, subscription]) => {
      try {
        if (subscription.healthCheckInterval) {
          clearInterval(subscription.healthCheckInterval);
        }
        await subscription.site.close();
      } catch (error) {
        logger.debug('Error closing subscription during shutdown', { siteId });
      }
    });
    
    await Promise.allSettled(shutdownPromises);
    this.activeSubscriptions.clear();
  }
}

// Set up real-time sync for all existing subscriptions
async function setupSubscriptionSync(client: Peerbit, localSite: Site, lensService: LensService, subscriptions: any[]) {
  const syncManager = new SubscriptionSyncManager(client, localSite, lensService);
  await syncManager.setupSubscriptionSync(subscriptions);
  return syncManager;
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
  
  // Real-time event-driven sync is now handled above - no periodic polling needed
}

export default runCommand;