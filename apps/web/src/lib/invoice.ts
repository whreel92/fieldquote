/**
 * Public hosted-invoice API client (Phase 7).
 *
 * The `/i/[token]` pay page is PUBLIC — no Supabase session, no auth header.
 * It talks to the FastAPI public-invoices router
 * (apps/api/src/fieldquote/routers/public_invoices.py) keyed only by the
 * invoice's opaque token.
 */

import { ApiError } from '@/lib/proposal';

const BASE_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:8000';

export type InvoiceStatus = 'sent' | 'partial' | 'overdue' | 'paid' | 'refunded';
export type PaymentMethod = 'card' | 'us_bank_account';

export interface InvoiceCompany {
  name: string;
  logo_url?: string | null;
  license_number?: string | null;
  phone?: string | null;
  email?: string | null;
  address?: string | null;
}

export interface InvoiceLineItem {
  description: string;
  amount: string;
}

export interface PublicPaymentRow {
  amount: string;
  status: string;
  created_at: string;
}

export interface InvoicePaymentState {
  available: boolean;
  stripe_live: boolean;
  methods: PaymentMethod[];
}

export interface PublicInvoice {
  status: InvoiceStatus;
  number: string;
  kind: 'deposit' | 'progress' | 'final';
  company: InvoiceCompany;
  job_title: string | null;
  line_items: InvoiceLineItem[];
  subtotal: string;
  tax: string;
  total: string;
  amount_paid: string;
  balance_due: string;
  due_at: string | null;
  paid_at: string | null;
  payments: PublicPaymentRow[];
  payment: InvoicePaymentState;
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${BASE_URL}${path}`, {
      ...init,
      headers: { 'Content-Type': 'application/json', ...init.headers },
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

export const invoiceApi = {
  get: (token: string) => request<PublicInvoice>(`/i/${encodeURIComponent(token)}`),
  checkout: (token: string, input: { amount?: string; method: PaymentMethod }) =>
    request<{ url: string }>(`/i/${encodeURIComponent(token)}/checkout`, {
      method: 'POST',
      body: JSON.stringify(input),
    }),
};
