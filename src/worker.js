import { Hono } from 'hono';
import { cors } from 'hono/cors';
import Stripe from 'stripe';
import { calculateGrade, redactProjectForPlan } from './grading.js';

const app = new Hono();

// ---------------------------------------------------------------------------
// CORS
// ---------------------------------------------------------------------------
app.use('*', cors({
  origin: (origin, c) => {
    const allowed = [c.env.FRONTEND_URL, 'http://localhost:5173', 'http://localhost:3000', 'http://localhost:8787'];
    if (!origin) return c.env.FRONTEND_URL;
    return allowed.includes(origin) || origin.endsWith('.pages.dev') ? origin : c.env.FRONTEND_URL;
  },
  allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization'],
}));

// ---------------------------------------------------------------------------
// Mongo helpers (cached connection for Workers isolate)
// ---------------------------------------------------------------------------
let mongooseConn = null;
async function getMongo(env) {
  if (mongooseConn) return mongooseConn;
  const mongoose = await import('mongoose');
  if (mongoose.default.connection.readyState === 0) {
    await mongoose.default.connect(env.MONGODB_URI);
  }
  mongooseConn = mongoose.default;
  return mongooseConn;
}

async function getProjectModel(env) {
  const mongoose = await getMongo(env);
  const schema = new mongoose.Schema({
    projectId: { type: String, unique: true },
    name: String, region: String, type: String, status: String,
    gps: { lat: Number, lng: Number, raw: String },
    areaSqm: Number, priceUsd: Number,
    sellerCompany: { name: String, taxCode: String, blacklist: Boolean },
    sources: [{ docType: String, fileUrl: String, trustScore: Number, isOfficial: Boolean }],
    score: Number, grade: String, gradeReason: String,
    verifiedFacts: String, unverifiedItems: String, riskNote: String,
    lastVerifiedDate: { type: Date, default: Date.now },
    isPublic: { type: Boolean, default: true },
    ownerId: String,
  });
  return mongoose.models.Project || mongoose.model('Project', schema);
}

async function getUserModel(env) {
  const mongoose = await getMongo(env);
  const schema = new mongoose.Schema({
    email: { type: String, unique: true, required: true, lowercase: true, trim: true },
    stripeCustomerId: String,
    plan: { type: String, enum: ['free', 'basic', 'pro', 'enterprise'], default: 'free' },
    subscriptionStatus: { type: String, enum: ['none', 'active', 'past_due', 'canceled', 'trialing'], default: 'none' },
    stripeSubscriptionId: String,
    dataRoomPurchases: { type: [String], default: [] },
    apiToken: { type: String, unique: true, sparse: true },
    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now },
  });
  return mongoose.models.User || mongoose.model('User', schema);
}

// ---------------------------------------------------------------------------
// Auth helpers (simple email → opaque token for MVP)
// ---------------------------------------------------------------------------
function generateToken() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}

async function resolveUser(c) {
  const auth = c.req.header('Authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : null;
  if (!token) return null;
  const User = await getUserModel(c.env);
  return User.findOne({ apiToken: token }).lean();
}

function requireUser(user) {
  if (!user) return { error: 'Unauthorized', status: 401 };
  return null;
}

function planRank(plan) {
  return { free: 0, basic: 1, pro: 2, enterprise: 3 }[plan] ?? 0;
}

// ---------------------------------------------------------------------------
// Stripe helper
// ---------------------------------------------------------------------------
function getStripe(env) {
  if (!env.STRIPE_SECRET_KEY) throw new Error('STRIPE_SECRET_KEY not set');
  return new Stripe(env.STRIPE_SECRET_KEY, {
    apiVersion: '2024-06-20',
    httpClient: Stripe.createFetchHttpClient(),
  });
}

const PRICE_KEYS = {
  basic: 'STRIPE_PRICE_BASIC',
  pro: 'STRIPE_PRICE_PRO',
  enterprise: 'STRIPE_PRICE_ENTERPRISE',
  dataroom: 'STRIPE_PRICE_DATAROOM',
};

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------
app.get('/api/health', (c) => c.json({
  ok: true,
  env: 'cloudflare',
  time: new Date().toISOString(),
  features: ['auth', 'checkout', 'webhook', 'plan-gating'],
}));

// ---------------------------------------------------------------------------
// Auth: email login / register → issue apiToken
// ---------------------------------------------------------------------------
app.post('/api/auth/login', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const email = (body.email || '').toLowerCase().trim();
  if (!email || !email.includes('@')) {
    return c.json({ error: 'Valid email required' }, 400);
  }

  const User = await getUserModel(c.env);
  let user = await User.findOne({ email });
  if (!user) {
    user = await User.create({
      email,
      plan: 'free',
      subscriptionStatus: 'none',
      apiToken: generateToken(),
      dataRoomPurchases: [],
    });
  } else if (!user.apiToken) {
    user.apiToken = generateToken();
    user.updatedAt = new Date();
    await user.save();
  }

  return c.json({
    token: user.apiToken,
    email: user.email,
    plan: user.plan,
    subscriptionStatus: user.subscriptionStatus,
    dataRoomPurchases: user.dataRoomPurchases || [],
  });
});

