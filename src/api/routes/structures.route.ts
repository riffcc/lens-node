import express, { Router } from 'express';
import type { LensService } from '@riffcc/lens-sdk';

export function createStructuresRouter({ lensService }: { lensService: LensService }): Router {
  const router = express.Router();

  // GET /api/v1/structures
  router.get('/', async (_req, res, next) => {
    try {
      const structures = await lensService.getStructures();
      const parsed = structures.map(s => ({
        ...s,
        metadata: s.metadata ? JSON.parse(s.metadata) : undefined,
      }));
      res.json(parsed);
    } catch (error) {
      next(error);
    }
  });

  // GET /api/v1/structures/:id
  router.get('/:id', async (req, res, next) => {
    try {
      const structure = await lensService.getStructure(req.params.id);
      if (!structure) {
        return res.status(404).json({ error: 'Structure not found' });
      }
      const parsed = {
        ...structure,
        metadata: structure.metadata ? JSON.parse(structure.metadata) : undefined,
      };
      res.json(parsed);
    } catch (error) {
      next(error);
    }
  });

  return router;
}