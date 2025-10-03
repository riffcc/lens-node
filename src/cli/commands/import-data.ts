import type { Arguments, CommandModule } from 'yargs';
import { LensService } from '@riffcc/lens-sdk';
import { logger } from '../logger.js';
import { readConfig } from '../utils.js';
import { dirOption } from './commonOptions.js';
import fs from 'fs/promises';
import path from 'path';

interface ImportOptions {
  dir: string;
  input: string;
}

export const importDataCommand: CommandModule<{}, ImportOptions> = {
  command: 'import-data',
  describe: 'Import data from a previous export (releases, categories, subscriptions)',
  builder: (yargs) => {
    return yargs
      .options({
        dir: dirOption,
        input: {
          type: 'string',
          describe: 'Input file path for the data to import',
          demandOption: true,
        },
      });
  },
  handler: async (argv: Arguments<ImportOptions>) => {
    let service: LensService | undefined;
    
    try {
      const config = readConfig(argv.dir);
      
      logger.info('Starting data import...');
      
      // Read the export file
      const inputPath = path.resolve(argv.input);
      const exportData = JSON.parse(await fs.readFile(inputPath, 'utf-8'));
      
      logger.info(`Import file contains:`);
      logger.info(`  - ${exportData.releases?.length || 0} releases`);
      logger.info(`  - ${exportData.categories?.length || 0} categories`);
      logger.info(`  - ${exportData.featuredReleases?.length || 0} featured releases`);
      logger.info(`  - ${exportData.subscriptions?.length || 0} subscriptions`);
      logger.info(`  - ${exportData.artists?.length || 0} artists`);
      
      service = new LensService();
      await service.init(argv.dir);
      await service.openSite(config.address);
      
      // Import categories first (releases depend on them)
      if (exportData.categories && exportData.categories.length > 0) {
        logger.info('Importing categories...');
        for (const category of exportData.categories) {
          try {
            await service.addContentCategory({
              categoryId: category.categoryId,
              displayName: category.displayName,
              featured: category.featured,
              description: category.description,
              metadataSchema: category.metadataSchema,
            });
            logger.debug(`Imported category: ${category.displayName}`);
          } catch (err) {
            logger.warn(`Failed to import category ${category.displayName}:`, err);
          }
        }
      }
      
      // Import artists
      if (exportData.artists && exportData.artists.length > 0) {
        logger.info('Importing artists...');
        for (const artist of exportData.artists) {
          try {
            await service.addArtist({
              name: artist.name,
              bio: artist.bio,
              avatarCID: artist.avatarCID,
              bannerCID: artist.bannerCID,
              links: artist.links,
              metadata: artist.metadata,
            });
            logger.debug(`Imported artist: ${artist.name}`);
          } catch (err) {
            logger.warn(`Failed to import artist ${artist.name}:`, err);
          }
        }
      }
      
      // Create a mapping of categorySlug to new category ID
      const categorySlugToIdMap = new Map<string, string>();
      if (exportData.categories && exportData.categories.length > 0) {
        const importedCategories = await service.getContentCategories();
        for (const category of importedCategories) {
          categorySlugToIdMap.set(category.categoryId, category.id);
        }
      }
      
      // Import releases
      if (exportData.releases && exportData.releases.length > 0) {
        logger.info('Importing releases...');
        for (const release of exportData.releases) {
          try {
            // If the release has a categorySlug, use it to find the new category ID
            let categoryId = release.categoryId;
            if (release.categorySlug && categorySlugToIdMap.has(release.categorySlug)) {
              categoryId = categorySlugToIdMap.get(release.categorySlug)!;
              logger.debug(`Mapped category slug '${release.categorySlug}' to ID '${categoryId}'`);
            } else if (categorySlugToIdMap.size > 0) {
              // Try to find category by matching the old categoryId as a slug
              const matchingCategory = Array.from(categorySlugToIdMap.entries())
                .find(([slug, _]) => slug === release.categoryId);
              if (matchingCategory) {
                categoryId = matchingCategory[1];
                logger.debug(`Found category by slug match: '${release.categoryId}' -> '${categoryId}'`);
              } else {
                logger.warn(`Could not find category for release '${release.name}' with categoryId '${release.categoryId}'`);
              }
            }
            
            await service.addRelease({
              name: release.name,
              categoryId: categoryId,
              contentCID: release.contentCID,
              thumbnailCID: release.thumbnailCID,
              artistIds: release.artistIds,
              metadata: release.metadata,
            });
            logger.debug(`Imported release: ${release.name}`);
          } catch (err) {
            logger.warn(`Failed to import release ${release.name}:`, err);
          }
        }
      }
      
      // Import featured releases
      if (exportData.featuredReleases && exportData.featuredReleases.length > 0) {
        logger.info('Importing featured releases...');
        for (const featured of exportData.featuredReleases) {
          try {
            await service.addFeaturedRelease({
              releaseId: featured.releaseId,
              startTime: featured.startTime,
              endTime: featured.endTime,
              promoted: featured.promoted,
              order: featured.order,
            });
            logger.debug(`Imported featured release: ${featured.releaseId}`);
          } catch (err) {
            logger.warn(`Failed to import featured release:`, err);
          }
        }
      }
      
      // Import subscriptions
      if (exportData.subscriptions && exportData.subscriptions.length > 0) {
        logger.info('Importing subscriptions...');
        for (const subscription of exportData.subscriptions) {
          try {
            await service.addSubscription({
              to: subscription.to,
            });
            logger.debug(`Imported subscription to: ${subscription.to}`);
          } catch (err) {
            logger.warn(`Failed to import subscription:`, err);
          }
        }
      }
      
      logger.info('Import completed successfully!');
      
    } catch (error) {
      logger.error('Import failed:', error);
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