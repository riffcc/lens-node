import { LensService } from '@riffcc/lens-sdk';
import express, { Application, ErrorRequestHandler } from 'express';
import cors from 'cors';
import { HttpError } from 'http-errors';
import {
  createReleaseRouter,
  createFeaturedReleasesRouter,
  createCategoriesRouter,
  createSubscriptionsRouter,
  createArtistsRouter,
  createStructuresRouter
} from './routes/index.js';
import { createStatusRouter } from './routes/status.route.js';

// =========================================================================
//  >>> THE FIX: Teach JSON how to serialize BigInt <<<
// This patch is needed because JSON.stringify() doesn't support BigInt by default.
// We are telling it to convert any BigInt to a string before serializing.
// Place this at the top level of your server entry file. It only needs to run once.
(BigInt.prototype as any).toJSON = function () {
  return this.toString();
};
// =========================================================================


export function startServer({ lensService, bindHost = '127.0.0.1', apiPort = 5002 }: { lensService: LensService; bindHost?: string; apiPort?: number }): Application {
  const app = express();
  const port = Number(process.env.PORT) || apiPort;

  // --- Middleware ---
  app.use(cors());
  app.use(express.json());

  // --- API Routes ---
  const apiRouter = express.Router();

  apiRouter.get('/health', (_req, res) => {
    res.status(200).json({
      status: 'ok',
      message: 'Lens API is running',
      timestamp: new Date().toISOString()
    });
  });


  apiRouter.get('/ready', async (_req, res) => {
    try {
      // Add timeout to prevent hanging
      const timeoutPromise = new Promise((_, reject) => {
        setTimeout(() => reject(new Error('Sync check timeout')), 5000);
      });
      
      // TODO: Restore getSyncDetails() and getPeerCount() when available in lens-sdk
      const syncDetails = { stores: [], synced: true };
      const peerCount = 0;
      
      // For accuracy, also get the actual API counts that users would see
      let apiReleasesCount = 0;
      let apiFeaturedCount = 0;
      let apiCategoriesCount = 0;
      
      try {
        const releases = await lensService.getReleases();
        apiReleasesCount = releases.length;
        
        const featured = await lensService.getFeaturedReleases();
        apiFeaturedCount = featured.length;
        
        const categories = await lensService.getContentCategories();
        apiCategoriesCount = categories.length;
      } catch (error) {
        console.warn('Could not get API counts for ready check:', error);
      }
      
      // Update store counts to match what the API actually serves
      const adjustedStores = syncDetails.stores.map((store: any) => {
        if (store.name === 'releases' && apiReleasesCount > 0) {
          return { ...store, count: apiReleasesCount, apiVerifiedCount: true };
        } else if (store.name === 'featuredReleases' && apiFeaturedCount > 0) {
          return { ...store, count: apiFeaturedCount, apiVerifiedCount: true };
        } else if (store.name === 'contentCategories' && apiCategoriesCount > 0) {
          return { ...store, count: apiCategoriesCount, apiVerifiedCount: true };
        }
        return store;
      });
      
      // Log details for debugging
      console.log('Sync status check:', {
        synced: syncDetails.synced,
        peerCount,
        stores: adjustedStores.map((s: any) => ({
          name: s.name,
          replicating: s.replicating,
          count: s.count
        }))
      });
      
      res.status(syncDetails.synced ? 200 : 503).json({
        ready: syncDetails.synced,
        peerCount,
        stores: adjustedStores,
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      console.error('Error checking sync status:', error);
      res.status(500).json({
        ready: false,
        error: error instanceof Error ? error.message : 'Failed to check sync status',
        timestamp: new Date().toISOString()
      });
    }
  });

  apiRouter.use('/releases', createReleaseRouter({ lensService }));
  apiRouter.use('/featured-releases', createFeaturedReleasesRouter({ lensService }));
  apiRouter.use('/content-categories', createCategoriesRouter({ lensService }));
  apiRouter.use('/subscriptions', createSubscriptionsRouter({ lensService }));
  apiRouter.use('/artists', createArtistsRouter({ lensService }));
  apiRouter.use('/structures', createStructuresRouter({ lensService }));
  apiRouter.use('/status', createStatusRouter({ lensService }));

  app.use('/api/v1', apiRouter);

  // --- Shortcut routes (directly serve current API version content) ---
  app.get('/health', (_req, res) => {
    res.status(200).json({
      status: 'ok',
      message: 'Lens API is running',
      timestamp: new Date().toISOString()
    });
  });

  app.use('/releases', createReleaseRouter({ lensService }));
  app.use('/featured-releases', createFeaturedReleasesRouter({ lensService }));
  app.use('/content-categories', createCategoriesRouter({ lensService }));
  app.use('/structures', createStructuresRouter({ lensService }));
  app.use('/status', createStatusRouter({ lensService }));

  const globalErrorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
    console.error(err);

    const statusCode = (err as HttpError).statusCode || 500;
    const message = err.message || 'An internal server error occurred.';

    res.status(statusCode).json({
      error: {
        message,
        status: statusCode
      }
    });
  };
  app.use(globalErrorHandler);
  app.listen(port, bindHost, () => {
    console.log(`✅ Lens API REST up, listening on ${bindHost}:${port}`);
  });

  return app;
}