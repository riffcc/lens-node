import { Router } from 'express';
import { LensService } from '@riffcc/lens-sdk';

export const createSubscriptionsRouter = ({ lensService }: { lensService: LensService }): Router => {
  const router = Router();

  // Route for getting all subscriptions
  router.get('/', async (_req, res, next) => {
    try {
      const subscriptions = await lensService.getSubscriptions();
      res.status(200).json(subscriptions);
    } catch (error) {
      next(error);
    }
  });

  return router;
};