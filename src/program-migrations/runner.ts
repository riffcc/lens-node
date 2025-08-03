import { LensService } from '@riffcc/lens-sdk';
import { logger } from '../cli/logger.js';
import path from 'path';
import fs from 'fs/promises';

export interface ProgramMigration {
  id: string;
  description: string;
  // Returns true if migration is needed
  check: (service: LensService) => Promise<boolean>;
  // Performs the migration
  run: (service: LensService, dataDir: string) => Promise<void>;
}

export class ProgramMigrationRunner {
  private migrations: ProgramMigration[] = [];
  private dataDir: string;
  
  constructor(dataDir: string) {
    this.dataDir = dataDir;
  }

  register(migration: ProgramMigration): void {
    this.migrations.push(migration);
  }

  async run(service: LensService): Promise<void> {
    logger.info('Checking for program migrations...');
    
    const migrationsDir = path.join(this.dataDir, '.program-migrations');
    await fs.mkdir(migrationsDir, { recursive: true });
    
    for (const migration of this.migrations) {
      const migrationFile = path.join(migrationsDir, `${migration.id}.done`);
      
      try {
        // Check if migration was already applied
        await fs.access(migrationFile);
        logger.info(`Migration ${migration.id} already applied, skipping`);
        continue;
      } catch {
        // Migration not yet applied
      }
      
      logger.info(`Checking migration: ${migration.id} - ${migration.description}`);
      
      const needed = await migration.check(service);
      if (!needed) {
        logger.info(`Migration ${migration.id} not needed`);
        // Mark as done anyway to avoid checking again
        await fs.writeFile(migrationFile, new Date().toISOString());
        continue;
      }
      
      logger.warn(`APPLYING PROGRAM MIGRATION: ${migration.id}`);
      logger.warn(`Description: ${migration.description}`);
      logger.warn('This is a severe operation that will modify program data structures');
      
      await migration.run(service, this.dataDir);
      
      // Mark migration as completed
      await fs.writeFile(migrationFile, new Date().toISOString());
      logger.info(`Migration ${migration.id} completed successfully`);
    }
    
    logger.info('All program migrations completed');
  }
}