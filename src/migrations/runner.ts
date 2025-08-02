import { LensService } from '@riffcc/lens-sdk';
import { logger } from '../cli/logger.js';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export interface Migration {
  id: string;
  description: string;
  up: (service: LensService) => Promise<void>;
  down?: (service: LensService) => Promise<void>;
}

export class MigrationRunner {
  private migrations: Migration[] = [];
  private appliedMigrationsFile: string;

  constructor(private dataDir: string) {
    this.appliedMigrationsFile = path.join(dataDir, 'applied-migrations.json');
  }

  async loadMigrations(): Promise<void> {
    // Look for migrations in the lens-node migrations directory
    const projectRoot = path.resolve(__dirname, '../..');
    const migrationsDir = path.join(projectRoot, 'migrations');
    
    // Ensure directory exists
    await fs.mkdir(migrationsDir, { recursive: true });
    
    const files = await fs.readdir(migrationsDir);
    
    for (const file of files) {
      if (file.endsWith('.migration.ts')) {
        const migrationModule = await import(path.join(migrationsDir, file));
        if (migrationModule.default && migrationModule.default.id) {
          this.migrations.push(migrationModule.default);
        }
      }
    }
    
    // Sort migrations by ID (assuming ID is a timestamp or sequential number)
    this.migrations.sort((a, b) => a.id.localeCompare(b.id));
    
    logger.info(`Loaded ${this.migrations.length} migrations`);
  }

  async getAppliedMigrations(): Promise<string[]> {
    try {
      const data = await fs.readFile(this.appliedMigrationsFile, 'utf-8');
      return JSON.parse(data);
    } catch (error) {
      // File doesn't exist, no migrations applied yet
      return [];
    }
  }

  async saveAppliedMigration(migrationId: string): Promise<void> {
    const applied = await this.getAppliedMigrations();
    if (!applied.includes(migrationId)) {
      applied.push(migrationId);
      await fs.writeFile(this.appliedMigrationsFile, JSON.stringify(applied, null, 2));
    }
  }
  
  async removeAppliedMigration(migrationId: string): Promise<void> {
    const applied = await this.getAppliedMigrations();
    const filtered = applied.filter(id => id !== migrationId);
    await fs.writeFile(this.appliedMigrationsFile, JSON.stringify(filtered, null, 2));
  }

  async run(service: LensService): Promise<void> {
    await this.loadMigrations();
    const applied = await this.getAppliedMigrations();
    
    for (const migration of this.migrations) {
      if (!applied.includes(migration.id)) {
        logger.info(`Running migration: ${migration.id} - ${migration.description}`);
        
        try {
          await migration.up(service);
          await this.saveAppliedMigration(migration.id);
          logger.info(`Migration ${migration.id} completed successfully`);
        } catch (error) {
          logger.error(`Migration ${migration.id} failed:`, error);
          throw error;
        }
      }
    }
    
    logger.info('All migrations completed');
  }
  
  async undo(migrationId: string, service: LensService): Promise<void> {
    await this.loadMigrations();
    const migration = this.migrations.find(m => m.id === migrationId);
    
    if (!migration) {
      throw new Error(`Migration ${migrationId} not found`);
    }
    
    if (!migration.down) {
      throw new Error(`Migration ${migrationId} does not support undo (no down method)`);
    }
    
    const applied = await this.getAppliedMigrations();
    if (!applied.includes(migrationId)) {
      logger.warn(`Migration ${migrationId} is not in the applied list, skipping`);
      return;
    }
    
    logger.info(`Undoing migration: ${migration.id} - ${migration.description}`);
    
    try {
      await migration.down(service);
      await this.removeAppliedMigration(migrationId);
      logger.info(`Migration ${migrationId} undone successfully`);
    } catch (error) {
      logger.error(`Failed to undo migration ${migrationId}:`, error);
      throw error;
    }
  }
}