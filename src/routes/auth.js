/** Login, me, rotate-token */
import { getUserModel } from '../lib/db.js';
import { generateToken, resolveUser, requireUser, planRank, isAdmin } from '../lib/auth.js';

export function registerAuthRoutes(app) {
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
    if (planRank(user.plan) < 2 && !isAdmin(user, c.env)) {
      return c.json({ error: 'Pro or higher required to rotate API token' }, 403);
    }
    const User = await getUserModel(c.env);
    const newToken = generateToken();
    await User.updateOne({ _id: user._id }, { apiToken: newToken, updatedAt: new Date() });
    return c.json({ token: newToken, message: 'Previous token invalidated' });
  });
}
