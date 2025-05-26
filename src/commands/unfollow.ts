import { CommandModule } from 'yargs';
import { Peerbit } from 'peerbit';
import { LensService, Site, ADMIN_SITE_ARGS, SUBSCRIPTION_SITE_ID_PROPERTY } from '@riffcc/lens-sdk';
import { dirOption } from './commonOptions.js';
import { readConfig } from '../utils.js';
import { logger, logSubscriptionEvent, logError } from '../logger.js';

interface UnfollowArguments {
  dir: string;
  siteId: string;
}

export const unfollowCommand: CommandModule<{}, UnfollowArguments> = {
  command: 'unfollow <siteId>',
  describe: 'Unfollow a site to stop receiving updates',
  builder: (yargs) => {
    return yargs
      .positional('siteId', {
        describe: 'ID of the site to unfollow',
        type: 'string',
        demandOption: true,
      })
      .options({
        dir: dirOption,
      });
  },
  handler: async (argv) => {
    const { dir, siteId } = argv;
    
    console.log(`Unfollowing site ${siteId}...`);
    logger.info('Unfollow command started', { siteId, directory: dir });
    
    let client: Peerbit | undefined;
    let site: Site | undefined;
    let lensService: LensService | undefined;
    
    try {
      // Read site config
      const siteConfig = readConfig(dir);
      if (!siteConfig.address) {
        throw new Error('No site address found. Run setup first.');
      }
      
      // Initialize Peerbit client
      logger.info('Creating Peerbit client for unfollow command');
      client = await Peerbit.create({
        directory: dir,
      });
      logger.info('Peerbit client created', { peerId: client.peerId.toString() });
      
      // Initialize LensService
      lensService = new LensService(client);
      
      // Open the site
      site = await client.open<Site>(
        siteConfig.address,
        {
          args: ADMIN_SITE_ARGS
        }
      );
      
      // Set the opened site in LensService
      lensService.siteProgram = site;
      
      // Get all subscriptions to find the one we want to remove
      const subscriptions = await lensService.getSubscriptions();
      const subscription = subscriptions.find(sub => 
        sub[SUBSCRIPTION_SITE_ID_PROPERTY] === siteId.trim()
      );
      
      if (!subscription) {
        logSubscriptionEvent('unfollow:not_found', { siteId: siteId.trim() });
        throw new Error(`No subscription found for site ${siteId}`);
      }
      
      logger.info('Found subscription to remove', {
        siteId: siteId.trim(),
        subscriptionId: subscription.id,
      });
      
      // Remove subscription
      logSubscriptionEvent('unfollow:attempt', {
        siteId: siteId.trim(),
        subscriptionId: subscription.id,
      });
      const result = await lensService.deleteSubscription({ id: subscription.id });
      
      if (result.success) {
        logSubscriptionEvent('unfollow:success', {
          siteId: siteId.trim(),
          subscriptionId: subscription.id,
        });
        console.log(`✓ Successfully unfollowed site ${siteId}`);
      } else {
        throw new Error(result.error || 'Failed to unfollow site');
      }
      
    } catch (error) {
      logError('Failed to unfollow site', error, { siteId });
      console.error('Error unfollowing site:', error);
      process.exit(1);
    } finally {
      // Clean up
      if (site) await site.close();
      if (client) await client.stop();
    }
  },
};