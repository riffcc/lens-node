import type { Arguments, CommandModule } from 'yargs';
import { LensService } from '@riffcc/lens-sdk';
import { MigrationRunner } from '../../migrations/runner.js';
import { logger } from '../logger.js';
import { readConfig } from '../utils.js';
import { dirOption } from './commonOptions.js';

interface MigrateOptions {
  dir: string;
}

export const migrateCommand: CommandModule<{}, MigrateOptions> = {
  command: 'migrate',
  describe: 'Apply pending migrations to the database',
  builder: (yargs) => {
    return yargs
      .options({
        dir: dirOption,
      });
  },
  handler: async (argv: Arguments<MigrateOptions>) => {
    let service: LensService | undefined;
    
    try {
      const config = readConfig(argv.dir);
      
      logger.info('Starting migration process...');
      
      service = new LensService();
      await service.init(argv.dir);
      await service.openSite(config.address);
      
      const runner = new MigrationRunner(argv.dir);
      await runner.run(service);
      
      logger.info('Migration complete');
      
      // Check if release migration is needed
      const releases = await service.getReleases();
      const needsMigration = releases.some(r => 
        r.metadata && typeof r.metadata === 'object' && ('posterCID' in r.metadata || 
        (Object.keys(r.metadata).some(key => key !== key.toLowerCase())))
      );
      
      if (needsMigration) {
        logger.info('\nSome releases may need metadata migration.');
        logger.info('Run "lens-node releases-migrate" to update release metadata.');
      }
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