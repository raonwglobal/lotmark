/** Stripe checkout, webhook, portal */
import { getUserModel } from '../lib/db.js';
import { resolveUser, requireUser } from '../lib/auth.js';
import { getStripe, PRICE_KEYS } from '../lib/stripe.js';

export function registerBillingRoutes(app) {
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
      const customer = await stripe.customers.create({
        email: user.email,
        metadata: { userId: String(user._id), email: user.email },
      });
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
      metadata: {
        email: user.email,
        priceKey,
        projectId: projectId || '',
        plan: isSubscription ? priceKey : user.plan,
      },
    };
    if (isSubscription) {
      sessionParams.subscription_data = { metadata: { email: user.email, plan: priceKey } };
    }
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
          const statusMap = {
            active: 'active', trialing: 'trialing', past_due: 'past_due',
            canceled: 'canceled', unpaid: 'past_due',
          };
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
        default:
          break;
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
    const portal = await stripe.billingPortal.sessions.create({
      customer: user.stripeCustomerId,
      return_url: frontend,
    });
    return c.json({ url: portal.url });
  });
}
