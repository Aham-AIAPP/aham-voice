import axios, { AxiosError } from "axios";

// Axios base URL.
//
// Production: frontend is served by frontend_static_server.py on :5173, and
// the FastAPI backend is on :8000 on the same host. The static server can't
// proxy, so we hit the backend directly via CORS (the backend whitelists
// :5173 + private-net regex via CORSMiddleware).
//
// Dev: vite runs on :5174 and proxies /api → :8000, so relative `/api`
// works.
//
// Anything else (reverse-proxy in front, single-origin deploy, etc.) falls
// back to relative `/api` and assumes the proxy handles it.
function deriveBaseURL(): string {
  if (typeof window === "undefined") return "/api";
  const { protocol, hostname, port } = window.location;
  if (port === "5174") return "/api";
  if (port === "5173" || port === "") return `${protocol}//${hostname}:8000/api`;
  return "/api";
}

// Axios instance shared by every API call. Auth token lives in localStorage
// because the backend exchanges it via a session row in sqlite that survives
// reloads. We never need to do CSRF-token dance — the API only accepts the
// Bearer header and CORS is locked to private-net origins.
export const api = axios.create({
  baseURL: deriveBaseURL(),
  timeout: 180_000,
});

const TOKEN_KEY = "newvoice.token";

export function getStoredToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setStoredToken(token: string | null): void {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* localStorage unavailable (incognito, fs error) — gracefully ignore */
  }
}

// Listeners that get pinged when the API replies 401 so the auth provider can
// clear state without coupling every component to the axios instance.
type UnauthorizedListener = () => void;
const unauthorizedListeners = new Set<UnauthorizedListener>();
export function onUnauthorized(fn: UnauthorizedListener): () => void {
  unauthorizedListeners.add(fn);
  return () => unauthorizedListeners.delete(fn);
}

api.interceptors.request.use((config) => {
  const token = getStoredToken();
  if (token) {
    config.headers.set("Authorization", `Bearer ${token}`);
  }
  return config;
});

api.interceptors.response.use(
  (res) => res,
  (error: AxiosError) => {
    if (error.response?.status === 401) {
      setStoredToken(null);
      for (const fn of unauthorizedListeners) fn();
    }
    return Promise.reject(error);
  },
);

// Pull a readable error message off whatever axios throws. The backend always
// returns `{ detail: string }` from HTTPException, but we also handle the
// CRM-style `{ ok: false, error, diagnostic }` shape and bare strings.
export function readApiError(err: unknown): string {
  if (axios.isAxiosError(err)) {
    const data = err.response?.data as
      | { detail?: string; error?: string; diagnostic?: string; message?: string }
      | undefined;
    if (data?.detail) return String(data.detail);
    if (data?.error) return String(data.error);
    if (data?.diagnostic) return String(data.diagnostic);
    if (data?.message) return String(data.message);
    if (err.response?.statusText) return `${err.response.status} ${err.response.statusText}`;
    if (err.code === "ECONNABORTED") return "请求超时";
    if (err.message) return err.message;
  }
  if (err instanceof Error) return err.message;
  return String(err);
}
