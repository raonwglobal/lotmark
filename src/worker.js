import { Hono } from 'hono';
import { cors } from 'hono/cors';
import Stripe from 'stripe';
import { calculateGrade, redactProjectForPlan, DOC_TYPES } from './grading.js';

const app = new Hono();

app.use('*', cors({
  origin: (origin, c) => {
    const allowed = [c.env.FRONTEND_URL, 'http://localhost:5173', 'http://localhost:3000', 'http://localhost:8787'];
    if (!origin) return c.env.FRONTEND_URL;
    return allowed.includes(origin) || origin.endsWith('.pages.dev') ? origin : c.env.FRONTEND_URL;
  },
  allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization'],
}));

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
    sources: [{ docType: String, fileUrl: String, trustScore: Number, isOfficial: Boolean, note: String }],
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
    role: { type: String, enum: ['user', 'admin'], default: 'user' },
    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now },
  });
  return mongoose.models.User || mongoose.model('User', schema);
}

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

function isAdmin(user, env) {
  if (!user) return false;
  if (user.role === 'admin') return true;
  const list = (env.ADMIN_EMAILS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  return list.includes((user.email || '').toLowerCase());
}

function parseGps(data) {
  if (data.gps?.raw && (data.gps.lat == null || data.gps.lng == null)) {
    const parts = String(data.gps.raw).split(',').map(v => parseFloat(v.trim()));
    if (parts.length >= 2 && !Number.isNaN(parts[0]) && !Number.isNaN(parts[1])) {
      data.gps = { ...data.gps, lat: parts[0], lng: parts[1] };
    }
  }
  return data;
}

function applyGrade(data) {
  const { score, grade, reason } = calculateGrade(data);
  data.score = score;
  data.grade = grade;
  data.gradeReason = reason;
  data.lastVerifiedDate = new Date();
  return data;
}

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

app.get('/api/health', (c) => c.json({
  ok: true,
  env: 'cloudflare',
  product: 'lotmark',
  time: new Date().toISOString(),
  features: ['auth', 'checkout', 'webhook', 'plan-gating', 'sources', 'admin', 'seed', 'api-key-rotate'],
  docTypes: DOC_TYPES,
}));

app.get('/api/meta/doc-types', (c) => c.json({ docTypes: DOC_TYPES }));

app.post('/api/auth/login', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const email = (body.email || '').toLowerCase().trim();
  if (!email || !email.includes('@')) return c.json({ error: 'Valid email required' }, 400);
  const User = await getUserModel(c.env);
  let user = await User.findOne({ email });
  const adminEmails = (c.env.ADMIN_EMAILS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  const role = adminEmails.includes(email) ? 'admin' : 'user';
  if (!user) {
    user = await User.create({ email, plan: 'free', subscriptionStatus: 'none', apiToken: generateToken(), dataRoomPurchases: [], role });
  } else {
    if (!user.apiToken) user.apiToken = generateToken();
    if (role === 'admin' && user.role !== 'admin') user.role = 'admin';
    user.updatedAt = new Date();
    await user.save();
  }
  return c.json({
    token: user.apiToken, email: user.email, plan: user.plan, subscriptionStatus: user.subscriptionStatus,
    dataRoomPurchases: user.dataRoomPurchases || [], role: user.role || 'user',
    isAdmin: isAdmin(user.toObject ? user.toObject() : user, c.env),
  });
});

app.get('/api/me', async (c) => {
  const user = await resolveUser(c);
  const err = requireUser(user);
  if (err) return c.json({ error: err.error }, err.status);
  return c.json({
    email: user.email, plan: user.plan, subscriptionStatus: user.subscriptionStatus,
    dataRoomPurchases: user.dataRoomPurchases || [], stripeCustomerId: user.stripeCustomerId || null,
    role: user.role || 'user', isAdmin: isAdmin(user, c.env),
    apiTokenPreview: user.apiToken ? `${user.apiToken.slice(0, 8)}…` : null,
  });
});

app.post('/api/auth/rotate-token', async (c) => {
  const user = await resolveUser(c);
  const err = requireUser(user);
  if (err) return c.json({ error: err.error }, err.status);
  if (planRank(user.plan) < 2 && !isAdmin(user, c.env)) return c.json({ error: 'Pro or higher required to rotate API token' }, 403);
  const User = await getUserModel(c.env);
  const newToken = generateToken();
  await User.updateOne({ _id: user._id }, { apiToken: newToken, updatedAt: new Date() });
  return c.json({ token: newToken, message: 'Previous token invalidated' });
});

app.post('/api/checkout', async (c) => {
  const user = await resolveUser(c);
  const err = requireUser(user);
  if (err) return c.json({ error: err.error }, err.status);
  const body = await c.req.json().catch(() => ({}));
  const priceKey = (body.priceKey || '').toLowerCase();
  const projectId = body.projectId || null;
  if (!PRICE_KEYS[priceKey]) return c.json({ error: 'Invalid priceKey. Use: basic | pro | enterprise | dataroom' }, 400);
  if (priceKey === 'dataroom' && !projectId) return c.json({ error: 'projectId required for DataRoom purchase' }, 400);
  const priceEnvKey = PRICE_KEYS[priceKey];
  const priceId = c.env[priceEnvKey];
  if (!priceId) return c.json({ error: `${priceEnvKey} secret not configured` }, 500);
  const stripe = getStripe(c.env);
  const User = await getUserModel(c.env);
  let customerId = user.stripeCustomerId;
  if (!customerId) {
    const customer = await stripe.customers.create({ email: user.email, metadata: { userId: String(user._id), email: user.email } });
    customerId = customer.id;
    await User.updateOne({ _id: user._id }, { stripeCustomerId: customerId, updatedAt: new Date() });
  }
  const isSubscription = priceKey !== 'dataroom';
  const frontend = c.env.FRONTEND_URL || 'https://lotmark.pages.dev';
  const sessionParams = {
    customer: customerId,
    mode: isSubscription ? 'subscription' : 'payment',
    line_items: [{ price: priceId, quantity: 1 }],
    success_url: `${frontend}/?checkout=success&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${frontend}/?checkout=cancel`,
    metadata: { email: user.email, priceKey, projectId: projectId || '', plan: isSubscription ? priceKey : user.plan },
  };
  if (isSubscription) sessionParams.subscription_data = { metadata: { email: user.email, plan: priceKey } };
  const session = await stripe.checkout.sessions.create(sessionParams);
  return c.json({ url: session.url, sessionId: session.id });
});

app.post('/api/webhook', async (c) => {
  const stripe = getStripe(c.env);
  const sig = c.req.header('stripe-signature');
  const rawBody = await c.req.text();
  let event;
  try {
    event = await stripe.webhooks.constructEventAsync(rawBody, sig, c.env.STRIPE_WEBHOOK_SECRET);
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
          if (session.customer) user.stripeCustomerId = session.customer;
          user.updatedAt = new Date();
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
        const user = await User.findOne({ stripeCustomerId: sub.customer });
        if (!user) break;
        const statusMap = { active: 'active', trialing: 'trialing', past_due: 'past_due', canceled: 'canceled', unpaid: 'past_due' };
        user.subscriptionStatus = statusMap[sub.status] || sub.status;
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
      default: break;
    }
  } catch (e) {
    console.error('Webhook handler error', e);
    return c.json({ error: 'Handler failed' }, 500);
  }
  return c.json({ received: true });
});

