import { createApp } from './app.js';
import { config } from './config.js';
import { startRunner } from './runner.js';

createApp().listen(config.port, (err) => {
  if (err) {
    console.error(`Could not start server on port ${config.port}:`, err.message);
    process.exit(1);
  }
  console.log(`DeployFlow API listening on http://localhost:${config.port}`);
  startRunner();
});
