import type { Arguments, CommandModule } from 'yargs';
import { input } from '@inquirer/prompts';
import { LensService } from '@riffcc/lens-sdk';
import { MigrationGenerator } from '../../migrations/generator.js';
import { logger } from '../logger.js';
import { readConfig } from '../utils.js';
import { dirOption } from './commonOptions.js';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

interface GenerateMigrationOptions {
  dir: string;
  fromVersion?: string;
  toVersion?: string;
}

export const generateMigrationCommand: CommandModule<{}, GenerateMigrationOptions> = {
  command: 'generate-migration',
  describe: 'Generate a migration based on differences between database and code',
  builder: (yargs) => {
    return yargs
      .options({
        dir: dirOption,
        'from-version': {
          type: 'string',
          description: 'Source version (defaults to current package version)',
        },
        'to-version': {
          type: 'string',
          description: 'Target version',
        },
      });
  },
  handler: async (argv: Arguments<GenerateMigrationOptions>) => {
    try {
      const config = readConfig(argv.dir);
      
      // Get package version if not specified
      let fromVersion = argv.fromVersion;
      if (!fromVersion) {
        try {
          const packageJsonPath = join(__dirname, '../../../package.json');
          const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf-8'));
          fromVersion = packageJson.dependencies['@riffcc/lens-sdk']?.replace(/[^0-9.]/g, '') || '0.1.32';
        } catch (e) {
          fromVersion = '0.1.32';
        }
      }
      
      let toVersion = argv.toVersion;
      if (!toVersion) {
        toVersion = await input({
          message: 'Enter target version:',
          default: '0.1.33',
        });
      }
      
      logger.info(`Generating migration from v${fromVersion} to v${toVersion}...`);
      
      const service = new LensService();
      
      await service.init(argv.dir);
      await service.openSite(config.address);
      
      const generator = new MigrationGenerator(service);
      await generator.generateMigration(fromVersion || '0.1.32', toVersion);
      
      await service.stop();
      
      logger.info('Migration generation complete');
    } catch (error) {
      logger.error('Failed to generate migration:', error);
      process.exit(1);
    }
  },
};