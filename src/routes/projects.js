/** Project CRUD + sources */
import { getProjectModel } from '../lib/db.js';
import { resolveUser, requireUser, isAdmin } from '../lib/auth.js';
import { parseGps, applyGrade } from '../lib/helpers.js';
import { redactProjectForPlan, DOC_TYPES } from '../grading.js';

export function registerProjectRoutes(app) {
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
        docType: s.docType, fileUrl: s.fileUrl || '',
        trustScore: s.trustScore != null ? s.trustScore : 50,
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
    return c.json({
      projectId: existing.projectId, score: existing.score, grade: existing.grade,
      gradeReason: existing.gradeReason, sourcesCount: existing.sources.length, sources: existing.sources,
    });
  });
}
