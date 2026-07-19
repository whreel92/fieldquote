'use client';

/**
 * /i/[token] — the public hosted invoice pay page (Phase 7). Customer-facing:
 * clean, light, trustworthy — same visual language as the hosted proposal.
 *
 * Flow: view invoice -> choose full or other amount -> card or bank (ACH,
 * lower fees) -> Stripe Checkout redirect. ACH settles in days, so the
 * ?paid=1 return renders a "processing" note until the webhook confirms.
 */

import { JetBrains_Mono, Plus_Jakarta_Sans } from 'next/font/google';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { invoiceApi, type PaymentMethod, type PublicInvoice } from '@/lib/invoice';
import { ApiError, formatUsd, money } from '@/lib/proposal';

const jakarta = Plus_Jakarta_Sans({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700', '800'],
});
const mono = JetBrains_Mono({ subsets: ['latin'], weight: ['400', '500'] });

type LoadState = 'loading' | 'error' | 'notfound' | 'ready';

function Money({ value, className = '' }: { value: number; className?: string }) {
  return <span className={`${mono.className} tabular-nums ${className}`}>{formatUsd(value)}</span>;
}

function dateLabel(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
}

const KIND_LABEL: Record<PublicInvoice['kind'], string> = {
  deposit: 'Deposit',
  progress: 'Progress payment',
  final: 'Final balance',
};

function StatusBadge({ status }: { status: PublicInvoice['status'] }) {
  const map: Record<string, { label: string; cls: string }> = {
    paid: { label: 'Paid', cls: 'border-emerald-300 bg-emerald-50 text-emerald-800' },
    partial: { label: 'Partially paid', cls: 'border-amber-300 bg-amber-50 text-amber-800' },
    overdue: { label: 'Overdue', cls: 'border-red-300 bg-red-50 text-red-700' },
    refunded: { label: 'Refunded', cls: 'border-slate-300 bg-slate-100 text-slate-600' },
    sent: { label: 'Due', cls: 'border-sky-300 bg-sky-50 text-sky-800' },
  };
  const tone = map[status] ?? map.sent;
  return (
    <span
      className={`inline-flex items-center rounded-full border px-3 py-1 text-xs font-semibold uppercase tracking-wide ${tone.cls}`}
    >
      {tone.label}
    </span>
  );
}

