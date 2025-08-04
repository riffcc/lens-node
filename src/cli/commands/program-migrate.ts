import type { Arguments, CommandModule } from 'yargs';
import { LensService } from '@riffcc/lens-sdk';
import { createProgramMigrationRunner } from '../../program-migrations/index.js';
import { logger } from '../logger.js';
import { readConfig } from '../utils.js';
import { dirOption } from './commonOptions.js';

interface ProgramMigrateOptions {
  dir: string;
}

export const programMigrateCommand: CommandModule<{}, ProgramMigrateOptions> = {
  command: 'program-migrate',
  describe: 'Apply severe program-level migrations (USE WITH CAUTION)',
  builder: (yargs) => {
    return yargs
      .options({
        dir: dirOption,
      })
      .epilogue(`
WARNING: Program migrations are SEVERE operations that modify core data structures.
These are different from regular schema migrations and should only be run when absolutely necessary.
Always backup your data before running program migrations.
      `);
  },
  handler: async (argv: Arguments<ProgramMigrateOptions>) => {
    let service: LensService | undefined;
    
    try {
      logger.warn('='.repeat(60));
      logger.warn('PROGRAM MIGRATION WARNING');
      logger.warn('='.repeat(60));
      logger.warn('You are about to run program-level migrations.');
      logger.warn('These are SEVERE operations that can modify core data structures.');
      logger.warn('Make sure you have backed up your data before proceeding.');
      logger.warn('='.repeat(60));
      
      // Add a delay to ensure user sees the warning
      await new Promise(resolve => setTimeout(resolve, 3000));
      
      const config = readConfig(argv.dir);
      
      logger.info('Starting program migration process...');
      
      service = new LensService();
      
      // Try to initialize - this might fail if there's a compatibility issue
      try {
        await service.init(argv.dir);
        await service.openSite(config.address);
      } catch (error) {
        logger.warn('Failed to open site normally, checking if migration can fix it...');
        // Some migrations might need to run before the site can be opened
      }
      
      const runner = createProgramMigrationRunner(argv.dir);
      await runner.run(service);
      
      logger.info('Program migration process complete');
      
    } catch (error) {
      logger.error('Program migration failed:', error);
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