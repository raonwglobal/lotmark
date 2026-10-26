/** Health + meta (no GET / — static index.html owns the root) */
import { DOC_TYPES } from '../grading.js';

export function registerMetaRoutes(app) {
  app.get('/api/health', (c) => c.json({
    ok: true,
    env: 'cloudflare',
    product: 'lotmark',
    mode: 'unified-worker-assets',
    time: new Date().toISOString(),
    features: ['auth', 'checkout', 'webhook', 'plan-gating', 'sources', 'admin', 'seed', 'api-key-rotate', 'static-assets'],
    docTypes: DOC_TYPES,
  }));

  app.get('/api/meta', (c) => {
    const origin = new URL(c.req.url).origin;
    return c.json({
      product: 'lotmark',
      mode: 'unified',
      frontend: c.env.FRONTEND_URL || origin,
      health: '/api/health',
      docTypes: DOC_TYPES,
    });
  });

  app.get('/api/meta/doc-types', (c) => c.json({ docTypes: DOC_TYPES }));
}