app.get('/api/me', async (c) => {
  const user = await resolveUser(c);
  const err = requireUser(user);
  if (err) return c.json({ error: err.error }, err.status);
  return c.json({
    email: user.email,
    plan: user.plan,
    subscriptionStatus: user.subscriptionStatus,
    dataRoomPurchases: user.dataRoomPurchases || [],
    stripeCustomerId: user.stripeCustomerId || null,
  });
});

// ---------------------------------------------------------------------------
// Stripe Checkout
// ---------------------------------------------------------------------------
app.post('/api/checkout', async (c) => {
  const user = await resolveUser(c);
  const err = requireUser(user);
  if (err) return c.json({ error: err.error }, err.status);

  const body = await c.req.json().catch(() => ({}));
  const priceKey = (body.priceKey || '').toLowerCase();
  const projectId = body.projectId || null;

  if (!PRICE_KEYS[priceKey]) {
    return c.json({ error: 'Invalid priceKey. Use: basic | pro | enterprise | dataroom' }, 400);
  }
  if (priceKey === 'dataroom' && !projectId) {
    return c.json({ error: 'projectId required for DataRoom purchase' }, 400);
  }

  const priceEnvKey = PRICE_KEYS[priceKey];
  const priceId = c.env[priceEnvKey];
  if (!priceId) {
    return c.json({ error: `${priceEnvKey} secret not configured` }, 500);
  }

  const stripe = getStripe(c.env);
  const User = await getUserModel(c.env);
  let customerId = user.stripeCustomerId;

  if (!customerId) {
    const customer = await stripe.customers.create({
      email: user.email,
      metadata: { userId: String(user._id), email: user.email },
    });
    customerId = customer.id;
    await User.updateOne({ _id: user._id }, { stripeCustomerId: customerId, updatedAt: new Date() });
  }

  const isSubscription = priceKey !== 'dataroom';
  const frontend = c.env.FRONTEND_URL || 'https://v-verify.pages.dev';

  const sessionParams = {
    customer: customerId,
    mode: isSubscription ? 'subscription' : 'payment',
    line_items: [{ price: priceId, quantity: 1 }],
    success_url: `${frontend}/?checkout=success&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${frontend}/?checkout=cancel`,
    metadata: {
      email: user.email,
      priceKey,
      projectId: projectId || '',
      plan: isSubscription ? priceKey : user.plan,
    },
  };

  if (isSubscription) {
    sessionParams.subscription_data = {
      metadata: { email: user.email, plan: priceKey },
    };
  }

  const session = await stripe.checkout.sessions.create(sessionParams);
  return c.json({ url: session.url, sessionId: session.id });
});

