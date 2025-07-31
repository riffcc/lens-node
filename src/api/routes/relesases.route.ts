import { Router } from 'express';
import { LensService } from '@riffcc/lens-sdk';

export const createReleaseRouter = ({ lensService }: { lensService: LensService }): Router => {
  const router = Router();

  // Route for getting all releases
  router.get('/', async (_req, res, next) => {
    try {
      const releases = await lensService.getReleases();
      res.status(200).json(releases);
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
    res.status(200).json(release);
  } catch (error) {
    next(error);
  }
});
  return router;
};