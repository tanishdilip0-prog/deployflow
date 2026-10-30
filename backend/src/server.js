import { createApp } from './app.js';
import { config } from './config.js';
import { startRunner } from './runner.js';

const server = createApp().listen(config.port, () => {
  console.log(`DeployFlow API listening on http://localhost:${config.port}`);
  startRunner();
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n[DeployFlow] Port ${config.port} is already in use by another instance or process.`);
    console.error(`To inspect/kill it: lsof -ti :${config.port} | xargs kill\n`);
  } else {
    console.error(`Could not start server on port ${config.port}:`, err.message);
  }
  process.exit(1);
});

