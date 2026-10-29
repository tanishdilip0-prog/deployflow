import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import path from 'node:path';
import fs from 'node:fs';
import { config } from './config.js';
import { supabase } from './db.js';
import { requireAuth } from './auth.js';
import authRoutes from './routes/auth.js';
import repositoryRoutes from './routes/repositories.js';
import deploymentRoutes from './routes/deployments.js';
import githubRoutes from './routes/github.js';
import webhookRoutes from './routes/webhooks.js';
import assistantRoutes from './routes/assistant.js';

export function createApp() {
  const app = express();
  app.disable('x-powered-by');

  // Security headers with resource sharing enabled for local dev/preview and CSP permitting CDNs and inline assets
  app.use(helmet({
    crossOriginResourcePolicy: { policy: 'cross-origin' },
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: [
          "'self'",
          "'unsafe-inline'",
          'https://cdnjs.cloudflare.com',
          'https://cdn.jsdelivr.net'
        ],
        styleSrc: [
          "'self'",
          "'unsafe-inline'",
          'https://fonts.googleapis.com'
        ],
        fontSrc: [
          "'self'",
          'https://fonts.gstatic.com',
          'data:'
        ],
        imgSrc: [
          "'self'",
          'data:',
          'blob:',
          'https://avatars.githubusercontent.com',
          'https://raw.githubusercontent.com'
        ],
        connectSrc: [
          "'self'",
          'https://*.supabase.co',
          'wss://*.supabase.co',
          'https://api.github.com',
          'https://cdnjs.cloudflare.com',
          'https://cdn.jsdelivr.net'
        ],
        frameAncestors: ["'self'"]
      }
    }
  }));

  // Dynamic CORS policy allowing configured frontendOrigin and local developer ports
  app.use(cors({
    origin: (origin, callback) => {
      if (!origin) return callback(null, true);
      if (
        origin === config.frontendOrigin ||
        origin.startsWith('http://localhost:') ||
        origin.startsWith('http://127.0.0.1:')
      ) {
        return callback(null, true);
      }
      callback(null, true); // Permissive in dev
    },
    credentials: true
  }));

  // Serve static deployed build artifacts from constant project path
  const deployedDir = path.resolve(import.meta.dirname, '..', 'deployed');
  if (!fs.existsSync(deployedDir)) {
    fs.mkdirSync(deployedDir, { recursive: true });
  }
  app.use('/deployed', express.static(deployedDir));

  app.use('/api/webhooks', express.raw({ type: 'application/json', limit: '1mb' }), webhookRoutes);
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

  app.get('/api/config', (req, res) => {
    res.json({ ok: true, supabaseUrl: config.supabaseUrl, supabaseAnonKey: config.supabaseAnonKey });
  });

  app.use('/api/github', requireAuth, githubRoutes);
  app.use('/api/auth', authRoutes);
  app.use('/api/repositories', requireAuth, repositoryRoutes);
  app.use('/api/deployments', requireAuth, deploymentRoutes);
  app.use('/api/assistant', assistantRoutes);

  app.use('/api', (req, res) => {
    res.status(404).json({ ok: false, error: 'Not found' });
  });

  // Serve DeployFlow frontend assets (index.html, script.js, style.css, web/) directly from root
  const rootDir = path.resolve(import.meta.dirname, '../../');
  app.use(express.static(rootDir));

  app.use((err, req, res, next) => {
    if (err.type === 'entity.parse.failed') {
      return res.status(400).json({ ok: false, error: 'Request body is not valid JSON' });
    }
    console.error(err);
    res.status(500).json({ ok: false, error: 'Internal server error' });
  });

  return app;
}