app.post('/api/portal', async (c) => {
  const user = await resolveUser(c);
  const err = requireUser(user);
  if (err) return c.json({ error: err.error }, err.status);
  if (!user.stripeCustomerId) return c.json({ error: 'No Stripe customer yet. Subscribe first.' }, 400);
  const stripe = getStripe(c.env);
  const frontend = c.env.FRONTEND_URL || 'https://lotmark.pages.dev';
  const portal = await stripe.billingPortal.sessions.create({ customer: user.stripeCustomerId, return_url: frontend });
  return c.json({ url: portal.url });
});

app.get('/api/projects', async (c) => {
  const user = await resolveUser(c);
  const plan = user?.plan || 'free';
  const dataRoom = user?.dataRoomPurchases || [];
  const { region, grade, type, search, status } = c.req.query();
  const q = { isPublic: true };
  if (region) q.region = region;
  if (grade) q.grade = grade;
  if (type) q.type = type;
  if (status) q.status = status;
  if (search) q.name = { $regex: search, $options: 'i' };
  const Project = await getProjectModel(c.env);
  const list = await Project.find(q).sort({ lastVerifiedDate: -1 }).limit(500).lean();
  return c.json(list.map(p => redactProjectForPlan(p, plan, dataRoom)));
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
  const err = requireUser(user);
  if (err) return c.json({ error: err.error }, err.status);
  let data = await c.req.json();
  data = parseGps(data);
  data = applyGrade(data);
  data.projectId = data.projectId || `LM-${Date.now()}`;
  data.ownerId = String(user._id);
  if (data.isPublic == null) data.isPublic = true;
  const Project = await getProjectModel(c.env);
  const created = await Project.create(data);
  return c.json(created, 201);
});

