import { Router } from 'express';
import { LensService } from '@riffcc/lens-sdk';

export const createFeaturedReleasesRouter = ({ lensService }: { lensService: LensService }): Router => {
  const router = Router();

  // Route for getting all featured releases
  router.get('/', async (_req, res, next) => {
    try {
      const featured = await lensService.getFeaturedReleases();
      res.status(200).json(featured);
    } catch (error) {
      next(error);
    }
  });

  // Route for getting a single featured release by its ID
  router.get('/:id', async (req, res, next) => {
    try {
      const { id } = req.params;
      const featured = await lensService.getFeaturedRelease(id);

      if (featured) {
        res.status(200).json(featured);
      } else {
        res.status(404).json({ error: { message: `Featured release with ID ${id} not found.` } });
      }
    } catch (error) {
      next(error);
    }
  });

  return router;
};