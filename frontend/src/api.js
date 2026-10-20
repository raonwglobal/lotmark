// V-Verify API client
const API_BASE = import.meta?.env?.VITE_API_URL
  || (typeof window !== 'undefined' && window.__API_BASE__)
  || 'https://v-verify-api.your-subdomain.workers.dev';

function token() {
  return localStorage.getItem('vv_token') || '';
}

async function request(path, options = {}) {
  const headers = {
    'Content-Type': 'application/json',
    ...(options.headers || {}),
  };
  const t = token();
  if (t) headers['Authorization'] = `Bearer ${t}`;

  const res = await fetch(`${API_BASE}${path}`, { ...options, headers });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || res.statusText || 'Request failed');
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

export async function login(email) {
  const data = await request('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email }),
  });
  if (data.token) localStorage.setItem('vv_token', data.token);
  localStorage.setItem('vv_email', data.email || email);
  localStorage.setItem('vv_plan', data.plan || 'free');
  return data;
}

export function logout() {
  localStorage.removeItem('vv_token');
  localStorage.removeItem('vv_email');
  localStorage.removeItem('vv_plan');
}

export async function fetchMe() {
  return request('/api/me');
}

export async function fetchProjects(filters = {}) {
  const params = new URLSearchParams();
  Object.entries(filters).forEach(([k, v]) => {
    if (v != null && v !== '') params.set(k, v);
  });
  const q = params.toString();
  return request(`/api/projects${q ? `?${q}` : ''}`);
}

export async function fetchProject(id) {
  return request(`/api/projects/${encodeURIComponent(id)}`);
}

export async function createCheckout(priceKey, projectId = null) {
  return request('/api/checkout', {
    method: 'POST',
    body: JSON.stringify({ priceKey, projectId }),
  });
}

export async function openPortal() {
  return request('/api/portal', { method: 'POST' });
}

export async function health() {
  return request('/api/health');
}
