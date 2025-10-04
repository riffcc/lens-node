import type { Arguments, CommandModule } from 'yargs';
import { logger } from '../logger.js';
import { dirOption } from './commonOptions.js';

interface AuthorizeOptions {
  dir: string;
  publicKey: string;
  role?: string;
  apiPort?: number;
  apiHost?: string;
}

interface AuthorizeApiResponse {
  success: boolean;
  error?: string;
  publicKey?: string;
  role?: string;
}

export const authorizeCommand: CommandModule<{}, AuthorizeOptions> = {
  command: 'authorize <publicKey>',
  describe: 'Authorize an account (grant admin or role)',
  builder: (yargs) => {
    return yargs
      .positional('publicKey', {
        type: 'string',
        describe: 'Public key of the account to authorize',
        demandOption: true,
      })
      .options({
        dir: dirOption,
        role: {
          type: 'string',
          describe: 'Role to assign (if not specified, grants admin access)',
        },
        apiPort: {
          type: 'number',
          describe: 'Port of the running lens-node API',
          default: 5002,
        },
        apiHost: {
          type: 'string',
          describe: 'Host of the running lens-node API',
          default: '127.0.0.1',
        },
      });
  },
  handler: async (argv: Arguments<AuthorizeOptions>) => {
    try {
      logger.info('Starting authorization...');
      logger.info(`Public key: ${argv.publicKey}`);

      const apiUrl = `http://${argv.apiHost}:${argv.apiPort}/api/v1/admin/authorize`;

      const response = await fetch(apiUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          publicKey: argv.publicKey,
          role: argv.role,
        }),
      });

      const result = await response.json() as AuthorizeApiResponse;

      if (response.ok && result.success) {
        if (argv.role) {
          logger.info(`✅ Successfully assigned role '${argv.role}' to account.`, {
            publicKey: argv.publicKey,
            role: argv.role,
          });
        } else {
          logger.info('✅ Account promoted to Admin successfully.', {
            publicKey: argv.publicKey,
          });
        }
        logger.info('Authorization completed successfully!');
      } else {
        logger.error(`❌ Authorization failed: ${result.error || 'Unknown error'}`);
        process.exit(1);
      }
    } catch (error) {
      logger.error('Authorization failed:', error);
      logger.error('Make sure the lens-node is running and accessible.');
      process.exit(1);
    }
  },
};
