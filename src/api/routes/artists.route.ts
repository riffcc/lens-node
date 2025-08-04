import { Router } from 'express';
import { LensService } from '@riffcc/lens-sdk';

export const createArtistsRouter = ({ lensService }: { lensService: LensService }): Router => {
  const router = Router();

  // Route for getting all artists
  router.get('/', async (_req, res, next) => {
    try {
      const artists = await lensService.getArtists();
      res.status(200).json(artists);
    } catch (error) {
      next(error);
    }
  });

  // Route for getting a single artist by ID
  router.get('/:id', async (req, res, next) => {
    try {
      const { id } = req.params;
      const artist = await lensService.getArtist(id);
      
      if (!artist) {
        return res.status(404).json({ error: 'Artist not found' });
      }
      
      res.status(200).json(artist);
    } catch (error) {
      next(error);
    }
  });

  // Route for getting all releases by an artist
  router.get('/:id/releases', async (req, res, next) => {
    try {
      const { id } = req.params;
      
      // First check if artist exists
      const artist = await lensService.getArtist(id);
      if (!artist) {
        return res.status(404).json({ error: 'Artist not found' });
      }
      
      // Get all releases and filter by artist ID
      const allReleases = await lensService.getReleases();
      const artistReleases = allReleases.filter(release => {
        // Access the actual release data which contains artistIds
        const releaseData = release as any; // Type assertion since WithContext doesn't expose all fields
        return releaseData.artistIds && releaseData.artistIds.includes(id);
      });
      
      // Fetch categories to enhance the response
      const categories = await lensService.getContentCategories();
      const categoryMap = new Map(categories.map(cat => [cat.categoryId, cat]));
      
      const enhancedReleases = artistReleases.map(release => ({
        ...release,
        category: categoryMap.get(release.categoryId) || { 
          categoryId: release.categoryId, 
          displayName: release.categoryId
        }
      }));
      
      res.status(200).json({
        artist,
        releases: enhancedReleases
      });
    } catch (error) {
      next(error);
    }
  });

  // Route for creating a new artist
  router.post('/', async (req, res, next) => {
    try {
      const result = await lensService.addArtist(req.body);
      
      if (!result.success) {
        return res.status(400).json({ error: result.error });
      }
      
      res.status(201).json(result);
    } catch (error) {
      next(error);
    }
  });

  // Route for updating an artist
  router.put('/:id', async (req, res, next) => {
    try {
      const { id } = req.params;
      const result = await lensService.editArtist({ ...req.body, id });
      
      if (!result.success) {
        return res.status(400).json({ error: result.error });
      }
      
      res.status(200).json(result);
    } catch (error) {
      next(error);
    }
  });

  // Route for deleting an artist
  router.delete('/:id', async (req, res, next) => {
    try {
      const { id } = req.params;
      const result = await lensService.deleteArtist(id);
      
      if (!result.success) {
        return res.status(400).json({ error: result.error });
      }
      
      res.status(200).json(result);
    } catch (error) {
      next(error);
    }
  });

  return router;
};