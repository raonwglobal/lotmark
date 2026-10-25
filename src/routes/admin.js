/** Admin: users, blacklist, visibility */
import { getProjectModel, getUserModel } from '../lib/db.js';
import { resolveUser, isAdmin } from '../lib/auth.js';
import { applyGrade } from '../lib/helpers.js';

export function registerAdminRoutes(app) {
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
      p.score = plain.score; p.grade = plain.grade; p.gradeReason = plain.gradeReason;
      p.lastVerifiedDate = plain.lastVerifiedDate;
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
        p.score = plain.score; p.grade = plain.grade; p.gradeReason = plain.gradeReason;
        p.lastVerifiedDate = plain.lastVerifiedDate;
        await p.save();
        updated++;
      }
      return c.json({ updated, taxCode, blacklist: flag });
    }
    return c.json({ error: 'projectId or taxCode required' }, 400);
  });

  app.post('/api/admin/visibility', async (c) => {
    const user = await resolveUser(c);
    if (!isAdmin(user, c.env)) return c.json({ error: 'Admin only' }, 403);
    const body = await c.req.json().catch(() => ({}));
    const { projectId, isPublic } = body;
    if (!projectId) return c.json({ error: 'projectId required' }, 400);
    const Project = await getProjectModel(c.env);
    const p = await Project.findOneAndUpdate(
      { projectId },
      { isPublic: !!isPublic },
      { new: true },
    );
    if (!p) return c.json({ error: 'project not found' }, 404);
    return c.json({ projectId: p.projectId, isPublic: p.isPublic });
  });
}
