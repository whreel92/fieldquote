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
    createManual: (jobId: string, scopeProse = '') =>
      request<EstimateDetail>(`/jobs/${jobId}/estimates`, {
        method: 'POST',
        body: JSON.stringify({ scope_prose: scopeProse }),
      }),
    patch: (id: string, body: { margin_override_pct?: string; scope_prose?: string }) =>
      request<EstimateDetail>(`/estimates/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      }),
    addLine: (
      id: string,
      body: {
        assembly_code?: string | null;
        qty?: string | number;
        modifiers?: string[];
        description?: string;
        unit_price?: string;
        line_type?: 'standard' | 'allowance' | 'verify';
        editable_note?: string;
      },
    ) =>
      request<EstimateDetail>(`/estimates/${id}/lines`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    patchLine: (
      id: string,
      lineId: string,
      body: {
        qty?: string;
        modifiers?: string[];
        description?: string;
        unit_price?: string;
        labor_hours?: string;
        material_cost?: string;
        editable_note?: string;
      },
    ) =>
      request<EstimateDetail>(`/estimates/${id}/lines/${lineId}`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      }),
    deleteLine: (id: string, lineId: string) =>
      request<EstimateDetail>(`/estimates/${id}/lines/${lineId}`, { method: 'DELETE' }),
    convertAllowance: (id: string, lineId: string, amount: string) =>
      request<EstimateDetail>(`/estimates/${id}/lines/${lineId}/convert`, {
        method: 'POST',
        body: JSON.stringify({ amount }),
      }),
    buildOptions: (
      id: string,
      lineId: string,
      body: {
        tiers: { tier: 'good' | 'better' | 'best'; label: string; total: string }[];
        selected: 'good' | 'better' | 'best';
      },
    ) =>
      request<EstimateDetail>(`/estimates/${id}/lines/${lineId}/options`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    approve: (id: string, confirmations: Record<string, boolean>) =>
      request<EstimateDetail>(`/estimates/${id}/approve`, {
        method: 'POST',
        body: JSON.stringify({ confirmations }),
      }),
    fork: (id: string) => request<EstimateDetail>(`/estimates/${id}/fork`, { method: 'POST' }),
    diff: (id: string, otherId: string) =>
      request<Record<string, unknown>>(`/estimates/${id}/diff/${otherId}`),
    suggestions: (id: string) =>
      request<{
        suggestions: { assembly_code: string | null; description: string; reason: string }[];
      }>(`/estimates/${id}/suggestions`, { method: 'POST' }),
    createProposal: (id: string) =>
      request<{ id: string; status: string; public_token: string }>(`/estimates/${id}/proposals`, {
        method: 'POST',
      }),
  },
  catalog: {
    searchAssemblies: (q: string, jobType?: string) =>
      request<{
        items: {
          code: string;
          name: string;
          unit: string;
          labor_hours: string;
          job_type_codes: string[];
          modifiers_allowed: string[];
          option_tiers: unknown[] | null;
          status: string;
        }[];
      }>(
        `/catalog/assemblies?${new URLSearchParams({
          ...(q ? { q } : {}),
          ...(jobType ? { job_type: jobType } : {}),
        }).toString()}`,
      ),
    modifiers: () =>
      request<{
        items: { code: string; name: string; description: string | null }[];
      }>(`/catalog/modifiers`),
  },
  proposals: {
    get: (id: string) => request<ProposalWithDocument>(`/proposals/${id}`),
    listForEstimate: (estimateId: string) =>
      request<Proposal[]>(`/estimates/${estimateId}/proposals`),
    listForJob: (jobId: string) => request<Proposal[]>(`/jobs/${jobId}/proposals`),
    updateConfig: (id: string, config: ProposalConfig) =>
      request<ProposalWithDocument>(`/proposals/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(config),
      }),
    send: (id: string) =>
      request<ProposalWithDocument>(`/proposals/${id}/send`, { method: 'POST' }),
    newVersion: (estimateId: string) =>
      request<Proposal>(`/estimates/${estimateId}/duplicate-proposal`, { method: 'POST' }),
  },
  stripeConnect: {
    status: () =>
      request<{
        connected: boolean;
        charges_enabled: boolean;
        details_submitted: boolean;
        payouts_enabled: boolean;
        account_id: string | null;
      }>(`/stripe/connect/status`),
    onboard: () => request<{ url: string }>(`/stripe/connect/onboard`, { method: 'POST' }),
  },
  money: {
    summary: () => request<MoneySummary>(`/money/summary`),
  },
  invoices: {
    detail: (id: string) => request<InvoiceDetail>(`/invoices/${id}`),
    remind: (id: string) => request<Invoice>(`/invoices/${id}/remind`, { method: 'POST' }),
    refund: (id: string, amount?: string) =>
      request<InvoiceDetail>(`/invoices/${id}/refund`, {
        method: 'POST',
        body: JSON.stringify(amount ? { amount } : {}),
      }),
    send: (id: string) => request<Invoice>(`/invoices/${id}/send`, { method: 'POST' }),
  },
};

export interface ProposalConfig {
  title?: string;
  cover_photo_url?: string | null;
  intro_message?: string;
  inclusions?: string[];
  exclusions?: string[];
  deposit?: { kind: 'percent' | 'flat'; value: string };
  validity_days?: number;
  company_terms?: string;
}

export type Proposal = {
  id: string;
  estimate_id: string;
  version: number;
  status: string;
  public_token: string;
  content_hash: string | null;
  config: Record<string, unknown>;
  sent_at: string | null;
  first_viewed_at: string | null;
  view_count: number;
  expires_at: string | null;
};

export type ProposalWithDocument = Proposal & {
  document: Record<string, unknown>;
  signature: { signer_name: string; signed_at: string; signature_hash: string } | null;
};

export type Invoice = {
  id: string;
  job_id: string;
  job_title: string | null;
  kind: 'deposit' | 'progress' | 'final';
  number: string;
  status: string;
  line_items: { description?: string; amount?: string }[];
  subtotal: string;
  tax: string;
  total: string;
  amount_paid: string;
  balance_due: string;
  due_at: string | null;
  public_token: string | null;
  sent_at: string | null;
  paid_at: string | null;
  created_at: string;
};

export type PaymentRow = {
  id: string;
  amount: string;
  fee: string | null;
  net: string | null;
  status: string;
  created_at: string;
};

export type InvoiceDetail = Invoice & { payments: PaymentRow[] };

export type MoneySummary = {
  outstanding: string;
  paid_this_month: string;
  in_transit: string;
  invoices: Invoice[];
};
