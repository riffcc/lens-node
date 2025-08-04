import { Router } from 'express';
import { LensService } from '@riffcc/lens-sdk';

export const createReleaseRouter = ({ lensService }: { lensService: LensService }): Router => {
  const router = Router();

  // Route for getting all releases
  router.get('/', async (req, res, next) => {
    try {
      const { category } = req.query;
      let releases = await lensService.getReleases();
      
      // Fetch all categories to resolve display names
      const categories = await lensService.getContentCategories();
      
      // If category filter is provided (as slug), filter releases from all matching categories
      if (category && typeof category === 'string') {
        // Find all category IDs that match the slug
        const matchingCategoryIds = categories
          .filter(cat => cat.categoryId === category)
          .map(cat => cat.id);
        
        // Filter releases by all matching category IDs
        releases = releases.filter(release => 
          matchingCategoryIds.includes(release.categoryId)
        );
      }
      
      const categoryMap = new Map(categories.map(cat => [cat.categoryId, cat]));
      
      // Enhance releases with category information
      const enhancedReleases = releases.map(release => ({
        ...release,
        category: categoryMap.get(release.categoryId) || { 
          categoryId: release.categoryId, 
          displayName: release.categoryId // Fallback to ID if category not found
        }
      }));
      
      res.status(200).json(enhancedReleases);
    } catch (error) {
      next(error); // Pass errors to the global error handler
    }
  });

  router.get('/:id', async (req, res, next) => {
    try {
      const { id } = req.params;
      const release = await lensService.getRelease(id);
      if (!release) {
        return res.status(404).json({ error: 'Release not found' });
      }
      
      // Fetch category to resolve display name
      const category = await lensService.getContentCategory(release.categoryId);
      const enhancedRelease = {
        ...release,
        category: category || { 
          categoryId: release.categoryId, 
          displayName: release.categoryId // Fallback to ID if category not found
        }
      };
      
      res.status(200).json(enhancedRelease);
    } catch (error) {
      next(error);
    }
  });
  return router;
};