import { Router } from 'express';
import { LensService } from '@riffcc/lens-sdk';

export const createCategoriesRouter = ({ lensService }: { lensService: LensService }): Router => {
  const router = Router();

  // Route for getting all content categories
  router.get('/', async (_req, res, next) => {
    try {
      const categories = await lensService.getContentCategories();
      res.status(200).json(categories);
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