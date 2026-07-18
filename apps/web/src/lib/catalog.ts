/**
 * Catalog admin API client (Phase 2 internal tooling).
 * Talks to the FastAPI backend with the Supabase access token; failures throw
 * `ApiError` carrying the server error envelope (user-safe message).
 */

import { supabase } from '@/lib/supabase';

export type AssemblyStatus = 'draft' | 'advisor_approved';

export interface BomItem {
  sku: string;
  qty: number;
}

export interface Assembly {
  code: string;
  name: string;
  description: string;
  job_type_codes: string[];
  unit: string;
  labor_hours: number;
  helper_hours: number;
  labor_notes: string;
  bom: BomItem[];
  modifiers_allowed: string[];
  option_tiers: Record<string, unknown>[] | null;
  version: number;
  status: AssemblyStatus;
}

export interface Modifier {
  code: string;
  name: string;
  description: string;
  effect: Record<string, unknown>;
}

export interface AssemblyPatch {
  labor_hours?: number;
  labor_notes?: string;
  description?: string;
  status?: AssemblyStatus;
}

const BASE_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:8000';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const session = supabase ? (await supabase.auth.getSession()).data.session : null;
  let res: Response;
  try {
    res = await fetch(`${BASE_URL}${path}`, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        ...(session ? { Authorization: `Bearer ${session.access_token}` } : {}),
        ...init.headers,
      },
    });
  } catch {
    throw new ApiError(0, 'network', 'Could not reach the API. Check your connection.');
  }
  if (res.status === 204) return undefined as T;
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const err = (body as { error?: { code: string; message: string } } | null)?.error;
    throw new ApiError(
      res.status,
      err?.code ?? 'unknown',
      err?.message ?? 'Something went wrong. Try again.',
    );
  }
  return body as T;
}

export const catalogApi = {
  assemblies: () => request<{ items: Assembly[] }>('/catalog/assemblies'),
  modifiers: () => request<{ items: Modifier[] }>('/catalog/modifiers'),
  patchAssembly: (code: string, patch: AssemblyPatch) =>
    request<Assembly>(`/catalog/assemblies/${encodeURIComponent(code)}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }),
};
