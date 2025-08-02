import inquirer from 'inquirer';
import { input, select } from '@inquirer/prompts';
import { Libp2pCreateOptions, Peerbit } from 'peerbit';
import type { CommandModule } from 'yargs';
import { GlobalOptions } from '../types.js';
import { logOperationSuccess, readConfig, saveConfig } from '../utils.js';
import { LensService } from '@riffcc/lens-sdk';
import { DEFAULT_LISTEN_PORT_LIBP2P } from '../constants.js';
import fs from 'node:fs';
import { dirOption } from './commonOptions.js';
import { logger, logPeerEvent, logError, logSubscriptionEvent } from '../logger.js';
import { startServer } from '../../api/server.js';
import { MigrationGenerator } from '../../migrations/generator.js';
import { MigrationRunner } from '../../migrations/runner.js';
import { defaultSiteContentCategories } from '@riffcc/lens-sdk';


type RunCommandArgs = {
  relay?: boolean;
  domain?: string[];
  listenPort: number;
  onlyReplicate?: boolean;
  dev?: boolean;
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
        array: true,
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
      })
      .option('dev', {
        type: 'boolean',
        description: 'Enable development mode with additional menu options',
        default: false,
      }),
  handler: async (argv) => {
    let peerbit: Peerbit | undefined;
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
        if (peerbit) {
          await peerbit.stop();
          logger.info('Peerbit client closed succesfully')
        }
        logger.info('Cleanup finished');
      } catch (e: unknown) { // --- FIX #1: Use the improved logger here ---
        const error = e instanceof Error ? e : new Error(String(e));
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
            domain.flatMap(d => [
              `/dns4/${d}/tcp/4002`,
              `/dns4/${d}/tcp/4003/wss`,
            ]) :
            undefined,
          listen: [
            `/ip4/${bindHost}/tcp/${listenPort}`,
            `/ip4/${bindHost}/tcp/${listenPort + 1}/ws`,
          ],
        },
      };

      // Initialize Peerbit client
      logger.info('Initializing Peerbit client', {
        directory: dir,
        relay: argv.relay,
        libp2pConfig: JSON.stringify(libp2pConfig, null, 2),
      });

      peerbit = await Peerbit.create({
        directory: dir,
        relay: argv.relay,
        libp2p: libp2pConfig,
      });

      logger.info('Peerbit client created successfully');

      // Add peer connection event listeners
      peerbit.libp2p.addEventListener('peer:connect', (evt) => {
        logPeerEvent('peer:connect', { peerId: evt.detail.toString() });
      });

      peerbit.libp2p.addEventListener('peer:disconnect', (evt) => {
        logPeerEvent('peer:disconnect', { peerId: evt.detail.toString() });
      });

      if (bootstrappers) {
        const bootstrappersList = bootstrappers.split(',').map(b => b.trim());
        logger.info('Dialing bootstrappers', {
          bootstrappers: bootstrappersList,
          count: bootstrappersList.length,
        });

        const promises = bootstrappersList.map((b) => peerbit?.dial(b));
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
      lensService = new LensService({ peerbit, debug: Boolean(process.env.DEBUG) });

      await lensService.openSite(siteConfig.address);
      logger.info('LensService configured.');
      startServer({ lensService });
      logger.info('Lens API REST up.');
      let listeningOn: string[] = [];
      try {
        listeningOn = peerbit.getMultiaddrs().map(m => m.toString());
      } catch (error) {
        logError('Error getting multiaddrs', error);
      }

      logOperationSuccess({
        startMessage: 'Lens Node is running. Press Ctrl+C to stop OR use the menu below.',
        directory: dir,
        peerId: peerbit.peerId.toString(),
        publicKey: peerbit.identity.publicKey.toString(),
        siteAddress,
        listeningOn,
      });

      // Start periodic sync status logging
      if (onlyReplicate) {
        logger.info('Running in replication-only mode, starting periodic status logging');
        const statusInterval = setInterval(async () => {
          try {
            const connections = peerbit!.libp2p.getConnections();
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
            const menuChoices = [
              { name: 'Authorise an account', value: 'authorise' },
              new inquirer.Separator(),
              { name: 'Apply migrations', value: 'apply-migrations' },
              { name: 'Update Content Categories', value: 'update-categories' },
              new inquirer.Separator(),
              // { name: 'Manage Subscriptions', value: 'subscriptions' },
              // new inquirer.Separator(),
            ];

            // Add development options if --dev flag is used
            if (argv.dev) {
              menuChoices.push(
                new inquirer.Separator('--- Development Tools ---'),
                { name: 'Generate Migration', value: 'generate-migration' },
                { name: 'View Database Stats', value: 'db-stats' },
                { name: 'Export Site Data', value: 'export-data' },
                new inquirer.Separator(),
              );
            }

            menuChoices.push({ name: 'Shutdown Node', value: 'shutdown' });

            const answers = await inquirer.prompt(
              [
                {
                  type: 'list',
                  name: 'action',
                  message: 'Actions:',
                  choices: menuChoices,
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
                await handleAuthorizationMenu(lensService!);
                break;
              case 'apply-migrations':
                await handleApplyMigrations(lensService!, argv.dir);
                break;
                // case 'subscriptions':
                //   await handleSubscriptionMenu(lensService!);
                break;
              case 'generate-migration':
                await handleGenerateMigration(lensService!, argv.dir);
                break;
              case 'update-categories':
                await handleUpdateCategories(lensService!);
                break;
              case 'db-stats':
                await handleDatabaseStats(lensService!);
                break;
              case 'export-data':
                await handleExportData(lensService!);
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

    } catch (e: unknown) {
      const error = e instanceof Error ? e : new Error(String(e));
      logError('Fatal error in run command', error);
      await shutdown('fatal_error');
    }
  },
};

async function handleAuthorizationMenu(lensService: LensService) {
  try {
    const authType = await select({
      message: 'What type of authorization do you want to grant?',
      choices: [
        { name: 'Assign a Role', value: 'role', description: 'Grant specific permissions by assigning a role (e.g., member, moderator).' },
        { name: 'Promote to Admin', value: 'admin', description: 'Grant full administrative privileges over the site.' },
      ]
    });

    const stringPublicKey = await input({
      message: 'Enter the public key of the account to authorize:',
      validate: (value) => value.length > 0 ? true : 'Public key cannot be empty.',
    });

    if (authType === 'admin') {
      const result = await lensService.addAdmin(stringPublicKey);
      if (result.success) {
        logger.info('✅ Account promoted to Admin successfully.', {
          publicKey: stringPublicKey,
        });
      } else {
        logError('❌ Failed to promote account to Admin.', new Error(result.error), {
          publicKey: stringPublicKey,
        });
      }
    } else if (authType === 'role') {
      const allRoles = await lensService.getRoles();
      if (allRoles.length === 0) {
        logger.warn('No roles found on this site. Cannot assign a role.');
        return; // Exit the function if no roles are defined
      }
      const selectedRole = await select({
        message: 'Select the role to assign:',
        choices: allRoles.map(role => ({
          name: role.name.toUpperCase(),
          value: role.name
        }))
      });

      const result = await lensService.assignRole(stringPublicKey, selectedRole);
      if (result.success) {
        logger.info(`✅ Role "${selectedRole}" assigned successfully.`, {
          publicKey: stringPublicKey,
          role: selectedRole,
        });
      } else {
        logError(`❌ Failed to assign role "${selectedRole}".`, new Error(result.error), {
          publicKey: stringPublicKey,
          role: selectedRole,
        });
      }
    }
  } catch (error) {
    // This catches errors from the prompts (e.g., Ctrl+C) or the service calls
    if (error instanceof Error && !error.message.includes('User force closed')) {
      logError('Error during authorization process', error);
    }
    // If user cancels, we just return to the main menu silently.
  }
}

// async function handleSubscriptionMenu(lensService: LensService) {
//   try {
//     const action = await select({
//       message: 'Subscription Management:',
//       choices: [
//         { name: 'View Current Subscriptions', value: 'view' },
//         { name: 'Subscribe to a Site', value: 'subscribe' },
//         { name: 'Unsubscribe from a Site', value: 'unsubscribe' },
//         { name: 'Back to Main Menu', value: 'back' },
//       ],
//     });

//     switch (action) {
//       case 'view':
//         await viewSubscriptions(lensService);
//         break;
//       case 'subscribe':
//         await subscribeSite(lensService);
//         break;
//       case 'unsubscribe':
//         await unsubscribeSite(lensService);
//         break;
//       case 'back':
//         return;
//     }
//   } catch (error) {
//     console.error('Error in subscription menu:', (error as Error).message);
//   }
// }

// async function viewSubscriptions(lensService: LensService) {
//   try {
//     logger.info('Fetching current subscriptions');
//     const subscriptions = await lensService.getSubscriptions();

//     logSubscriptionEvent('subscriptions:viewed', {
//       count: subscriptions.length,
//     });

//     if (subscriptions.length === 0) {
//       logger.info('\nNo subscriptions found.\n');
//       return;
//     }

//     console.log('\nCurrent Subscriptions:');
//     console.log('─'.repeat(80));

//     subscriptions.forEach((sub, index) => {
//       logger.info({
//         id: sub.id,
//         siteAddress: sub.siteAddress,
//       })
//     });
//   } catch (error) {
//     console.error('Error fetching subscriptions:', (error as Error).message);
//   }
// }

// async function subscribeSite(lensService: LensService) {
//   try {
//     const { siteAddress } = await inquirer.prompt([
//       {
//         type: 'input',
//         name: 'siteAddress',
//         message: 'Enter the Site Address to subscribe to:',
//         required: true,
//         validate: (input) => {
//           if (!input.trim()) {
//             return 'Site ID cannot be empty';
//           }
//           return true;
//         },
//       },
//     ]);

//     const subscriptionData = {
//       siteAddress: siteAddress.trim(),
//     };

//     logSubscriptionEvent('subscription:add:start', subscriptionData);
//     const result = await lensService.addSubscription(subscriptionData);

//     if (result.success) {
//       logSubscriptionEvent('subscription:add:success', {
//         ...subscriptionData,
//         id: result.id,
//         hash: result.hash,
//       });
//     } else {
//       logError('Failed to add subscription', new Error(result.error || 'Unknown error'), subscriptionData);
//     }
//   } catch (error) {
//     logError('Error subscribing to site:', (error as Error).message);
//   }
// }

// async function unsubscribeSite(lensService: LensService) {
//   try {
//     const subscriptions = await lensService.getSubscriptions();

//     if (subscriptions.length === 0) {
//       console.log('\nNo subscriptions to remove.\n');
//       return;
//     }

//     const choices = subscriptions.map((sub, index) => ({
//       name: `${sub[SUBSCRIPTION_NAME_PROPERTY] || 'Unnamed'} - ${sub[SITE_ADDRESS_PROPERTY]}`,
//       value: sub.id,
//     }));

//     const { subscriptionId } = await inquirer.prompt([
//       {
//         type: 'list',
//         name: 'subscriptionId',
//         message: 'Select a subscription to remove:',
//         choices: [
//           ...choices,
//           new inquirer.Separator(),
//           { name: 'Cancel', value: 'cancel' },
//         ],
//       },
//     ]);

//     if (subscriptionId === 'cancel') {
//       return;
//     }

//     const { confirm } = await inquirer.prompt([
//       {
//         type: 'confirm',
//         name: 'confirm',
//         message: 'Are you sure you want to unsubscribe?',
//         default: false,
//       },
//     ]);

//     if (!confirm) {
//       console.log('\nUnsubscribe cancelled.\n');
//       return;
//     }

//     const subToDelete = subscriptions.find(s => s.id === subscriptionId);
//     logSubscriptionEvent('subscription:delete:start', {
//       id: subscriptionId,
//       siteAddress: subToDelete?.[SITE_ADDRESS_PROPERTY],
//     });

//     const result = await lensService.deleteSubscription({ id: subscriptionId });

//     if (result.success) {
//       logSubscriptionEvent('subscription:delete:success', {
//         id: subscriptionId,
//         siteAddress: subToDelete?.[SITE_ADDRESS_PROPERTY],
//       });
//       console.log('\n✅ Successfully unsubscribed!\n');
//     } else {
//       logError('Failed to delete subscription', new Error(result.error || 'Unknown error'), {
//         id: subscriptionId,
//       });
//       console.error(`\n❌ Failed to unsubscribe: ${result.error}\n`);
//     }
//   } catch (error) {
//     console.error('Error unsubscribing:', (error as Error).message);
//   }
// }

async function handleApplyMigrations(lensService: LensService, dir: string) {
  try {
    logger.info('Checking for pending migrations...');
    
    const runner = new MigrationRunner(dir);
    await runner.loadMigrations();
    const applied = await runner.getAppliedMigrations();
    
    // Get pending migrations by checking which ones haven't been applied
    const allMigrations = (runner as any).migrations || [];
    const pending = allMigrations.filter((m: any) => !applied.includes(m.id));
    
    if (pending.length === 0) {
      logger.info('No pending migrations found');
      return;
    }
    
    logger.info(`Found ${pending.length} pending migration(s):`);
    pending.forEach((m: any) => {
      logger.info(`  - ${m.id}: ${m.description}`);
    });
    
    const confirm = await input({
      message: 'Apply these migrations? (yes/no)',
      default: 'no',
    });
    
    if (confirm.toLowerCase() === 'yes' || confirm.toLowerCase() === 'y') {
      await runner.run(lensService);
      logger.info('Migrations applied successfully');
    } else {
      logger.info('Migration cancelled');
    }
  } catch (error) {
    logError('Error applying migrations', error);
  }
}

async function handleGenerateMigration(lensService: LensService, dir: string) {
  try {
    const fromVersion = await input({
      message: 'Enter source version (e.g., 0.1.32):',
      default: '0.1.32',
    });
    
    const toVersion = await input({
      message: 'Enter target version (e.g., 0.1.33):',
      default: '0.1.33',
    });
    
    logger.info(`Generating migration from v${fromVersion} to v${toVersion}...`);
    
    const generator = new MigrationGenerator(lensService);
    await generator.generateMigration(fromVersion, toVersion);
    
    logger.info('Migration generation complete');
  } catch (error) {
    logError('Error generating migration', error);
  }
}

async function handleUpdateCategories(lensService: LensService) {
  try {
    logger.info('Checking for content category updates...');
    
    const generator = new MigrationGenerator(lensService);
    // Use interactive mode to handle field removals/renames
    const changes = await generator.detectChanges(true);
    
    if (changes.length === 0) {
      logger.info('No category updates needed');
      return;
    }
    
    logger.info(`\nSummary of changes to apply:`);
    logger.info('─'.repeat(50));
    changes.forEach(change => {
      if (change.type === 'rename-field') {
        logger.info(`  - Rename field '${change.oldField}' to '${change.newField}' in category '${change.categoryId}'`);
      } else {
        logger.info(`  - ${change.type} ${change.categoryId}${change.field ? `.${change.field}` : ''}`);
      }
    });
    logger.info('─'.repeat(50));
    
    const confirm = await input({
      message: 'Apply these changes? (yes/no)',
      default: 'no',
    });
    
    if (confirm.toLowerCase() === 'yes' || confirm.toLowerCase() === 'y') {
      logger.info('Applying changes...');
      await generator.applyChanges(changes);
      logger.info('Category updates complete!');
      
      // Check if any releases need metadata migration
      const renamedFields = changes.filter(c => c.type === 'rename-field');
      if (renamedFields.length > 0) {
        logger.warn('\nIMPORTANT: The following field renames require release metadata migration:');
        renamedFields.forEach(change => {
          logger.warn(`  - Category '${change.categoryId}': field '${change.oldField}' → '${change.newField}'`);
        });
        logger.warn('Run "Generate Migration" to create a migration script for updating release metadata.');
      }
    } else {
      logger.info('Update cancelled');
    }
  } catch (error) {
    logError('Error updating categories', error);
  }
}

async function handleDatabaseStats(lensService: LensService) {
  try {
    const site = lensService.siteProgram;
    if (!site) {
      logger.error('Site not initialized');
      return;
    }
    
    const stats = {
      releases: await site.releases.index.getSize(),
      featuredReleases: await site.featuredReleases.index.getSize(),
      subscriptions: await site.subscriptions.index.getSize(),
      contentCategories: await site.contentCategories.index.getSize(),
      // blockList: await site.blockList.index.getSize(), // TODO: Add when available
    };
    
    logger.info('Database Statistics:');
    logger.info('─'.repeat(50));
    Object.entries(stats).forEach(([key, value]) => {
      logger.info(`${key}: ${value}`);
    });
    logger.info('─'.repeat(50));
    
    // Show category details
    const categories = await lensService.getContentCategories();
    logger.info('\nContent Categories:');
    categories.forEach(cat => {
      let schemaFieldCount = 0;
      try {
        const schema = JSON.parse(cat.metadataSchema || '{}');
        schemaFieldCount = Object.keys(schema).length;
      } catch (e) {}
      logger.info(`  - ${cat.categoryId} (${cat.displayName}): ${schemaFieldCount} metadata fields`);
    });
    
  } catch (error) {
    logError('Error getting database stats', error);
  }
}

async function handleExportData(lensService: LensService) {
  try {
    const exportType = await select({
      message: 'What would you like to export?',
      choices: [
        { name: 'All Releases', value: 'releases' },
        { name: 'Content Categories', value: 'categories' },
        { name: 'Featured Releases', value: 'featured' },
        { name: 'Subscriptions', value: 'subscriptions' },
        { name: 'Everything', value: 'all' },
      ],
    });
    
    const filename = await input({
      message: 'Enter filename for export:',
      default: `lens-export-${exportType}-${Date.now()}.json`,
    });
    
    let exportData: any = {};
    
    if (exportType === 'releases' || exportType === 'all') {
      const releases = await lensService.getReleases();
      exportData.releases = releases;
    }
    
    if (exportType === 'categories' || exportType === 'all') {
      const categories = await lensService.getContentCategories();
      exportData.categories = categories;
    }
    
    if (exportType === 'featured' || exportType === 'all') {
      const featured = await lensService.getFeaturedReleases();
      exportData.featured = featured;
    }
    
    if (exportType === 'subscriptions' || exportType === 'all') {
      const subscriptions = await lensService.getSubscriptions();
      exportData.subscriptions = subscriptions;
    }
    
    fs.writeFileSync(filename, JSON.stringify(exportData, null, 2));
    logger.info(`Data exported to ${filename}`);
    
  } catch (error) {
    logError('Error exporting data', error);
  }
}

export default runCommand;