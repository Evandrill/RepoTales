import type { GenerateRequest, SagaPayload } from '../types/saga'

/**
 * Dev uses the Vite proxy (`/api` -> http://127.0.0.1:8080), so no CORS is
 * involved. A deployment can override the origin with VITE_API_BASE_URL
 * (e.g. "http://localhost:8000") or a path with VITE_API_BASE.
 */
const ENV = import.meta.env ?? {}
const API_BASE = ENV.VITE_API_BASE_URL ?? ENV.VITE_API_BASE ?? '/api'

/**
 * The backend puts browser-facing proxy paths in the saga payload
 * (`/api/image-proxy?prompt=...`). In dev that path already goes through the
 * Vite proxy; with `VITE_API_BASE_URL=http://host:8080` the `/api` prefix has
 * to be replaced by the configured origin instead.
 */
export function resolveAssetUrl(url?: string | null): string | null {
  if (!url) return null
  if (url.startsWith('/api/')) return `${API_BASE}${url.slice('/api'.length)}`
  return url
}

export class ApiError extends Error {
  readonly status: number

  constructor(message: string, status: number) {
    super(message)
    this.name = 'ApiError'
    this.status = status
  }
}

/** FastAPI returns `detail` as a string, or as an array for 422s. */
async function readError(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { detail?: unknown }
    const { detail } = body
    if (typeof detail === 'string') return detail
    if (Array.isArray(detail)) {
      return detail
        .map((d) => {
          const item = d as { loc?: unknown[]; msg?: string }
          const field = Array.isArray(item.loc) ? item.loc.slice(1).join('.') : ''
          return field ? `${field}: ${item.msg}` : item.msg
        })
        .join(' · ')
    }
  } catch {
    // Body was not JSON — fall through to the generic message.
  }
  // Language-neutral token: App.tsx translates it for the active UI language.
  return `HTTP ${res.status}`
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response
  try {
    res = await fetch(`${API_BASE}${path}`, {
      headers: { 'Content-Type': 'application/json' },
      ...init,
    })
  } catch {
    throw new ApiError(
      'API injoignable. Le backend tourne-t-il sur http://127.0.0.1:8080 ?',
      0,
    )
  }
  if (!res.ok) throw new ApiError(await readError(res), res.status)
  return (await res.json()) as T
}

/**
 * Generate a saga. Expect 10-60s: the backend fetches commits from GitHub
 * (1 + limit requests) before calling the model.
 */
export function generateSaga(
  payload: GenerateRequest,
  signal?: AbortSignal,
): Promise<SagaPayload> {
  return request<SagaPayload>('/saga/generate', {
    method: 'POST',
    body: JSON.stringify(payload),
    signal,
  })
}

/**
 * Instant, no GitHub quota, no GPU — use this to build the UI.
 * `lang` selects the backend's translated mock (chapter titles, captions,
 * dialogues and boss name are all in that language).
 */
export function getMockSaga(lang: 'en' | 'fr' = 'en'): Promise<SagaPayload> {
  return request<SagaPayload>(`/saga/mock?lang=${lang}`)
}
