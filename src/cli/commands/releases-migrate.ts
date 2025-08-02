import type { Arguments, CommandModule } from 'yargs';
import { LensService } from '@riffcc/lens-sdk';
import { logger } from '../logger.js';
import { readConfig } from '../utils.js';
import { dirOption } from './commonOptions.js';
import { confirm } from '@inquirer/prompts';

interface ReleasesMigrateOptions {
  dir: string;
  fromField?: string;
  toField?: string;
  category?: string;
  dryRun?: boolean;
}

export const releasesMigrateCommand: CommandModule<{}, ReleasesMigrateOptions> = {
  command: 'releases-migrate',
  describe: 'Migrate release metadata fields (e.g., rename posterCID to cover)',
  builder: (yargs) => {
    return yargs
      .options({
        dir: dirOption,
        'from-field': {
          type: 'string',
          description: 'Source field name to migrate from',
        },
        'to-field': {
          type: 'string',
          description: 'Target field name to migrate to',
        },
        category: {
          type: 'string',
          description: 'Only migrate releases in this category',
        },
        'dry-run': {
          type: 'boolean',
          description: 'Show what would be migrated without making changes',
          default: false,
        },
      });
  },
  handler: async (argv: Arguments<ReleasesMigrateOptions>) => {
    let service: LensService | undefined;
    
    try {
      const config = readConfig(argv.dir);
      
      logger.info('Starting release metadata migration...');
      
      service = new LensService();
      await service.init(argv.dir);
      await service.openSite(config.address);
      
      // Get all releases
      const releases = await service.getReleases();
      logger.info(`Found ${releases.length} releases`);
      
      // Filter by category if specified
      let targetReleases = releases;
      if (argv.category) {
        targetReleases = releases.filter(r => r.categoryId === argv.category);
        logger.info(`Filtered to ${targetReleases.length} releases in category '${argv.category}'`);
      }
      
      // Find releases that need migration
      const releasesToMigrate = [];
      
      if (argv.fromField && argv.toField) {
        // Specific field migration
        for (const release of targetReleases) {
          if (release.metadata && typeof release.metadata === 'object' && argv.fromField in release.metadata) {
            releasesToMigrate.push({
              release,
              changes: [{
                from: argv.fromField,
                to: argv.toField,
                value: (release.metadata as any)[argv.fromField],
              }],
            });
          }
        }
      } else {
        // Auto-detect common migrations
        for (const release of targetReleases) {
          const changes = [];
          
          if (release.metadata && typeof release.metadata === 'object') {
            // Check for posterCID -> cover migration
            if ('posterCID' in release.metadata && !('cover' in release.metadata)) {
              changes.push({
                from: 'posterCID',
                to: 'cover',
                value: (release.metadata as any).posterCID,
              });
            }
          }
          
          if (changes.length > 0) {
            releasesToMigrate.push({ release, changes });
          }
        }
      }
      
      if (releasesToMigrate.length === 0) {
        logger.info('No releases need migration');
        return;
      }
      
      // Show what will be migrated
      logger.info(`\nFound ${releasesToMigrate.length} releases to migrate:`);
      logger.info('─'.repeat(50));
      
      for (const { release, changes } of releasesToMigrate.slice(0, 5)) {
        logger.info(`Release: ${release.name} (${release.categoryId})`);
        for (const change of changes) {
          logger.info(`  ${change.from} → ${change.to}: ${change.value}`);
        }
      }
      
      if (releasesToMigrate.length > 5) {
        logger.info(`... and ${releasesToMigrate.length - 5} more`);
      }
      
      logger.info('─'.repeat(50));
      
      if (argv.dryRun) {
        logger.info('Dry run complete. No changes were made.');
        return;
      }
      
      // Confirm migration
      const proceed = await confirm({
        message: `Migrate ${releasesToMigrate.length} releases?`,
        default: false,
      });
      
      if (!proceed) {
        logger.info('Migration cancelled');
        return;
      }
      
      // Perform migration
      let successCount = 0;
      let errorCount = 0;
      
      for (const { release, changes } of releasesToMigrate) {
        try {
          const currentMetadata = (typeof release.metadata === 'object' ? release.metadata : {}) as Record<string, any>;
          const updatedMetadata = { ...currentMetadata };
          
          for (const change of changes) {
            updatedMetadata[change.to] = change.value;
            delete updatedMetadata[change.from];
          }
          
          const result = await service.editRelease({
            id: release.id,
            name: release.name,
            categoryId: release.categoryId,
            contentCID: release.contentCID,
            thumbnailCID: release.thumbnailCID,
            metadata: updatedMetadata as any,
            siteAddress: release.siteAddress,
            postedBy: release.postedBy,
          });
          
          if (result.success) {
            successCount++;
            logger.debug(`Migrated release: ${release.name}`);
          } else {
            errorCount++;
            logger.error(`Failed to migrate release ${release.name}: ${result.error}`);
          }
        } catch (error) {
          errorCount++;
          logger.error(`Error migrating release ${release.name}:`, error);
        }
      }
      
      logger.info(`\nMigration complete:`);
      logger.info(`  Successful: ${successCount}`);
      logger.info(`  Failed: ${errorCount}`);
      
    } catch (error) {
      logger.error('Migration failed:', error);
      process.exit(1);
    } finally {
      if (service) {
        await service.stop();
      }
    }
  },
};