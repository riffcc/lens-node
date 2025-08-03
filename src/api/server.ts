import { LensService } from '@riffcc/lens-sdk';
import express, { Application, ErrorRequestHandler } from 'express';
import cors from 'cors';
import { HttpError } from 'http-errors';
import {
  createReleaseRouter,
  createFeaturedReleasesRouter,
  createCategoriesRouter,
  createSubscriptionsRouter,
  createArtistsRouter
} from './routes/index.js';

// =========================================================================
//  >>> THE FIX: Teach JSON how to serialize BigInt <<<
// This patch is needed because JSON.stringify() doesn't support BigInt by default.
// We are telling it to convert any BigInt to a string before serializing.
// Place this at the top level of your server entry file. It only needs to run once.
(BigInt.prototype as any).toJSON = function () {
  return this.toString();
};
// =========================================================================


export function startServer({ lensService }: { lensService: LensService }): Application {
  const app = express();
  const port = process.env.PORT || 5002;

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

  apiRouter.use('/releases', createReleaseRouter({ lensService }));
  apiRouter.use('/featured-releases', createFeaturedReleasesRouter({ lensService }));
  apiRouter.use('/content-categories', createCategoriesRouter({ lensService }));
  apiRouter.use('/subscriptions', createSubscriptionsRouter({ lensService }));
  apiRouter.use('/artists', createArtistsRouter({ lensService }));

  app.use('/api/v1', apiRouter);

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
  app.listen(port, () => {
    console.log(`✅ Lens API REST up, listening on port ${port}`);
  });

  return app;
}