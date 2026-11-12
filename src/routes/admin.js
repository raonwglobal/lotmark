/** Admin: users, blacklist, visibility */
import { getProjectModel, getUserModel } from '../lib/db.js';
import { resolveUser, isAdmin, generateToken } from '../lib/auth.js';
import { applyGrade } from '../lib/helpers.js';

export function registerAdminRoutes(app) {
  app.get('/api/admin/users', async (c) => {
    const user = await resolveUser(c);
    if (!isAdmin(user, c.env)) return c.json({ error: 'Admin only' }, 403);
    const User = await getUserModel(c.env);
    const users = await User.find({})
      .select('-apiToken')
      .sort({ createdAt: -1 })
      .limit(200)
      .lean();
    return c.json(users);
  });

  app.post('/api/admin/users/update', async (c) => {
    const actor = await resolveUser(c);
    if (!isAdmin(actor, c.env)) return c.json({ error: 'Admin only' }, 403);
    const body = await c.req.json().catch(() => ({}));
    const email = (body.email || '').toLowerCase().trim();
    if (!email) return c.json({ error: 'email required' }, 400);

    const User = await getUserModel(c.env);
    const target = await User.findOne({ email });
    if (!target) return c.json({ error: 'user not found' }, 404);

    if ((body.role === 'user' || body.disabled === true) && target.role === 'admin') {
      const adminCount = await User.countDocuments({ role: 'admin', disabled: { $ne: true } });
      if (adminCount <= 1) {
        return c.json({ error: 'Cannot demote or disable the last admin' }, 400);
      }
    }

    if (body.role === 'admin' || body.role === 'user') target.role = body.role;
    if (body.disabled != null) target.disabled = !!body.disabled;
    if (body.plan && ['free', 'basic', 'pro', 'enterprise'].includes(body.plan)) {
      target.plan = body.plan;
    }
    target.updatedAt = new Date();
    await target.save();

    return c.json({
      ok: true,
      email: target.email,
      role: target.role,
      disabled: !!target.disabled,
      plan: target.plan,
    });
  });

  app.post('/api/admin/users/revoke-token', async (c) => {
    const actor = await resolveUser(c);
    if (!isAdmin(actor, c.env)) return c.json({ error: 'Admin only' }, 403);
    const body = await c.req.json().catch(() => ({}));
    const email = (body.email || '').toLowerCase().trim();
    if (!email) return c.json({ error: 'email required' }, 400);
    const User = await getUserModel(c.env);
    const target = await User.findOne({ email });
    if (!target) return c.json({ error: 'user not found' }, 404);
    target.apiToken = generateToken();
    target.updatedAt = new Date();
    await target.save();
    return c.json({ ok: true, email, message: 'Token rotated; previous token invalid' });
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
