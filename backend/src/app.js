import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import { config } from './config.js';
import { supabase } from './db.js';
import { requireAuth } from './auth.js';
import authRoutes from './routes/auth.js';
import repositoryRoutes from './routes/repositories.js';
import deploymentRoutes from './routes/deployments.js';

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.use(helmet());
  app.use(cors({ origin: config.frontendOrigin }));
  app.use(express.json({ limit: '100kb' }));

  app.get('/api/health', (req, res) => {
    res.json({
      ok: true,
      service: 'deployflow-api',
      env: config.env,
      time: new Date().toISOString(),
    });
  });

  app.get('/api/health/db', async (req, res) => {
    const { error } = await supabase
      .from('deployments')
      .select('id', { count: 'exact', head: true });
    if (error) {
      console.error('Database health check failed:', error.message);
      return res.status(503).json({ ok: false, database: 'unavailable' });
    }
    res.json({ ok: true, database: 'connected' });
  });

  app.use('/api/auth', authRoutes);
  app.use('/api/repositories', requireAuth, repositoryRoutes);
  app.use('/api/deployments', requireAuth, deploymentRoutes);

  app.use('/api', (req, res) => {
    res.status(404).json({ ok: false, error: 'Not found' });
  });

  app.use((err, req, res, next) => {
    if (err.type === 'entity.parse.failed') {
      return res.status(400).json({ ok: false, error: 'Request body is not valid JSON' });
    }
    console.error(err);
    res.status(500).json({ ok: false, error: 'Internal server error' });
  });

  return app;
}