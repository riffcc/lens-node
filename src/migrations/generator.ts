import { LensService, ContentCategory, defaultSiteContentCategories } from '@riffcc/lens-sdk';
import { logger } from '../cli/logger.js';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { select, input } from '@inquirer/prompts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

interface MigrationChange {
  type: 'add-field' | 'remove-field' | 'update-field' | 'add-category' | 'remove-category' | 'rename-field';
  categoryId: string;
  field?: string;
  oldField?: string; // For rename operations
  newField?: string; // For rename operations
  oldValue?: any;
  newValue?: any;
}

export class MigrationGenerator {
  constructor(private service: LensService) {}

  public async detectChanges(interactive: boolean = false): Promise<MigrationChange[]> {
    const changes: MigrationChange[] = [];
    
    // Get current categories from the database
    const currentCategories = await this.service.getContentCategories();
    
    // Create a map for easier lookup
    const currentCategoriesMap = new Map(
      currentCategories.map(cat => [cat.categoryId, cat])
    );
    
    // Check each default category
    for (const defaultCategory of defaultSiteContentCategories) {
      const currentCategory = currentCategoriesMap.get(defaultCategory.categoryId);
      
      if (!currentCategory) {
        // Category doesn't exist in database
        changes.push({
          type: 'add-category',
          categoryId: defaultCategory.categoryId,
          newValue: defaultCategory
        });
        continue;
      }
      
      // Parse the metadata schemas
      let currentSchema: any = {};
      let defaultSchema: any = defaultCategory.metadataSchema || {};
      
      try {
        currentSchema = currentCategory.metadataSchema ? JSON.parse(currentCategory.metadataSchema) : {};
      } catch (e) {
        logger.error(`Failed to parse current schema for ${defaultCategory.categoryId}:`, e);
      }
      
      // Compare schemas field by field
      const allFields = new Set([...Object.keys(currentSchema), ...Object.keys(defaultSchema)]);
      
      // Debug logging for author field
      if (defaultCategory.categoryId === 'music' || defaultCategory.categoryId === 'movies') {
        logger.info(`\nChecking ${defaultCategory.categoryId}:`);
        logger.info(`  Current fields: ${Object.keys(currentSchema).join(', ')}`);
        logger.info(`  Default fields: ${Object.keys(defaultSchema).join(', ')}`);
        logger.info(`  Has author in current: ${'author' in currentSchema}`);
        logger.info(`  Has author in default: ${'author' in defaultSchema}`);
      }
      
      for (const field of allFields) {
        if (!(field in currentSchema) && field in defaultSchema) {
          // Field missing in current schema
          changes.push({
            type: 'add-field',
            categoryId: defaultCategory.categoryId,
            field,
            newValue: defaultSchema[field]
          });
        } else if (field in currentSchema && !(field in defaultSchema)) {
          // Field exists in current but not in default
          if (interactive) {
            logger.info(`\nField '${field}' exists in category '${defaultCategory.categoryId}' but not in defaults.`);
            
            const action = await select({
              message: `What would you like to do with field '${field}'?`,
              choices: [
                { name: `Rename to an existing field in the schema`, value: 'rename-existing' },
                { name: `Rename to a new field name`, value: 'rename-new' },
                { name: `Remove the field entirely`, value: 'remove' },
                { name: `Keep the field (skip)`, value: 'skip' }
              ]
            });
            
            if (action === 'rename-existing') {
              const availableFields = Object.keys(defaultSchema);
              const targetField = await select({
                message: `Select the target field to rename '${field}' to:`,
                choices: availableFields.map(f => ({ name: f, value: f }))
              });
              
              changes.push({
                type: 'rename-field',
                categoryId: defaultCategory.categoryId,
                oldField: field,
                newField: targetField,
                oldValue: currentSchema[field],
                newValue: defaultSchema[targetField]
              });
            } else if (action === 'rename-new') {
              const newFieldName = await input({
                message: `Enter the new field name:`,
                validate: (value) => value.length > 0 ? true : 'Field name cannot be empty'
              });
              
              changes.push({
                type: 'rename-field',
                categoryId: defaultCategory.categoryId,
                oldField: field,
                newField: newFieldName,
                oldValue: currentSchema[field]
              });
            } else if (action === 'remove') {
              changes.push({
                type: 'remove-field',
                categoryId: defaultCategory.categoryId,
                field,
                oldValue: currentSchema[field]
              });
            }
            // 'skip' action - do nothing
          } else {
            // Non-interactive mode - just log warning
            logger.warn(`Field '${field}' exists in category '${defaultCategory.categoryId}' but not in defaults`);
          }
        } else if (field in currentSchema && field in defaultSchema) {
          // Check if field definition changed
          if (JSON.stringify(currentSchema[field]) !== JSON.stringify(defaultSchema[field])) {
            changes.push({
              type: 'update-field',
              categoryId: defaultCategory.categoryId,
              field,
              oldValue: currentSchema[field],
              newValue: defaultSchema[field]
            });
          }
        }
      }
      
      // Mark for deletion
      currentCategoriesMap.delete(defaultCategory.categoryId);
    }
    
    // Check for categories that exist in database but not in defaults
    for (const [categoryId, category] of currentCategoriesMap) {
      logger.warn(`Category '${categoryId}' exists in database but not in defaults`);
    }
    
    return changes;
  }

