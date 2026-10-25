/** MongoDB connection + models for Lotmark Worker */
let mongooseConn = null;

export async function getMongo(env) {
  if (mongooseConn) return mongooseConn;
  const mongoose = await import('mongoose');
  if (mongoose.default.connection.readyState === 0) {
    await mongoose.default.connect(env.MONGODB_URI);
  }
  mongooseConn = mongoose.default;
  return mongooseConn;
}

export async function getProjectModel(env) {
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

export async function getUserModel(env) {
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