app.put('/api/projects/:id', async (c) => {
  const user = await resolveUser(c);
  const err = requireUser(user);
  if (err) return c.json({ error: err.error }, err.status);
  const id = c.req.param('id');
  const Project = await getProjectModel(c.env);
  const existing = await Project.findOne({ projectId: id });
  if (!existing) return c.json({ error: 'not found' }, 404);
  const isOwner = existing.ownerId && existing.ownerId === String(user._id);
  if (!isOwner && !isAdmin(user, c.env)) return c.json({ error: 'Forbidden: owner or admin only' }, 403);
  let body = await c.req.json();
  const merged = {
    ...existing.toObject(), ...body, projectId: existing.projectId,
    sources: body.sources != null ? body.sources : existing.sources,
    sellerCompany: body.sellerCompany
      ? { ...(existing.sellerCompany?.toObject?.() || existing.sellerCompany || {}), ...body.sellerCompany }
      : existing.sellerCompany,
  };
  parseGps(merged);
  applyGrade(merged);
  Object.assign(existing, {
    name: merged.name, region: merged.region, type: merged.type, status: merged.status,
    gps: merged.gps, areaSqm: merged.areaSqm, priceUsd: merged.priceUsd,
    sellerCompany: merged.sellerCompany, sources: merged.sources,
    score: merged.score, grade: merged.grade, gradeReason: merged.gradeReason,
    verifiedFacts: merged.verifiedFacts, unverifiedItems: merged.unverifiedItems, riskNote: merged.riskNote,
    lastVerifiedDate: merged.lastVerifiedDate,
    isPublic: merged.isPublic != null ? merged.isPublic : existing.isPublic,
  });
  await existing.save();
  return c.json(existing);
});

app.post('/api/projects/:id/sources', async (c) => {
  const user = await resolveUser(c);
  const err = requireUser(user);
  if (err) return c.json({ error: err.error }, err.status);
  const id = c.req.param('id');
  const Project = await getProjectModel(c.env);
  const existing = await Project.findOne({ projectId: id });
  if (!existing) return c.json({ error: 'not found' }, 404);
  const isOwner = existing.ownerId && existing.ownerId === String(user._id);
  if (!isOwner && !isAdmin(user, c.env)) return c.json({ error: 'Forbidden: owner or admin only' }, 403);
  const body = await c.req.json().catch(() => ({}));
  const incoming = Array.isArray(body.sources) ? body.sources : (body.docType ? [body] : []);
  if (!incoming.length) return c.json({ error: 'Provide sources[] or a single { docType, fileUrl, ... }' }, 400);
  for (const s of incoming) {
    if (!s.docType || !DOC_TYPES.includes(s.docType)) {
      return c.json({ error: `Invalid docType. Allowed: ${DOC_TYPES.join(', ')}` }, 400);
    }
    existing.sources.push({
      docType: s.docType, fileUrl: s.fileUrl || '', trustScore: s.trustScore != null ? s.trustScore : 50,
      isOfficial: !!s.isOfficial, note: s.note || '',
    });
  }
  const plain = existing.toObject();
  applyGrade(plain);
  existing.score = plain.score;
  existing.grade = plain.grade;
  existing.gradeReason = plain.gradeReason;
  existing.lastVerifiedDate = plain.lastVerifiedDate;
  await existing.save();
  return c.json({ projectId: existing.projectId, score: existing.score, grade: existing.grade, gradeReason: existing.gradeReason, sourcesCount: existing.sources.length, sources: existing.sources });
});

app.get('/api/admin/users', async (c) => {
  const user = await resolveUser(c);
  if (!isAdmin(user, c.env)) return c.json({ error: 'Admin only' }, 403);
  const User = await getUserModel(c.env);
  const users = await User.find({}).select('-apiToken').sort({ createdAt: -1 }).limit(200).lean();
  return c.json(users);
});