export default function InvoiceClient({
  token,
  paidReturn,
}: {
  token: string;
  paidReturn: boolean;
}) {
  const [state, setState] = useState<LoadState>('loading');
  const [invoice, setInvoice] = useState<PublicInvoice | null>(null);
  const [amountMode, setAmountMode] = useState<'full' | 'other'>('full');
  const [otherAmount, setOtherAmount] = useState('');
  const [method, setMethod] = useState<PaymentMethod>('card');
  const [paying, setPaying] = useState(false);
  const [payError, setPayError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const data = await invoiceApi.get(token);
      setInvoice(data);
      setState('ready');
    } catch (err) {
      setState(err instanceof ApiError && err.status === 404 ? 'notfound' : 'error');
    }
  }, [token]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const data = await invoiceApi.get(token);
        if (cancelled) return;
        setInvoice(data);
        setState('ready');
      } catch (err) {
        if (cancelled) return;
        setState(err instanceof ApiError && err.status === 404 ? 'notfound' : 'error');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token]);

  // After a checkout return, the webhook may land a beat later — refetch once.
  useEffect(() => {
    if (!paidReturn) return;
    const t = setTimeout(() => void load(), 2500);
    return () => clearTimeout(t);
  }, [paidReturn, load]);

  const balance = money(invoice?.balance_due);
  const payAmount = useMemo(() => {
    if (amountMode === 'full') return balance;
    const n = Number(otherAmount);
    return Number.isFinite(n) ? n : 0;
  }, [amountMode, otherAmount, balance]);

  const amountValid = payAmount >= 0.5 && payAmount <= balance + 1e-9;

  const startCheckout = useCallback(async () => {
    if (!invoice || paying) return;
    setPaying(true);
    setPayError(null);
    try {
      const { url } = await invoiceApi.checkout(token, {
        amount: amountMode === 'full' ? undefined : payAmount.toFixed(2),
        method,
      });
      window.location.href = url;
    } catch (err) {
      setPayError(
        err instanceof ApiError ? err.message : 'Could not start the payment. Please try again.',
      );
      setPaying(false);
    }
  }, [invoice, paying, token, amountMode, payAmount, method]);

  if (state === 'loading') {
    return (
      <main
        className={`${jakarta.className} flex min-h-screen items-center justify-center bg-slate-50`}
      >
        <p className="text-slate-500">Loading your invoice…</p>
      </main>
    );
  }
  if (state === 'notfound') {
    return (
      <main
        className={`${jakarta.className} flex min-h-screen items-center justify-center bg-slate-50 px-6`}
      >
        <div className="text-center">
          <h1 className="text-xl font-bold text-slate-900">Invoice not found</h1>
          <p className="mt-2 text-slate-500">
            This link may have expired. Contact your contractor for a fresh one.
          </p>
        </div>
      </main>
    );
  }
  if (state === 'error' || !invoice) {
    return (
      <main
        className={`${jakarta.className} flex min-h-screen items-center justify-center bg-slate-50 px-6`}
      >
        <div className="text-center">
          <h1 className="text-xl font-bold text-slate-900">Something went wrong</h1>
          <p className="mt-2 text-slate-500">Please refresh the page to try again.</p>
        </div>
      </main>
    );
  }

  const isPaid = invoice.status === 'paid';
  const isRefunded = invoice.status === 'refunded';
  const payable = !isPaid && !isRefunded && balance > 0;
  const canPayOnline = payable && invoice.payment.available && invoice.payment.stripe_live;
  const paid = money(invoice.amount_paid);
  const due = dateLabel(invoice.due_at);

  return (
    <main className={`${jakarta.className} min-h-screen bg-slate-50 pb-16`}>
      {/* Header band */}
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-2xl items-center justify-between px-6 py-6">
          <div className="flex items-center gap-3">
            {invoice.company.logo_url ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={invoice.company.logo_url}
                alt=""
                className="h-10 w-10 rounded-lg object-cover"
              />
            ) : null}
            <div>
              <p className="font-bold text-slate-900">{invoice.company.name}</p>
              {invoice.company.license_number ? (
                <p className="text-xs text-slate-500">License {invoice.company.license_number}</p>
              ) : null}
            </div>
          </div>
          <StatusBadge status={invoice.status} />
        </div>
      </header>

      <div className="mx-auto mt-8 flex max-w-2xl flex-col gap-6 px-6">
        {paidReturn && !isPaid ? (
          <div className="rounded-2xl border border-sky-200 bg-sky-50 p-5 text-sm text-sky-900">
            <p className="font-semibold">Payment processing</p>
            <p className="mt-1">
              Thanks — your payment was submitted. Bank (ACH) payments take 4–5 business days to
              settle; this page will show Paid once it clears.
            </p>
          </div>
        ) : null}
        {isPaid ? (
          <div className="rounded-2xl border border-emerald-200 bg-emerald-50 p-5 text-sm text-emerald-900">
            <p className="font-semibold">Paid in full — thank you!</p>
            {invoice.paid_at ? <p className="mt-1">Paid on {dateLabel(invoice.paid_at)}.</p> : null}
          </div>
        ) : null}

        {/* Invoice card */}
        <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm sm:p-8">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h1 className="text-lg font-extrabold text-slate-900">Invoice {invoice.number}</h1>
              <p className="mt-0.5 text-sm text-slate-500">
                {KIND_LABEL[invoice.kind]}
                {invoice.job_title ? ` — ${invoice.job_title}` : ''}
              </p>
            </div>
            {due && payable ? <p className="text-sm text-slate-500">Due {due}</p> : null}
          </div>

          <div className="mt-6 divide-y divide-slate-100">
            {invoice.line_items.map((item, i) => (
              <div key={i} className="flex items-start justify-between gap-4 py-3">
                <p className="text-slate-900">{item.description}</p>
                <Money value={money(item.amount)} className="shrink-0 text-slate-900" />
              </div>
            ))}
          </div>

          <div className="mt-4 space-y-2 border-t border-slate-200 pt-4 text-sm">
            <div className="flex justify-between text-slate-500">
              <span>Subtotal</span>
              <Money value={money(invoice.subtotal)} />
            </div>
            <div className="flex justify-between text-slate-500">
              <span>Tax</span>
              <Money value={money(invoice.tax)} />
            </div>
            {paid > 0 ? (
              <div className="flex justify-between text-emerald-700">
                <span>Paid to date</span>
                <Money value={-paid} />
              </div>
            ) : null}
            <div className="flex justify-between border-t border-slate-200 pt-3 text-base font-bold text-slate-900">
              <span>Balance due</span>
              <Money value={balance} />
            </div>
          </div>
        </section>

        {/* Pay card */}
        {payable ? (
          <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm sm:p-8">
            <h2 className="mb-4 text-xs font-bold uppercase tracking-[0.18em] text-slate-500">
              Pay online
            </h2>
            {canPayOnline ? (
              <>
                {/* Amount */}
                <fieldset className="border-0 p-0">
                  <legend className="mb-2 text-sm font-semibold text-slate-900">Amount</legend>
                  <div className="flex flex-col gap-2">
                    <label
                      className={`flex cursor-pointer items-center justify-between rounded-xl border p-4 ${
                        amountMode === 'full'
                          ? 'border-orange-500 bg-orange-50'
                          : 'border-slate-200'
                      }`}
                    >
                      <span className="flex items-center gap-3">
                        <input
                          type="radio"
                          name="amount-mode"
                          checked={amountMode === 'full'}
                          onChange={() => setAmountMode('full')}
                          className="accent-orange-600"
                        />
                        <span className="font-medium text-slate-900">Pay the full balance</span>
                      </span>
                      <Money value={balance} className="font-semibold text-slate-900" />
                    </label>
                    <label
                      className={`flex cursor-pointer items-center gap-3 rounded-xl border p-4 ${
                        amountMode === 'other'
                          ? 'border-orange-500 bg-orange-50'
                          : 'border-slate-200'
                      }`}
                    >
                      <input
                        type="radio"
                        name="amount-mode"
                        checked={amountMode === 'other'}
                        onChange={() => setAmountMode('other')}
                        className="accent-orange-600"
                      />
                      <span className="font-medium text-slate-900">Other amount</span>
                      {amountMode === 'other' ? (
                        <span className={`${mono.className} ml-auto flex items-center gap-1`}>
                          $
                          <input
                            type="number"
                            inputMode="decimal"
                            min="0.50"
                            max={balance}
                            step="0.01"
                            value={otherAmount}
                            onChange={(e) => setOtherAmount(e.target.value)}
                            placeholder="0.00"
                            aria-label="Payment amount"
                            className="w-28 rounded-lg border border-slate-300 px-2 py-1.5 text-right"
                          />
                        </span>
                      ) : null}
                    </label>
                  </div>
                  {amountMode === 'other' && otherAmount && !amountValid ? (
                    <p className="mt-2 text-sm text-red-600">
                      Enter an amount between $0.50 and {formatUsd(balance)}.
                    </p>
                  ) : null}
                </fieldset>

                {/* Method */}
                <fieldset className="mt-6 border-0 p-0">
                  <legend className="mb-2 text-sm font-semibold text-slate-900">
                    Payment method
                  </legend>
                  <div className="flex flex-col gap-2 sm:flex-row">
                    <label
                      className={`flex flex-1 cursor-pointer flex-col rounded-xl border p-4 ${
                        method === 'card' ? 'border-orange-500 bg-orange-50' : 'border-slate-200'
                      }`}
                    >
                      <span className="flex items-center gap-3">
                        <input
                          type="radio"
                          name="method"
                          checked={method === 'card'}
                          onChange={() => setMethod('card')}
                          className="accent-orange-600"
                        />
                        <span className="font-medium text-slate-900">Card</span>
                      </span>
                      <span className="mt-1 pl-7 text-xs text-slate-500">Instant confirmation</span>
                    </label>
                    <label
                      className={`flex flex-1 cursor-pointer flex-col rounded-xl border p-4 ${
                        method === 'us_bank_account'
                          ? 'border-orange-500 bg-orange-50'
                          : 'border-slate-200'
                      }`}
                    >
                      <span className="flex items-center gap-3">
                        <input
                          type="radio"
                          name="method"
                          checked={method === 'us_bank_account'}
                          onChange={() => setMethod('us_bank_account')}
                          className="accent-orange-600"
                        />
                        <span className="font-medium text-slate-900">Bank transfer (ACH)</span>
                      </span>
                      <span className="mt-1 pl-7 text-xs text-slate-500">
                        Lower fees — settles in 4–5 business days
                      </span>
                    </label>
                  </div>
                </fieldset>

                {payError ? <p className="mt-4 text-sm text-red-600">{payError}</p> : null}

                <button
                  type="button"
                  onClick={() => void startCheckout()}
                  disabled={paying || !amountValid}
                  className="mt-6 w-full rounded-xl bg-orange-600 px-6 py-4 text-base font-bold text-white shadow-sm transition hover:bg-orange-700 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {paying ? 'Redirecting…' : `Pay ${formatUsd(payAmount)}`}
                </button>
                <p className="mt-3 text-center text-xs text-slate-400">
                  Payments are processed securely by Stripe. Card details never touch FieldQuote.
                </p>
              </>
            ) : (
              <p className="text-sm text-slate-600">
                Online payment isn&apos;t available for this invoice — your contractor will follow
                up on how to pay
                {invoice.company.phone ? ` (or call ${invoice.company.phone})` : ''}.
              </p>
            )}
          </section>
        ) : null}

        {/* Payment history */}
        {invoice.payments.length > 0 ? (
          <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm sm:p-8">
            <h2 className="mb-4 text-xs font-bold uppercase tracking-[0.18em] text-slate-500">
              Payments
            </h2>
            <div className="divide-y divide-slate-100 text-sm">
              {invoice.payments.map((p, i) => (
                <div key={i} className="flex items-center justify-between py-2.5">
                  <span className="text-slate-500">
                    {p.status === 'refunded' ? 'Refund' : 'Payment'} —{' '}
                    {dateLabel(p.created_at) ?? ''}
                  </span>
                  <Money
                    value={money(p.amount)}
                    className={money(p.amount) < 0 ? 'text-red-600' : 'text-slate-900'}
                  />
                </div>
              ))}
            </div>
          </section>
        ) : null}

        <p className="text-center text-xs text-slate-400">
          Powered by FieldQuote — drafting software only, not a party to this agreement.
        </p>
      </div>
    </main>
  );
}
