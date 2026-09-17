import type { ApiErrorBody, ConflictDetail } from "@clubcal/shared";

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public fields: Record<string, string[]> = {},
    public conflicts: ConflictDetail[] = [],
    public currentVersion?: number,
  ) {
    super(message);
  }
  get isNetwork() {
    return this.status === 0;
  }
}

let csrfToken: string | null = null;
export const setCsrfToken = (t: string | null) => {
  csrfToken = t;
};

async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (method !== "GET" && csrfToken) headers["X-CSRF-Token"] = csrfToken;
  let res: Response;
  try {
    res = await fetch(url, { method, headers, credentials: "same-origin", body: body === undefined ? undefined : JSON.stringify(body) });
  } catch {
    throw new ApiError(0, "network", "Can't reach the server. Check your connection; we'll keep retrying.");
  }
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (!res.ok) {
    const e = (data as ApiErrorBody | null)?.error;
    throw new ApiError(res.status, e?.code ?? "http_error", e?.message ?? `Request failed (${res.status})`, e?.fields, e?.conflicts, e?.currentVersion);
  }
  return data as T;
}

export const api = {
  get: <T>(url: string) => request<T>("GET", url),
  post: <T>(url: string, body: unknown = {}) => request<T>("POST", url, body),
  put: <T>(url: string, body: unknown) => request<T>("PUT", url, body),
  patch: <T>(url: string, body: unknown) => request<T>("PATCH", url, body),
  del: <T>(url: string) => request<T>("DELETE", url),
};

export function qs(params: Record<string, string | number | boolean | undefined | null>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== "") p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : "";
}

export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error) return err.message;
  return "Something went wrong.";
}
