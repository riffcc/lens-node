import express, { Router } from 'express';
import { LensService } from '@riffcc/lens-sdk';

export function createAdminRouter(lensService: LensService): Router {
  const router = express.Router();

  // POST /api/v1/admin/authorize - Authorize a user (grant admin or role)
  router.post('/authorize', async (req, res, next) => {
    try {
      const { publicKey, role } = req.body;

      if (!publicKey) {
        return res.status(400).json({ error: 'publicKey is required' });
      }

      let result;
      if (role) {
        // Assign role
        result = await lensService.assignRole(publicKey, role);
      } else {
        // Grant admin access
        result = await lensService.addAdmin(publicKey);
      }

      if (result.success) {
        res.json({
          success: true,
          publicKey,
          role: role || 'admin',
        });
      } else {
        res.status(400).json({
          success: false,
          error: result.error || 'Authorization failed',
        });
      }
    } catch (error) {
      next(error);
    }
  });

  // TODO: POST /api/v1/admin/revoke - Revoke admin or role
  // Implement when removeAdmin/revokeRole methods are available in LensService

  // PATCH /api/v1/admin/releases/:id - Update a release (e.g., fix corrupted categoryId)
  router.patch('/releases/:id', async (req, res, next) => {
    try {
      const { id } = req.params;
      const updates = req.body;

      if (!id) {
        return res.status(400).json({ error: 'Release ID is required' });
      }

      // Get the existing release
      const releases = await lensService.getReleases();
      const release = releases.find(r => r.id === id);

      if (!release) {
        return res.status(404).json({ error: 'Release not found' });
      }

      // Update the release using editRelease
      const result = await lensService.editRelease({
        ...release,
        ...updates,
      });

      if (result.success) {
        // Fetch the updated release
        const updatedReleases = await lensService.getReleases();
        const updatedRelease = updatedReleases.find(r => r.id === id);

        res.json({
          success: true,
          release: updatedRelease,
        });
      } else {
        res.status(400).json({
          success: false,
          error: result.error || 'Failed to update release',
        });
      }
    } catch (error) {
      next(error);
    }
  });

  return router;
}
