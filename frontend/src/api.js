// Frontend에서 Cloudflare Worker 호출
const API_BASE = import.meta.env.VITE_API_URL || 'https://v-verify-api.your-subdomain.workers.dev';

export async function fetchProjects(filters={}){
  const params = new URLSearchParams(filters);
  const res = await fetch(`${API_BASE}/api/projects?${params}`);
  return res.json();
}
