/**
 * Lotmark — unified Cloudflare Worker
 * - /api/* → Hono API (MongoDB, Stripe, auth)
 * - everything else → static assets (frontend/)
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

app.use('/api/*', cors({
  origin: (origin, c) => {
    const allowed = [
      c.env.FRONTEND_URL,
      'http://localhost:5173',
      'http://localhost:3000',
      'http://localhost:8787',
      'http://127.0.0.1:8787',
    ].filter(Boolean);
    if (!origin) return allowed[0] || '*';
    if (allowed.includes(origin)) return origin;
    if (origin.endsWith('.pages.dev') || origin.endsWith('.workers.dev')) return origin;
    return allowed[0] || origin;
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

/**
 * Dispatch: API → Hono; static/SPA → ASSETS binding.
 */
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
      return app.fetch(request, env, ctx);
    }
    if (env.ASSETS) {
      return env.ASSETS.fetch(request);
    }
    return app.fetch(request, env, ctx);
  },
};
