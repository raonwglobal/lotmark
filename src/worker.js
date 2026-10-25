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

// Browser root: API-only worker — point users to Pages frontend
app.get('/', (c) => {
  const frontend = c.env.FRONTEND_URL || 'https://lotmark.pages.dev';
  return c.json({
    product: 'lotmark',
    message: 'Lotmark API worker. Use the frontend app or call /api/* routes.',
    frontend,
    health: '/api/health',
  });
});

app.notFound((c) => c.json({ error: 'not found', path: c.req.path }, 404));

app.get('/api/health', (c) => c.json({
  ok: true,
  env: 'cloudflare',
  product: 'lotmark',
  time: new Date().toISOString(),
  features: ['auth', 'checkout', 'webhook', 'plan-gating', 'sources', 'admin', 'seed', 'api-key-rotate'],
  docTypes: DOC_TYPES,
}));

app.get('/api/meta/doc-types', (c) => c.json({ docTypes: DOC_TYPES }));

export default app;
