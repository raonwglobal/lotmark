/**
 * Lotmark API — Cloudflare Worker (Hono)
 * Modular entry: routes under ./routes, shared libs under ./lib
 */
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { registerMetaRoutes } from './routes/meta.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerBillingRoutes } from './routes/billing.js';
import { registerProjectRoutes } from './routes/projects.js';
import { registerAdminRoutes } from './routes/admin.js';
import { registerSeedRoutes } from './routes/seed.js';

const app = new Hono();

app.use('*', cors({
  origin: (origin, c) => {
    const allowed = [
      c.env.FRONTEND_URL,
      'http://localhost:5173',
      'http://localhost:3000',
      'http://localhost:8787',
    ];
    if (!origin) return c.env.FRONTEND_URL;
    return allowed.includes(origin) || origin.endsWith('.pages.dev')
      ? origin
      : c.env.FRONTEND_URL;
  },
  allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization'],
}));

registerMetaRoutes(app);
registerAuthRoutes(app);
registerBillingRoutes(app);
registerProjectRoutes(app);
registerAdminRoutes(app);
registerSeedRoutes(app);

app.notFound((c) => c.json({ error: 'not found', path: c.req.path }, 404));

export default app;
