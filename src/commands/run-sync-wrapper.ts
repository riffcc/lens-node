// This file contains the sync wrapper functions for lens-node
// The actual SubscriptionSyncManager is now in lens-sdk

import { SubscriptionSyncManager } from '@riffcc/lens-sdk';
import type { Peerbit } from 'peerbit';
import type { Site, LensService } from '@riffcc/lens-sdk';
import { logger } from '../logger.js';

// Create sync options that integrate with lens-node's logging
export function createSyncOptions(statusManager: any) {
  return {
    onStatusUpdate: (status: string) => statusManager.showMessage(status),
    onError: (error: Error) => logger.error('Sync error', { error: error.message }),
    logger: {
      info: (message: string, data?: any) => logger.info(message, data),
      warn: (message: string, data?: any) => logger.warn(message, data),
      error: (message: string, data?: any) => logger.error(message, data),
      debug: (message: string, data?: any) => logger.debug(message, data),
    }
  };
}

// Helper function to federate new content
export async function federateNewContent(
  localSite: Site, 
  newReleases: any[], 
  siteId: string, 
  siteName?: string, 
  lensService?: LensService
): Promise<number> {
  logger.info('Starting real-time content federation', {
    siteId,
    siteName,
    newReleasesCount: newReleases.length,
  });
  
  if (newReleases.length === 0) return 0;
  
  try {
    // The federation is now handled internally by lens-sdk
    // We'll use the fallback implementation
    let federatedCount = 0;
    for (const release of newReleases) {
      try {
        const result = await lensService?.addRelease({
          ...release,
          federatedFrom: siteId,
          federatedAt: new Date().toISOString(),
          federatedRealtime: true,
        });
        
        if (result?.success) {
          federatedCount++;
        }
      } catch (error) {
        logger.warn('Failed to federate release', {
          releaseId: release.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    
    return federatedCount;
  } catch (error) {
    logger.error('Federation batch failed', {
      siteId,
      error: error instanceof Error ? error.message : String(error),
    });
    return 0;
  }
}

// Setup subscription sync using lens-sdk's SubscriptionSyncManager
export async function setupSubscriptionSync(
  client: Peerbit, 
  localSite: Site, 
  lensService: LensService, 
  subscriptions: any[],
  statusManager: any
) {
  const syncOptions = createSyncOptions(statusManager);
  const syncManager = new SubscriptionSyncManager(client, localSite, lensService, syncOptions);
  await syncManager.setupSubscriptionSync(subscriptions);
  return syncManager;
}

// Setup sync monitoring
export function setupSyncMonitoring(site: Site, lensService: LensService) {
  logger.info('Setting up sync monitoring');
  
  // Monitor releases store events
  site.releases.events.addEventListener('change', (evt: any) => {
    logger.info('releases:change', {
      operation: evt.detail?.operation,
      entries: evt.detail?.entries?.length || 0,
    });
  });
  
  // Monitor featured releases store events
  site.featuredReleases.events.addEventListener('change', (evt: any) => {
    logger.info('featuredReleases:change', {
      operation: evt.detail?.operation,
      entries: evt.detail?.entries?.length || 0,
    });
  });
  
  // Monitor subscriptions store events
  site.subscriptions.events.addEventListener('change', (evt: any) => {
    logger.info('subscriptions:change', {
      operation: evt.detail?.operation,
      entries: evt.detail?.entries?.length || 0,
    });
  });
}