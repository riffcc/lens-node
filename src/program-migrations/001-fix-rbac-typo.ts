import type { ProgramMigration } from './runner.js';
import { logger } from '../cli/logger.js';

/**
 * Migration to fix the RoleBasedccessController typo.
 * This is a SEVERE migration that requires recreating the access control store.
 * 
 * The typo "RoleBasedccessController" -> "RoleBasedAccessController" prevents
 * the program from loading when using the fixed SDK version.
 */
export const fixRbacTypoMigration: ProgramMigration = {
  id: '001-fix-rbac-typo',
  description: 'Fix RoleBasedccessController typo in access control system',
  
  async check(service) {
    // Check if the service has a loaded site program
    const site = (service as any).siteProgram;
    
    // If there's no site program, it likely failed to load due to the RBAC issue
    if (!site) {
      logger.warn('No site program loaded - likely due to RBAC deserialization issue');
      // Double-check by looking at the data directory for the specific store
      // For now, assume it needs migration if site didn't load
      return true;
    }
    
    // If site loaded successfully, no migration needed
    logger.debug('Site program loaded successfully, no migration needed');
    return false;
  },
  
  async run(service, dataDir) {
    logger.error('CRITICAL: RoleBasedccessController typo migration');
    logger.error('This migration requires manual intervention.');
    logger.error('');
    logger.error('The program cannot automatically migrate this data because:');
    logger.error('1. The typo prevents the store from loading');
    logger.error('2. The access controller manages critical permissions');
    logger.error('');
    logger.error('OPTIONS:');
    logger.error('');
    logger.error('Option 1: Fresh deployment (RECOMMENDED for new sites)');
    logger.error('  1. Stop this node');
    logger.error('  2. Delete the data directory: ' + dataDir);
    logger.error('  3. Run "lens-node setup" to create a fresh site');
    logger.error('  4. Re-import any necessary data');
    logger.error('');
    logger.error('Option 2: Temporary compatibility mode');
    logger.error('  1. Deploy a version with the typo intact');
    logger.error('  2. Export all data');
    logger.error('  3. Deploy the fixed version');
    logger.error('  4. Import the exported data');
    logger.error('');
    logger.error('Option 3: Wait for compatibility layer');
    logger.error('  A future SDK version may include a compatibility layer');
    logger.error('  to handle this migration automatically');
    
    throw new Error('Manual intervention required - see instructions above');
  }
};