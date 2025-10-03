import { Router } from 'express';
import { LensService } from '@riffcc/lens-sdk';

export const createStatusRouter = ({ lensService }: { lensService: LensService }): Router => {
  const router = Router();

  // Status endpoint showing detailed sync information
  router.get('/', async (req, res, next) => {
    try {
      // TODO: Restore getSyncDetails() and getPeerCount() when available in lens-sdk
      const syncDetails = { stores: [], synced: true };
      const peerCount = 0;
      
      // Get actual API counts for comparison
      let apiCounts = {
        releases: 0,
        featuredReleases: 0,
        contentCategories: 0,
        structures: 0,
        subscriptions: 0
      };
      
      try {
        const [releases, featured, categories, structures, subscriptions] = await Promise.all([
          lensService.getReleases(),
          lensService.getFeaturedReleases(), 
          lensService.getContentCategories(),
          lensService.getStructures ? lensService.getStructures() : Promise.resolve([]),
          lensService.getSubscriptions()
        ]);
        
        apiCounts = {
          releases: releases.length,
          featuredReleases: featured.length,
          contentCategories: categories.length,
          structures: structures.length,
          subscriptions: subscriptions.length
        };
      } catch (error) {
        console.warn('Could not get all API counts for status:', error);
      }
      
      // Enhanced store info with API comparison
      const enhancedStores = syncDetails.stores.map((store: any) => {
        const apiCount = apiCounts[store.name as keyof typeof apiCounts] || 0;
        
        return {
          ...store,
          apiCount,
          countMatch: store.count === apiCount,
          // Include debug info if available
          ...(store.localCount !== undefined && {
            localCount: store.localCount,
            networkAccessibleCount: store.networkAccessibleCount
          })
        };
      });
      
      res.status(200).json({
        synced: syncDetails.synced,
        peerCount,
        stores: enhancedStores,
        summary: {
          totalStores: enhancedStores.length,
          syncingStores: enhancedStores.filter((s: any) => s.replicating).length,
          readyStores: enhancedStores.filter((s: any) => !s.replicating).length,
          countMismatches: enhancedStores.filter((s: any) => !s.countMatch).length
        },
        timestamp: new Date().toISOString(),
        uptime: process.uptime()
      });
    } catch (error) {
      next(error);
    }
  });

  return router;
};