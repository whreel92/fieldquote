/**
 * Public hosted-proposal API client (Phase 6).
 *
 * The `/p/[token]` page is PUBLIC — no Supabase session, no auth header. It
 * talks to the FastAPI public router (apps/api/src/fieldquote/routers/public.py)
 * keyed only by the proposal's opaque token. Failures throw `ApiError` carrying
 * the server error envelope's user-safe message.
 */

const BASE_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:8000';

export type ProposalStatus = 'draft' | 'sent' | 'viewed' | 'signed' | 'declined' | 'expired';

export type LineType =
  | 'standard'
  | 'allowance'
  | 'verify'
  | 'option_good'
  | 'option_better'
  | 'option_best'
  | 'discount';

export type TierKey = 'good' | 'better' | 'best';

export interface DocCompany {
  name: string;
  logo_url?: string | null;
  license_number?: string | null;
  phone?: string | null;
  email?: string | null;
  address?: string | null;
}

export interface DocClient {
  name?: string | null;
  email?: string | null;
  address?: string | null;
}

export interface DocLine {
  description: string;
  qty: string;
  unit: string | null;
  line_type: string;
  confidence: string;
  total: string;
  note?: string | null;
  tier?: TierKey | null;
  tier_label?: string | null;
  selected: boolean;
}

export interface DocOptionGroup {
  base_description: string;
  tiers: DocLine[];
}

export interface ProposalDocument {
  company: DocCompany;
  client: DocClient;
  title: string;
  cover_photo_url: string | null;
  intro_message: string;
  scope_prose: string;
  lines: DocLine[];
  option_groups: DocOptionGroup[];
  inclusions: string[];
  exclusions: string[];
  subtotal: string;
  tax: string;
  total: string;
  deposit_label: string;
  deposit_amount: string;
  validity_days: number;
  company_terms: string;
  platform_disclaimer: string;
  esign_consent: string;
  terms_version: string;
}

export interface PaymentState {
  /** Contractor has a Stripe account that can accept charges. */
  available: boolean;
  /** Stripe is configured in this environment (live/test keys present). */
  stripe_live: boolean;
  deposit_paid: boolean;
  deposit_amount: string | null;
  invoice_token: string | null;
}

export interface PublicProposal {
  status: ProposalStatus;
  document: ProposalDocument;
  signed: boolean;
  signer_name: string | null;
  expires_at: string | null;
  payment: PaymentState;
}

export interface SignInput {
  signer_name: string;
  signer_email?: string;
  consent: boolean;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${BASE_URL}${path}`, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        ...init.headers,
      },
    });
  } catch {
    throw new ApiError(0, 'network', 'Could not reach the server. Check your connection.');
  }
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const err = (body as { error?: { code: string; message: string } } | null)?.error;
    throw new ApiError(
      res.status,
      err?.code ?? 'unknown',
      err?.message ?? 'Something went wrong. Please try again.',
    );
  }
  return body as T;
}

export const proposalApi = {
  get: (token: string) => request<PublicProposal>(`/p/${encodeURIComponent(token)}`),
  sign: (token: string, input: SignInput) =>
    request<PublicProposal>(`/p/${encodeURIComponent(token)}/sign`, {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  checkout: (token: string) =>
    request<{ url: string }>(`/p/${encodeURIComponent(token)}/checkout`, {
      method: 'POST',
    }),
  decline: (token: string, reason?: string) =>
    request<PublicProposal>(`/p/${encodeURIComponent(token)}/decline`, {
      method: 'POST',
      body: JSON.stringify({ reason: reason || null }),
    }),
};

/** Parse a money string ("1234.56") to a number; 0 on garbage. */
export function money(value: string | null | undefined): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

const USD = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

/** Format a number as USD ("$1,234.56"). */
export function formatUsd(value: number): string {
  return USD.format(value);
}

export type LineBucket = 'labor' | 'allowance' | 'verify';

/** Categorize a line into exactly one bucket (verify > allowance > labor). */
export function bucketOf(line: DocLine): LineBucket {
  if (line.line_type === 'verify' || line.confidence === 'verify') return 'verify';
  if (line.line_type === 'allowance' || line.confidence === 'allowance') return 'allowance';
  return 'labor';
}