  public async applyChanges(changes: MigrationChange[]): Promise<void> {
    const categories = await this.service.getContentCategories();
    const categoryMap = new Map(categories.map(cat => [cat.categoryId, cat]));
    
    // Group changes by category for efficiency
    const changesByCategory = new Map<string, MigrationChange[]>();
    for (const change of changes) {
      if (!changesByCategory.has(change.categoryId)) {
        changesByCategory.set(change.categoryId, []);
      }
      changesByCategory.get(change.categoryId)!.push(change);
    }
    
    // Apply changes to each category
    for (const [categoryId, categoryChanges] of changesByCategory) {
      const category = categoryMap.get(categoryId);
      if (!category) {
        logger.warn(`Category ${categoryId} not found, skipping`);
        continue;
      }
      
      // Parse the current schema
      let schema: Record<string, any> = {};
      try {
        schema = category.metadataSchema ? JSON.parse(category.metadataSchema) : {};
      } catch (e) {
        logger.error(`Failed to parse schema for category ${categoryId}:`, e);
        continue;
      }
      
      // Apply each change to the schema
      for (const change of categoryChanges) {
        switch (change.type) {
          case 'add-field':
            if (change.field && change.newValue) {
              schema[change.field] = change.newValue;
              logger.info(`Added field '${change.field}' to category '${categoryId}'`);
            }
            break;
            
          case 'remove-field':
            if (change.field && change.field in schema) {
              delete schema[change.field];
              logger.info(`Removed field '${change.field}' from category '${categoryId}'`);
            }
            break;
            
          case 'update-field':
            if (change.field && change.newValue) {
              schema[change.field] = change.newValue;
              logger.info(`Updated field '${change.field}' in category '${categoryId}'`);
            }
            break;
            
          case 'rename-field':
            if (change.oldField && change.newField) {
              // If renaming to an existing field, we need to handle metadata migration
              if (change.oldField in schema) {
                schema[change.newField] = change.newValue || schema[change.oldField];
                delete schema[change.oldField];
                logger.info(`Renamed field '${change.oldField}' to '${change.newField}' in category '${categoryId}'`);
                
                // TODO: Also update all releases with this category to rename the metadata field
                logger.warn(`Note: Existing release metadata still uses field '${change.oldField}' and needs to be migrated`);
              }
            }
            break;
        }
      }
      
      // Update the category with the new schema
      try {
        const result = await this.service.editContentCategory({
          id: category.id,
          categoryId: category.categoryId,
          displayName: category.displayName,
          featured: category.featured,
          metadataSchema: JSON.stringify(schema),
          postedBy: category.postedBy,
          siteAddress: category.siteAddress,
        });
        
        if (result.success) {
          logger.info(`Successfully updated category '${categoryId}'`);
        } else {
          logger.error(`Failed to update category '${categoryId}': ${result.error}`);
        }
      } catch (error) {
        logger.error(`Error updating category '${categoryId}':`, error);
      }
    }
  }

