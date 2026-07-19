/**
 * Typed API client. Attaches the Supabase access token; failures throw
 * `ApiError` carrying the server's error envelope (user-safe message).
 */

import type { components } from '@fieldquote/shared-types';

import { supabase } from '@/lib/supabase';

export type Me = components['schemas']['UserOut'];
export type Company = components['schemas']['CompanyOut'];
export type Rates = components['schemas']['RatesOut'];
export type RatesPut = components['schemas']['RatesPut'];
export type Client = components['schemas']['ClientOut'];
export type ClientIn = components['schemas']['ClientIn'];
export type Job = components['schemas']['JobOut'];
export type JobIn = components['schemas']['JobIn'];
export type JobPatch = components['schemas']['JobPatch'];
export type CaptureOut = components['schemas']['CaptureOut'];
export type CaptureCreated = components['schemas']['CaptureCreated'];
export type EstimateSummary = components['schemas']['EstimateSummary'];
export type EstimateDetail = components['schemas']['EstimateDetail'];

const BASE_URL = process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:8000';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const session = supabase ? (await supabase.auth.getSession()).data.session : null;
  const res = await fetch(`${BASE_URL}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(session ? { Authorization: `Bearer ${session.access_token}` } : {}),
      ...init.headers,
    },
  });
  if (res.status === 204) return undefined as T;
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const err = (body as { error?: { code: string; message: string } } | null)?.error;
    throw new ApiError(
      res.status,
      err?.code ?? 'unknown',
      err?.message ?? 'Something went wrong. Try again.',
      (err as { details?: Record<string, unknown> } | undefined)?.details ?? {},
    );
  }
  return body as T;
}

export const api = {
  me: () => request<Me>('/me'),
  company: {
    get: () => request<Company>('/company'),
    patch: (patch: Partial<Company>) =>
      request<Company>('/company', { method: 'PATCH', body: JSON.stringify(patch) }),
  },
  rates: {
    get: () => request<Rates>('/company/rates'),
    put: (body: RatesPut) =>
      request<Rates>('/company/rates', { method: 'PUT', body: JSON.stringify(body) }),
  },
  clients: {
    list: (search?: string) =>
      request<Client[]>(`/clients${search ? `?search=${encodeURIComponent(search)}` : ''}`),
    create: (body: ClientIn) =>
      request<Client>('/clients', { method: 'POST', body: JSON.stringify(body) }),
  },
  jobs: {
    list: () => request<Job[]>('/jobs'),
    get: (id: string) => request<Job>(`/jobs/${id}`),
    create: (body: JobIn) => request<Job>('/jobs', { method: 'POST', body: JSON.stringify(body) }),
    patch: (id: string, patch: JobPatch) =>
      request<Job>(`/jobs/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
    transition: (id: string, toStatus: string) =>
      request<Job>(`/jobs/${id}/transition`, {
        method: 'POST',
        body: JSON.stringify({ to_status: toStatus }),
      }),
  },
  captures: {
    create: (jobId: string, body: { kind: 'photo' | 'audio'; duration_s?: string | null }) =>
      request<CaptureCreated>(`/jobs/${jobId}/captures`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    complete: (captureId: string) =>
      request<CaptureOut>(`/captures/${captureId}/complete`, { method: 'POST' }),
    list: (jobId: string) => request<CaptureOut[]>(`/jobs/${jobId}/captures`),
  },
  estimates: {
    generate: (jobId: string) =>
      request<{ status: string; job_id: string }>(`/jobs/${jobId}/estimates/generate`, {
        method: 'POST',
      }),
    listForJob: (jobId: string) => request<EstimateSummary[]>(`/jobs/${jobId}/estimates`),
    get: (estimateId: string) => request<EstimateDetail>(`/estimates/${estimateId}`),
  },
};
