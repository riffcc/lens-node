import { CommandModule } from 'yargs';
import { Peerbit } from 'peerbit';
import { LensService, Site, ADMIN_SITE_ARGS, SUBSCRIPTION_SITE_ID_PROPERTY, SUBSCRIPTION_NAME_PROPERTY, SUBSCRIPTION_RECURSIVE_PROPERTY } from '@riffcc/lens-sdk';
import { dirOption } from './commonOptions.js';
import { readConfig } from '../utils.js';

interface FollowArguments {
  dir: string;
  siteId: string;
}

export const followCommand: CommandModule<{}, FollowArguments> = {
  command: 'follow <siteId>',
  describe: 'Follow a site to receive updates',
  builder: (yargs) => {
    return yargs
      .positional('siteId', {
        describe: 'ID of the site to follow',
        type: 'string',
        demandOption: true,
      })
      .options({
        dir: dirOption,
      });
  },
  handler: async (argv) => {
    const { dir, siteId } = argv;
    
    console.log(`Following site ${siteId}...`);
    
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
      
      // Create subscription data
      const subscriptionData = {
        [SUBSCRIPTION_SITE_ID_PROPERTY]: siteId.trim(),
        [SUBSCRIPTION_NAME_PROPERTY]: undefined,
        [SUBSCRIPTION_RECURSIVE_PROPERTY]: false,
        subscriptionType: 'direct',
        currentDepth: 0,
        followChain: [],
      };
      
      // Add subscription
      const result = await lensService.addSubscription(subscriptionData);
      
      if (result.success) {
        console.log(`✓ Successfully followed site ${siteId}`);
        console.log(`  Subscription ID: ${result.id}`);
        console.log(`  Hash: ${result.hash}`);
      } else {
        throw new Error(result.error || 'Failed to follow site');
      }
      
    } catch (error) {
      console.error('Error following site:', error);
      process.exit(1);
    } finally {
      // Clean up
      if (site) await site.close();
      if (client) await client.stop();
    }
  },
};