  async generateMigration(fromVersion: string, toVersion: string): Promise<void> {
    // Use interactive mode for migration generation
    const changes = await this.detectChanges(true);
    
    if (changes.length === 0) {
      logger.info('No changes detected, no migration needed');
      return;
    }
    
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const migrationId = `${timestamp}_v${fromVersion.replace(/\./g, '-')}_to_v${toVersion.replace(/\./g, '-')}`;
    const filename = `${migrationId}.migration.ts`;
    
    // Store migrations in the lens-node migrations directory
    const projectRoot = path.resolve(__dirname, '../..');
    const migrationsDir = path.join(projectRoot, 'migrations');
    
    // Ensure migrations directory exists
    await fs.mkdir(migrationsDir, { recursive: true });
    
    const filepath = path.join(migrationsDir, filename);
    
    const migrationCode = this.generateMigrationCode(migrationId, fromVersion, toVersion, changes);
    await fs.writeFile(filepath, migrationCode);
    
    logger.info(`Generated migration: ${filename}`);
    logger.info(`Changes detected: ${changes.length}`);
    changes.forEach(change => {
      logger.info(`  - ${change.type} ${change.categoryId}${change.field ? `.${change.field}` : ''}`);
    });
  }

  private generateMigrationCode(id: string, fromVersion: string, toVersion: string, changes: MigrationChange[]): string {
    const changeSummary = changes.map(c => 
      `${c.type} ${c.categoryId}${c.field ? `.${c.field}` : ''}`
    ).join(', ');
    
    return `import type { Migration } from '../dist/migrations/runner.js';
import { LensService } from '@riffcc/lens-sdk';
import winston from 'winston';

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.simple(),
  transports: [new winston.transports.Console()]
});

/**
 * Migration from v${fromVersion} to v${toVersion}
 * Changes: ${changeSummary}
 */
const migration: Migration = {
  id: '${id}',
  description: 'Update content category schemas from v${fromVersion} to v${toVersion}',
  
  async up(service: LensService): Promise<void> {
    const site = service.siteProgram;
    if (!site) {
      throw new Error('Site not initialized');
    }
    
    // Get current categories
    const categories = await service.getContentCategories();
    
${changes.map(change => this.generateChangeCode(change, 'up')).join('\n')}
    
    logger.info('Content category schemas updated successfully');
  },
  
  async down(service: LensService): Promise<void> {
    const site = service.siteProgram;
    if (!site) {
      throw new Error('Site not initialized');
    }
    
    // Get current categories
    const categories = await service.getContentCategories();
    
${changes.reverse().map(change => this.generateChangeCode(change, 'down')).join('\n')}
    
    logger.info('Content category schemas reverted successfully');
  }
};

export default migration;`;
  }