app.post('/api/admin/blacklist', async (c) => {
  const user = await resolveUser(c);
  if (!isAdmin(user, c.env)) return c.json({ error: 'Admin only' }, 403);
  const body = await c.req.json().catch(() => ({}));
  const { projectId, taxCode, blacklist } = body;
  const flag = blacklist !== false;
  const Project = await getProjectModel(c.env);
  if (projectId) {
    const p = await Project.findOne({ projectId });
    if (!p) return c.json({ error: 'project not found' }, 404);
    if (!p.sellerCompany) p.sellerCompany = {};
    p.sellerCompany.blacklist = flag;
    const plain = p.toObject();
    applyGrade(plain);
    p.score = plain.score; p.grade = plain.grade; p.gradeReason = plain.gradeReason; p.lastVerifiedDate = plain.lastVerifiedDate;
    await p.save();
    return c.json({ updated: 1, project: p });
  }
  if (taxCode) {
    let updated = 0;
    const list = await Project.find({ 'sellerCompany.taxCode': taxCode });
    for (const p of list) {
      if (!p.sellerCompany) p.sellerCompany = {};
      p.sellerCompany.blacklist = flag;
      const plain = p.toObject();
      applyGrade(plain);
      p.score = plain.score; p.grade = plain.grade; p.gradeReason = plain.gradeReason; p.lastVerifiedDate = plain.lastVerifiedDate;
      await p.save();
      updated++;
    }
    return c.json({ updated, taxCode, blacklist: flag });
  }
  return c.json({ error: 'Provide projectId or taxCode' }, 400);
});

app.post('/api/admin/visibility', async (c) => {
  const user = await resolveUser(c);
  if (!isAdmin(user, c.env)) return c.json({ error: 'Admin only' }, 403);
  const body = await c.req.json().catch(() => ({}));
  const { projectId, isPublic } = body;
  if (!projectId || typeof isPublic !== 'boolean') return c.json({ error: 'projectId and isPublic(boolean) required' }, 400);
  const Project = await getProjectModel(c.env);
  const p = await Project.findOneAndUpdate({ projectId }, { isPublic }, { new: true });
  if (!p) return c.json({ error: 'not found' }, 404);
  return c.json(p);
});

app.post('/api/seed', async (c) => {
  const user = await resolveUser(c);
  const err = requireUser(user);
  if (err) return c.json({ error: err.error }, err.status);
  const samples = [
    {
      name: 'Thu Duc Industrial Sample', region: 'HCMC', type: 'industrial', status: 'active',
      areaSqm: 50000, priceUsd: 12000000,
      sellerCompany: { name: 'ABC Land', taxCode: '0312345678', blacklist: false },
      sources: [
        { docType: 'IRC', fileUrl: 'https://example.com/irc.pdf', trustScore: 90, isOfficial: true },
        { docType: 'ERC', fileUrl: 'https://example.com/erc.pdf', trustScore: 85, isOfficial: true },
        { docType: 'LURC', fileUrl: 'https://example.com/lurc.pdf', trustScore: 80, isOfficial: true },
        { docType: 'FIELD_PHOTO', fileUrl: 'https://example.com/1.jpg', trustScore: 70, isOfficial: false },
        { docType: 'FIELD_PHOTO', fileUrl: 'https://example.com/2.jpg', trustScore: 70, isOfficial: false },
        { docType: 'FIELD_PHOTO', fileUrl: 'https://example.com/3.jpg', trustScore: 70, isOfficial: false },
      ],
      verifiedFacts: 'IRC/ERC/LURC 확인', gps: { raw: '10.8500, 106.7500' }, isPublic: true,
    },
    {
      name: 'Binh Duong MOU Listing', region: 'Binh Duong', type: 'residential', status: 'listed',
      areaSqm: 12000, priceUsd: 3500000,
      sellerCompany: { name: 'Local Broker Co', taxCode: '0309988776', blacklist: false },
      sources: [
        { docType: 'NEWS', fileUrl: 'https://example.com/news.html', trustScore: 40, isOfficial: false },
        { docType: 'SELLER_DOC', fileUrl: 'https://example.com/mou.pdf', trustScore: 30, isOfficial: false },
      ],
      verifiedFacts: '', unverifiedItems: '공식 인허가 미확인', gps: { raw: '11.0000, 106.6500' }, isPublic: true,
    },
  ];
  const Project = await getProjectModel(c.env);
  const created = [];
  for (const s of samples) {
    let data = { ...s, projectId: `LM-SEED-${Date.now()}-${created.length}`, ownerId: String(user._id) };
    parseGps(data);
    applyGrade(data);
    const doc = await Project.create(data);
    created.push({ projectId: doc.projectId, name: doc.name, grade: doc.grade, score: doc.score });
    await new Promise(r => setTimeout(r, 5));
  }
  return c.json({ created });
});

export default app;
