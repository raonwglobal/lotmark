// Lotmark API client
const API_BASE = import.meta?.env?.VITE_API_URL
  || (typeof window !== 'undefined' && window.__API_BASE__)
  || 'https://lotmark.fakelove-u.workers.dev';

function token() {
  return localStorage.getItem('lm_token') || '';
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
  if (data.token) localStorage.setItem('lm_token', data.token);
  localStorage.setItem('lm_email', data.email || email);
  localStorage.setItem('lm_plan', data.plan || 'free');
  return data;
}

export function logout() {
  localStorage.removeItem('lm_token');
  localStorage.removeItem('lm_email');
  localStorage.removeItem('lm_plan');
}

export async function fetchMe() {
  return request('/api/me');
}

export async function rotateToken() {
  return request('/api/auth/rotate-token', { method: 'POST' });
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

export async function createProject(body) {
  return request('/api/projects', { method: 'POST', body: JSON.stringify(body) });
}

export async function updateProject(id, body) {
  return request(`/api/projects/${encodeURIComponent(id)}`, {
    method: 'PUT',
    body: JSON.stringify(body),
  });
}

export async function addSources(id, sources) {
  return request(`/api/projects/${encodeURIComponent(id)}/sources`, {
    method: 'POST',
    body: JSON.stringify({ sources }),
  });
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

export async function seedProjects() {
  return request('/api/seed', { method: 'POST' });
}

export async function adminUsers() {
  return request('/api/admin/users');
}

export async function adminBlacklist(payload) {
  return request('/api/admin/blacklist', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export async function adminVisibility(projectId, isPublic) {
  return request('/api/admin/visibility', {
    method: 'POST',
    body: JSON.stringify({ projectId, isPublic }),
  });
}

export async function health() {
  return request('/api/health');
}
