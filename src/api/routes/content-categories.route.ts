import { Router } from 'express';
import { LensService } from '@riffcc/lens-sdk';

export const createCategoriesRouter = ({ lensService }: { lensService: LensService }): Router => {
  const router = Router();

  // Route for getting all content categories
  router.get('/', async (_req, res, next) => {
    try {
      const categories = await lensService.getContentCategories();
      
      // Merge duplicate categories from different lenses
      const categoryMap = new Map();
      
      for (const category of categories) {
        const key = category.categoryId; // Use slug as key
        if (!categoryMap.has(key)) {
          // First occurrence - use as base and track all IDs
          categoryMap.set(key, {
            ...category,
            allIds: [category.id]
          });
        } else {
          // Duplicate - merge the IDs
          const existing = categoryMap.get(key);
          existing.allIds.push(category.id);
        }
      }
      
      // Return merged categories
      res.status(200).json(Array.from(categoryMap.values()));
    } catch (error) {
      next(error);
    }
  });

  // Route for getting a single content category by its ID
  router.get('/:id', async (req, res, next) => {
    try {
      const { id } = req.params;
      const category = await lensService.getContentCategory(id);

      if (category) {
        res.status(200).json(category);
      } else {
        res.status(404).json({ error: { message: `Category with ID ${id} not found.` } });
      }
    } catch (error) {
      next(error);
    }
  });

  return router;
};