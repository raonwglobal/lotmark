/** Health, root, meta routes */
import { DOC_TYPES } from '../grading.js';

export function registerMetaRoutes(app) {
  app.get('/', (c) => {
    const frontend = c.env.FRONTEND_URL || 'https://lotmark.pages.dev';
    return c.json({
      product: 'lotmark',
      message: 'Lotmark API worker. Use the frontend app or call /api/* routes.',
      frontend,
      health: '/api/health',
    });
  });

  app.get('/api/health', (c) => c.json({
    ok: true,
    env: 'cloudflare',
    product: 'lotmark',
    time: new Date().toISOString(),
    features: ['auth', 'checkout', 'webhook', 'plan-gating', 'sources', 'admin', 'seed', 'api-key-rotate'],
    docTypes: DOC_TYPES,
  }));

  app.get('/api/meta/doc-types', (c) => c.json({ docTypes: DOC_TYPES }));
}
