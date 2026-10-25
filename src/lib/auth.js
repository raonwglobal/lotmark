/** Auth helpers: token, user resolve, plan, admin */
import { getUserModel } from './db.js';

export function generateToken() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}

export async function resolveUser(c) {
  const auth = c.req.header('Authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : null;
  if (!token) return null;
  const User = await getUserModel(c.env);
  return User.findOne({ apiToken: token }).lean();
}

export function requireUser(user) {
  if (!user) return { error: 'Unauthorized', status: 401 };
  return null;
}

export function planRank(plan) {
  return { free: 0, basic: 1, pro: 2, enterprise: 3 }[plan] ?? 0;
}

export function isAdmin(user, env) {
  if (!user) return false;
  if (user.role === 'admin') return true;
  const list = (env.ADMIN_EMAILS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  return list.includes((user.email || '').toLowerCase());
}
