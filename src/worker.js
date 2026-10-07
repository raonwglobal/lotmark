import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { calculateGrade } from './grading.js';

const app = new Hono();

// CORS - Pages 도메인만 허용
app.use('*', cors({
  origin: (origin, c) => {
    const allowed = [c.env.FRONTEND_URL, 'http://localhost:5173', 'http://localhost:3000'];
    if(!origin) return c.env.FRONTEND_URL;
    return allowed.includes(origin) || origin.endsWith('.pages.dev') ? origin : c.env.FRONTEND_URL;
  },
  allowMethods: ['GET','POST','PUT','DELETE','OPTIONS'],
  allowHeaders: ['Content-Type','Authorization']
}));

// MongoDB connection helper - Cloudflare Workers는 TCP 직접 연결이 안되므로 Atlas Data API 또는 Mongoose with caching 사용
// 여기서는 fetch 기반 Atlas Data API 래퍼 사용. MONGODB_DATA_API_URL 세팅 필요
let mongooseConn = null;
async function getMongo(env){
  if(mongooseConn) return mongooseConn;
  const mongoose = await import('mongoose');
  if(mongoose.default.connection.readyState===0){
    await mongoose.default.connect(env.MONGODB_URI);
  }
  mongooseConn = mongoose.default;
  return mongooseConn;
}

// --- Models (inline for Workers) ---
async function getProjectModel(env){
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
    isPublic: { type: Boolean, default: true }
  });
  return mongoose.models.Project || mongoose.model('Project', schema);
}

// Health
app.get('/api/health', (c)=> c.json({ ok:true, env: 'cloudflare', time: new Date().toISOString() }));

// GET /api/projects
app.get('/api/projects', async (c)=>{
  const { region, grade, type, search } = c.req.query();
  const q = { isPublic: true };
  if(region) q.region = region;
  if(grade) q.grade = grade;
  if(type) q.type = type;
  if(search) q.name = { $regex: search, $options: 'i' };
  const Project = await getProjectModel(c.env);
  const list = await Project.find(q).sort({ lastVerifiedDate: -1 }).limit(500).lean();
  return c.json(list);
});

app.get('/api/projects/:id', async (c)=>{
  const id = c.req.param('id');
  const Project = await getProjectModel(c.env);
  const p = await Project.findOne({ projectId: id }).lean();
  if(!p) return c.json({ error:'not found' }, 404);
  return c.json(p);
});

app.post('/api/projects', async (c)=>{
  const data = await c.req.json();
  const { score, grade, reason } = calculateGrade(data);
  data.score = score; data.grade = data.grade || grade; data.gradeReason = reason;
  data.projectId = data.projectId || `VVN-${Date.now()}`;
  if(data.gps?.raw && !data.gps.lat){
    const [lat,lng] = data.gps.raw.split(',').map(v=>parseFloat(v.trim()));
    data.gps.lat = lat; data.gps.lng = lng;
  }
  const Project = await getProjectModel(c.env);
  const created = await Project.create(data);
  return c.json(created);
});

export default app;
