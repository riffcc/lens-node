import { CommandModule } from 'yargs';
import { Peerbit } from 'peerbit';
import { LensService, Site, ADMIN_SITE_ARGS, SUBSCRIPTION_SITE_ID_PROPERTY } from '@riffcc/lens-sdk';
import { dirOption } from './commonOptions.js';
import { readConfig } from '../utils.js';

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
      client = await Peerbit.create({
        directory: dir,
      });
      
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
        throw new Error(`No subscription found for site ${siteId}`);
      }
      
      // Remove subscription
      const result = await lensService.deleteSubscription({ id: subscription.id });
      
      if (result.success) {
        console.log(`✓ Successfully unfollowed site ${siteId}`);
      } else {
        throw new Error(result.error || 'Failed to unfollow site');
      }
      
    } catch (error) {
      console.error('Error unfollowing site:', error);
      process.exit(1);
    } finally {
      // Clean up
      if (site) await site.close();
      if (client) await client.stop();
    }
  },
};