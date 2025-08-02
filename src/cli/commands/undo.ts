import type { Arguments, CommandModule } from 'yargs';
import { LensService } from '@riffcc/lens-sdk';
import { MigrationRunner } from '../../migrations/runner.js';
import { logger } from '../logger.js';
import { readConfig } from '../utils.js';
import { dirOption } from './commonOptions.js';
import { select } from '@inquirer/prompts';

interface UndoOptions {
  dir: string;
  all?: boolean;
}

export const undoCommand: CommandModule<{}, UndoOptions> = {
  command: 'undo',
  describe: 'Undo applied migrations',
  builder: (yargs) => {
    return yargs
      .options({
        dir: dirOption,
        all: {
          type: 'boolean',
          description: 'Undo all applied migrations',
          default: false,
        },
      });
  },
  handler: async (argv: Arguments<UndoOptions>) => {
    let service: LensService | undefined;
    
    try {
      const config = readConfig(argv.dir);
      
      logger.info('Starting undo migration process...');
      
      service = new LensService();
      await service.init(argv.dir);
      await service.openSite(config.address);
      
      const runner = new MigrationRunner(argv.dir);
      const appliedMigrations = await runner.getAppliedMigrations();
      
      if (appliedMigrations.length === 0) {
        logger.info('No migrations to undo');
        return;
      }
      
      let migrationsToUndo: string[] = [];
      
      if (argv.all) {
        migrationsToUndo = [...appliedMigrations].reverse();
      } else {
        // Let user select which migration to undo
        const selected = await select({
          message: 'Select migration to undo:',
          choices: appliedMigrations.reverse().map(id => ({
            name: id,
            value: id,
          })),
        });
        
        // Undo this migration and all migrations after it
        const index = appliedMigrations.indexOf(selected);
        migrationsToUndo = appliedMigrations.slice(0, index + 1);
      }
      
      logger.info(`Will undo ${migrationsToUndo.length} migration(s)`);
      
      for (const migrationId of migrationsToUndo) {
        logger.info(`Undoing migration: ${migrationId}`);
        await runner.undo(migrationId, service);
      }
      
      logger.info('Undo complete');
    } catch (error) {
      logger.error('Undo failed:', error);
      process.exit(1);
    } finally {
      if (service) {
        await service.stop();
      }
    }
  },
};