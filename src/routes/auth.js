/** Login, me, rotate-token */
import { getUserModel, getSiteSettings } from '../lib/db.js';
import { generateToken, resolveUser, requireUser, planRank, isAdmin } from '../lib/auth.js';

export function registerAuthRoutes(app) {
  app.post('/api/auth/login', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const email = (body.email || '').toLowerCase().trim();
    if (!email || !email.includes('@')) return c.json({ error: 'Valid email required' }, 400);

    try {
      const User = await getUserModel(c.env);
      let user = await User.findOne({ email });
      const adminEmails = (c.env.ADMIN_EMAILS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
      const roleFromSecret = adminEmails.includes(email) ? 'admin' : null;

      if (!user) {
        let allowSignup = true;
        try {
          const settings = await getSiteSettings(c.env);
          if (!settings.setupCompleted) {
            return c.json({
              error: 'Site setup not completed. Open the setup screen first.',
              code: 'NEEDS_SETUP',
            }, 403);
          }
          if (settings.allowPublicSignup === false) allowSignup = false;
        } catch (_) {}

        if (!allowSignup) {
          return c.json({ error: 'Public signup is disabled. Contact an administrator.' }, 403);
        }

        user = await User.create({
          email,
          plan: 'free',
          subscriptionStatus: 'none',
          apiToken: generateToken(),
          dataRoomPurchases: [],
          role: roleFromSecret || 'user',
          disabled: false,
        });
      } else {
        if (user.disabled) {
          return c.json({ error: 'Account disabled. Contact an administrator.' }, 403);
        }
        if (!user.apiToken) user.apiToken = generateToken();
        if (roleFromSecret === 'admin' && user.role !== 'admin') user.role = 'admin';
        user.updatedAt = new Date();
        await user.save();
      }

      return c.json({
        token: user.apiToken,
        email: user.email,
        plan: user.plan,
        subscriptionStatus: user.subscriptionStatus,
        dataRoomPurchases: user.dataRoomPurchases || [],
        role: user.role || 'user',
        isAdmin: isAdmin(user.toObject ? user.toObject() : user, c.env),
      });
    } catch (e) {
      console.error('login', e);
      if (e.code === 'NO_MONGODB_URI') {
        return c.json({ error: 'Database not configured (MONGODB_URI)', code: 'NO_DB' }, 503);
      }
      return c.json({ error: e.message || 'Login failed' }, 500);
    }
  });

  app.get('/api/me', async (c) => {
    const user = await resolveUser(c);
    const err = requireUser(user);
    if (err) return c.json({ error: err.error }, err.status);
    if (user.disabled) return c.json({ error: 'Account disabled' }, 403);
    return c.json({
      email: user.email,
      plan: user.plan,
      subscriptionStatus: user.subscriptionStatus,
      dataRoomPurchases: user.dataRoomPurchases || [],
      stripeCustomerId: user.stripeCustomerId || null,
      role: user.role || 'user',
      isAdmin: isAdmin(user, c.env),
      apiTokenPreview: user.apiToken ? `${user.apiToken.slice(0, 8)}…` : null,
    });
  });

  app.post('/api/auth/rotate-token', async (c) => {
    const user = await resolveUser(c);
    const err = requireUser(user);
    if (err) return c.json({ error: err.error }, err.status);
    if (user.disabled) return c.json({ error: 'Account disabled' }, 403);
    if (planRank(user.plan) < 2 && !isAdmin(user, c.env)) {
      return c.json({ error: 'Pro or higher required to rotate API token' }, 403);
    }
    const User = await getUserModel(c.env);
    const newToken = generateToken();
    await User.updateOne({ _id: user._id }, { apiToken: newToken, updatedAt: new Date() });
    return c.json({ token: newToken, message: 'Previous token invalidated' });
  });
}
