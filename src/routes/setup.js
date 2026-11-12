/** First-run setup wizard + site settings */
import { getUserModel, getSiteSettings, getSettingsModel } from '../lib/db.js';
import { generateToken, resolveUser, isAdmin } from '../lib/auth.js';

function secretHints(env) {
  return {
    mongodb: !!env.MONGODB_URI,
    stripe: !!env.STRIPE_SECRET_KEY,
    stripeWebhook: !!env.STRIPE_WEBHOOK_SECRET,
    adminEmailsSecret: !!(env.ADMIN_EMAILS && String(env.ADMIN_EMAILS).trim()),
  };
}

export function registerSetupRoutes(app) {
  app.get('/api/setup/status', async (c) => {
    const secrets = secretHints(c.env);
    if (!secrets.mongodb) {
      return c.json({
        needsSetup: true,
        dbOk: false,
        hasAdmin: false,
        setupCompleted: false,
        secrets,
        message: 'MONGODB_URI Worker 시크릿이 필요합니다. wrangler secret put MONGODB_URI 후 다시 시도하세요.',
      });
    }
    try {
      const settings = await getSiteSettings(c.env);
      const User = await getUserModel(c.env);
      const adminCount = await User.countDocuments({ role: 'admin', disabled: { $ne: true } });
      const userCount = await User.countDocuments({});
      const needsSetup = !settings.setupCompleted || adminCount === 0;
      return c.json({
        needsSetup,
        dbOk: true,
        hasAdmin: adminCount > 0,
        userCount,
        setupCompleted: !!settings.setupCompleted,
        siteName: settings.siteName || 'Lotmark',
        allowPublicSignup: settings.allowPublicSignup !== false,
        defaultPlan: settings.defaultPlan || 'free',
        secrets,
        message: needsSetup
          ? '초기 설정이 필요합니다. 관리자 이메일을 등록하세요.'
          : '설정 완료',
      });
    } catch (e) {
      return c.json({
        needsSetup: true,
        dbOk: false,
        hasAdmin: false,
        setupCompleted: false,
        secrets,
        message: e.code === 'NO_MONGODB_URI'
          ? e.message
          : `DB 연결 실패: ${e.message || 'unknown'}`,
      }, 200);
    }
  });

  app.post('/api/setup/complete', async (c) => {
    const secrets = secretHints(c.env);
    if (!secrets.mongodb) {
      return c.json({ error: 'MONGODB_URI not configured on Worker' }, 503);
    }
    let body;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'Invalid JSON' }, 400);
    }
    const email = (body.email || '').toLowerCase().trim();
    const siteName = (body.siteName || 'Lotmark').trim().slice(0, 80);
    const allowPublicSignup = body.allowPublicSignup !== false;
    const defaultPlan = ['free', 'basic', 'pro', 'enterprise'].includes(body.defaultPlan)
      ? body.defaultPlan
      : 'free';

    if (!email || !email.includes('@')) {
      return c.json({ error: 'Valid admin email required' }, 400);
    }

    try {
      const settings = await getSiteSettings(c.env);
      const User = await getUserModel(c.env);
      const adminCount = await User.countDocuments({ role: 'admin', disabled: { $ne: true } });

      if (settings.setupCompleted && adminCount > 0) {
        return c.json({ error: 'Setup already completed. Use admin panel to change settings.' }, 409);
      }

      let user = await User.findOne({ email });
      const token = generateToken();
      if (!user) {
        user = await User.create({
          email,
          plan: 'free',
          role: 'admin',
          apiToken: token,
          dataRoomPurchases: [],
          disabled: false,
        });
      } else {
        user.role = 'admin';
        user.disabled = false;
        if (!user.apiToken) user.apiToken = token;
        user.updatedAt = new Date();
        await user.save();
      }

      settings.setupCompleted = true;
      settings.siteName = siteName;
      settings.allowPublicSignup = allowPublicSignup;
      settings.defaultPlan = defaultPlan;
      settings.setupCompletedAt = new Date();
      settings.setupCompletedBy = email;
      settings.updatedAt = new Date();
      settings.updatedBy = email;
      await settings.save();

      return c.json({
        ok: true,
        message: '초기 설정 완료',
        token: user.apiToken,
        email: user.email,
        role: 'admin',
        isAdmin: true,
        plan: user.plan,
        siteName: settings.siteName,
      });
    } catch (e) {
      console.error('setup/complete', e);
      return c.json({ error: e.message || 'Setup failed' }, 500);
    }
  });

  app.get('/api/admin/settings', async (c) => {
    const user = await resolveUser(c);
    if (!isAdmin(user, c.env)) return c.json({ error: 'Admin only' }, 403);
    try {
      const settings = await getSiteSettings(c.env);
      return c.json({
        siteName: settings.siteName,
        allowPublicSignup: settings.allowPublicSignup !== false,
        defaultPlan: settings.defaultPlan || 'free',
        setupCompleted: settings.setupCompleted,
        setupCompletedAt: settings.setupCompletedAt,
        setupCompletedBy: settings.setupCompletedBy,
        updatedAt: settings.updatedAt,
        secrets: secretHints(c.env),
      });
    } catch (e) {
      return c.json({ error: e.message }, 500);
    }
  });

  app.put('/api/admin/settings', async (c) => {
    const user = await resolveUser(c);
    if (!isAdmin(user, c.env)) return c.json({ error: 'Admin only' }, 403);
    const body = await c.req.json().catch(() => ({}));
    try {
      const settings = await getSiteSettings(c.env);
      if (body.siteName != null) settings.siteName = String(body.siteName).trim().slice(0, 80) || 'Lotmark';
      if (body.allowPublicSignup != null) settings.allowPublicSignup = !!body.allowPublicSignup;
      if (body.defaultPlan && ['free', 'basic', 'pro', 'enterprise'].includes(body.defaultPlan)) {
        settings.defaultPlan = body.defaultPlan;
      }
      settings.updatedAt = new Date();
      settings.updatedBy = user.email;
      await settings.save();
      return c.json({
        ok: true,
        siteName: settings.siteName,
        allowPublicSignup: settings.allowPublicSignup,
        defaultPlan: settings.defaultPlan,
        updatedAt: settings.updatedAt,
      });
    } catch (e) {
      return c.json({ error: e.message }, 500);
    }
  });
}
