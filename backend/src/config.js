const num = (v, d) => (v === undefined || v === '' ? d : Number(v));
const port = num(process.env.PORT, 3001);

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error('Invalid PORT in .env');
  process.exit(1);
}

export const config = {
  port,
  env: process.env.NODE_ENV || 'development',
  frontendOrigin: process.env.FRONTEND_ORIGIN || 'http://localhost:3001',
};
