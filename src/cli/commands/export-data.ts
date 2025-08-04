import type { Arguments, CommandModule } from 'yargs';
import { LensService } from '@riffcc/lens-sdk';
import { logger } from '../logger.js';
import { readConfig } from '../utils.js';
import { dirOption } from './commonOptions.js';
import fs from 'fs/promises';
import path from 'path';

interface ExportOptions {
  dir: string;
  output: string;
}

export const exportDataCommand: CommandModule<{}, ExportOptions> = {
  command: 'export-data',
  describe: 'Export all data from the current site (releases, categories, subscriptions)',
  builder: (yargs) => {
    return yargs
      .options({
        dir: dirOption,
        output: {
          type: 'string',
          describe: 'Output file path for the exported data',
          default: 'lens-export.json',
        },
      });
  },
  handler: async (argv: Arguments<ExportOptions>) => {
    let service: LensService | undefined;
    
    try {
      const config = readConfig(argv.dir);
      
      logger.info('Starting data export...');
      
      service = new LensService();
      await service.init(argv.dir);
      
      try {
        await service.openSite(config.address);
      } catch (error) {
        logger.error('Failed to open site - this might be due to the RBAC issue');
        logger.error('Cannot export data without a working site');
        throw error;
      }
      
      // Export all data
      const categories = await service.getContentCategories();
      const categoryIdToSlugMap = new Map(categories.map(cat => [cat.id, cat.categoryId]));
      
      const releases = await service.getReleases();
      // Add categorySlug to each release for better import mapping
      const releasesWithSlug = releases.map(release => ({
        ...release,
        categorySlug: categoryIdToSlugMap.get(release.categoryId)
      }));
      
      const exportData = {
        exportDate: new Date().toISOString(),
        siteAddress: config.address,
        releases: releasesWithSlug,
        categories: categories,
        featuredReleases: await service.getFeaturedReleases(),
        subscriptions: await service.getSubscriptions(),
        artists: await service.getArtists(),
      };
      
      // Count items
      logger.info(`Exporting:`);
      logger.info(`  - ${exportData.releases.length} releases`);
      logger.info(`  - ${exportData.categories.length} categories`);
      logger.info(`  - ${exportData.featuredReleases.length} featured releases`);
      logger.info(`  - ${exportData.subscriptions.length} subscriptions`);
      logger.info(`  - ${exportData.artists.length} artists`);
      
      // Write to file
      const outputPath = path.resolve(argv.output);
      await fs.writeFile(outputPath, JSON.stringify(exportData, null, 2));
      
      logger.info(`Data exported successfully to: ${outputPath}`);
      
    } catch (error) {
      logger.error('Export failed:', error);
      process.exit(1);
    } finally {
      if (service) {
        try {
          await service.stop();
        } catch (stopError) {
          logger.error('Error stopping service:', stopError);
        }
      }
    }
  },
};