  private generateChangeCode(change: MigrationChange, direction: 'up' | 'down' = 'up'): string {
    // For down migrations, reverse the operations
    if (direction === 'down') {
      switch (change.type) {
        case 'add-field':
          // Remove the field in down migration
          return this.generateChangeCode({ ...change, type: 'remove-field' }, 'up');
        case 'remove-field':
          // Add the field back in down migration
          return this.generateChangeCode({ 
            ...change, 
            type: 'add-field',
            newValue: change.oldValue 
          }, 'up');
        case 'rename-field':
          // Reverse the rename
          return this.generateChangeCode({
            ...change,
            oldField: change.newField,
            newField: change.oldField,
            oldValue: change.newValue,
            newValue: change.oldValue
          }, 'up');
        case 'update-field':
          // Revert to old value
          return this.generateChangeCode({
            ...change,
            oldValue: change.newValue,
            newValue: change.oldValue
          }, 'up');
        default:
          return `    // Cannot undo ${change.type} for ${change.categoryId}`;
      }
    }
    
    switch (change.type) {
      case 'add-field':
        return `    // Add field '${change.field}' to category '${change.categoryId}'
    {
      const category = categories.find(c => c.categoryId === '${change.categoryId}');
      if (category) {
        try {
          const schema = category.metadataSchema ? JSON.parse(category.metadataSchema) : {};
          schema['${change.field}'] = ${JSON.stringify(change.newValue, null, 2).split('\n').join('\n          ')};
          
          // Update the category with new schema
          const result = await service.editContentCategory({
            id: category.id,
            categoryId: category.categoryId,
            displayName: category.displayName,
            featured: category.featured,
            metadataSchema: JSON.stringify(schema),
            postedBy: category.postedBy,
            siteAddress: category.siteAddress,
          });
          
          if (result.success) {
            logger.info('Added field ${change.field} to category ${change.categoryId}');
          } else {
            logger.error('Failed to add field ${change.field} to category ${change.categoryId}:', result.error);
          }
        } catch (e) {
          logger.error('Failed to update category ${change.categoryId}:', e);
        }
      }
    }`;
      
      case 'update-field':
        return `    // Update field '${change.field}' in category '${change.categoryId}'
    {
      const category = categories.find(c => c.categoryId === '${change.categoryId}');
      if (category) {
        try {
          const schema = category.metadataSchema ? JSON.parse(category.metadataSchema) : {};
          schema['${change.field}'] = ${JSON.stringify(change.newValue, null, 2).split('\n').join('\n          ')};
          
          // Update the category with new schema
          const result = await service.editContentCategory({
            id: category.id,
            categoryId: category.categoryId,
            displayName: category.displayName,
            featured: category.featured,
            metadataSchema: JSON.stringify(schema),
            postedBy: category.postedBy,
            siteAddress: category.siteAddress,
          });
          
          if (result.success) {
            logger.info('Updated field ${change.field} in category ${change.categoryId}');
          } else {
            logger.error('Failed to update field ${change.field} in category ${change.categoryId}:', result.error);
          }
        } catch (e) {
          logger.error('Failed to update category ${change.categoryId}:', e);
        }
      }
    }`;
      
      case 'remove-field':
        return `    // Remove field '${change.field}' from category '${change.categoryId}'
    {
      const category = categories.find(c => c.categoryId === '${change.categoryId}');
      if (category) {
        try {
          const schema = category.metadataSchema ? JSON.parse(category.metadataSchema) : {};
          delete schema['${change.field}'];
          
          // Update the category with new schema
          const result = await service.editContentCategory({
            id: category.id,
            categoryId: category.categoryId,
            displayName: category.displayName,
            featured: category.featured,
            metadataSchema: JSON.stringify(schema),
            postedBy: category.postedBy,
            siteAddress: category.siteAddress,
          });
          
          if (result.success) {
            logger.info('Removed field ${change.field} from category ${change.categoryId}');
          } else {
            logger.error('Failed to remove field ${change.field} from category ${change.categoryId}:', result.error);
          }
        } catch (e) {
          logger.error('Failed to update category ${change.categoryId}:', e);
        }
      }
    }`;
      
      case 'add-category':
        return `    // Add new category '${change.categoryId}'
    {
      // This would require implementing addContentCategory in the SDK
      logger.info('Would add category ${change.categoryId}');
    }`;
      
      default:
        return `    // ${change.type} for ${change.categoryId}`;
    }
  }
}