// ---------------------------------------------------------------------------
// Stripe Webhook
// ---------------------------------------------------------------------------
app.post('/api/webhook', async (c) => {
  const stripe = getStripe(c.env);
  const sig = c.req.header('stripe-signature');
  const rawBody = await c.req.text();

  let event;
  try {
    event = await stripe.webhooks.constructEventAsync(
      rawBody,
      sig,
      c.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (e) {
    console.error('Webhook signature failed', e.message);
    return c.json({ error: 'Invalid signature' }, 400);
  }

  const User = await getUserModel(c.env);

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object;
        const email = (session.metadata?.email || session.customer_email || '').toLowerCase();
        const priceKey = session.metadata?.priceKey;
        const projectId = session.metadata?.projectId;

        if (!email) break;

        const user = await User.findOne({ email });
        if (!user) break;

        if (priceKey === 'dataroom' && projectId) {
          const set = new Set(user.dataRoomPurchases || []);
          set.add(projectId);
          user.dataRoomPurchases = [...set];
          user.updatedAt = new Date();
          if (session.customer) user.stripeCustomerId = session.customer;
          await user.save();
        } else if (['basic', 'pro', 'enterprise'].includes(priceKey)) {
          user.plan = priceKey;
          user.subscriptionStatus = 'active';
          if (session.subscription) user.stripeSubscriptionId = session.subscription;
          if (session.customer) user.stripeCustomerId = session.customer;
          user.updatedAt = new Date();
          await user.save();
        }
        break;
      }

      case 'customer.subscription.updated': {
        const sub = event.data.object;
        const customerId = sub.customer;
        const user = await User.findOne({ stripeCustomerId: customerId });
        if (!user) break;

        const statusMap = {
          active: 'active',
          trialing: 'trialing',
          past_due: 'past_due',
          canceled: 'canceled',
          unpaid: 'past_due',
        };
        user.subscriptionStatus = statusMap[sub.status] || sub.status;
        if (sub.status === 'canceled' || sub.status === 'unpaid') {
          // keep plan until explicit cancel handling; optional: downgrade
        }
        // Plan from subscription metadata if present
        if (sub.metadata?.plan) user.plan = sub.metadata.plan;
        user.stripeSubscriptionId = sub.id;
        user.updatedAt = new Date();
        await user.save();
        break;
      }

      case 'customer.subscription.deleted': {
        const sub = event.data.object;
        const user = await User.findOne({ stripeCustomerId: sub.customer });
        if (!user) break;
        user.plan = 'free';
        user.subscriptionStatus = 'canceled';
        user.stripeSubscriptionId = null;
        user.updatedAt = new Date();
        await user.save();
        break;
      }

      case 'invoice.payment_failed': {
        const inv = event.data.object;
        const user = await User.findOne({ stripeCustomerId: inv.customer });
        if (!user) break;
        user.subscriptionStatus = 'past_due';
        user.updatedAt = new Date();
        await user.save();
        break;
      }

      default:
        break;
    }
  } catch (e) {
    console.error('Webhook handler error', e);
    return c.json({ error: 'Handler failed' }, 500);
  }

  return c.json({ received: true });
});

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------
app.get('/api/projects', async (c) => {
  const user = await resolveUser(c);
  const plan = user?.plan || 'free';
  const dataRoom = user?.dataRoomPurchases || [];

  const { region, grade, type, search } = c.req.query();
  const q = { isPublic: true };
  if (region) q.region = region;
  if (grade) q.grade = grade;
  if (type) q.type = type;
  if (search) q.name = { $regex: search, $options: 'i' };

  const Project = await getProjectModel(c.env);
  const list = await Project.find(q).sort({ lastVerifiedDate: -1 }).limit(500).lean();
  const redacted = list.map(p => redactProjectForPlan(p, plan, dataRoom));
  return c.json(redacted);
});

app.get('/api/projects/:id', async (c) => {
  const user = await resolveUser(c);
  const plan = user?.plan || 'free';
  const dataRoom = user?.dataRoomPurchases || [];

  const id = c.req.param('id');
  const Project = await getProjectModel(c.env);
  const p = await Project.findOne({ projectId: id }).lean();
  if (!p) return c.json({ error: 'not found' }, 404);

  return c.json(redactProjectForPlan(p, plan, dataRoom));
});

app.post('/api/projects', async (c) => {
  const user = await resolveUser(c);
  // Creating projects: require at least basic (or allow free for admin seed — keep open for MVP seed)
  // For production tighten: if (!user || planRank(user.plan) < 1) return 403

  const data = await c.req.json();
  const { score, grade, reason } = calculateGrade(data);
  data.score = score;
  data.grade = data.grade || grade;
  data.gradeReason = reason;
  data.projectId = data.projectId || `VVN-${Date.now()}`;
  if (user) data.ownerId = String(user._id);
  if (data.gps?.raw && !data.gps.lat) {
    const [lat, lng] = data.gps.raw.split(',').map(v => parseFloat(v.trim()));
    data.gps.lat = lat;
    data.gps.lng = lng;
  }

  const Project = await getProjectModel(c.env);
  const created = await Project.create(data);
  return c.json(created);
});

// Customer portal (manage subscription)
app.post('/api/portal', async (c) => {
  const user = await resolveUser(c);
  const err = requireUser(user);
  if (err) return c.json({ error: err.error }, err.status);
  if (!user.stripeCustomerId) {
    return c.json({ error: 'No Stripe customer yet. Subscribe first.' }, 400);
  }

  const stripe = getStripe(c.env);
  const frontend = c.env.FRONTEND_URL || 'https://v-verify.pages.dev';
  const portal = await stripe.billingPortal.sessions.create({
    customer: user.stripeCustomerId,
    return_url: frontend,
  });
  return c.json({ url: portal.url });
});

export default app;
