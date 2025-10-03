import { ProgramMigrationRunner } from './runner.js';
// import { fixRbacTypoMigration } from './001-fix-rbac-typo';

export function createProgramMigrationRunner(dataDir: string): ProgramMigrationRunner {
  const runner = new ProgramMigrationRunner(dataDir);
  
  // Register all program migrations in order
  // runner.register(fixRbacTypoMigration);
  
  // Add future program migrations here
  
  return runner;
}

export { ProgramMigrationRunner } from './runner.js';
export type { ProgramMigration } from './runner.js';