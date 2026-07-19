'use client';

/**
 * /p/[token] — the public hosted proposal (Phase 6). Customer-facing, so this
 * is intentionally NOT the dark app chrome: clean, light, trustworthy, lots of
 * white space, safety-orange used sparingly for the one action that matters.
 *
 * Flow: view -> pick options (live total) -> Accept & Sign -> Pay deposit.
 * Signature capture (IP/UA/timestamp) is entirely server-side; the client only
 * collects a typed name + explicit e-sign consent. Sent documents are immutable,
 * so everything here renders the frozen `document` snapshot verbatim.
 */

import { JetBrains_Mono, Plus_Jakarta_Sans } from 'next/font/google';
import { useCallback, useEffect, useMemo, useState } from 'react';

import {
  ApiError,
  bucketOf,
  formatUsd,
  money,
  proposalApi,
  type DocLine,
  type DocOptionGroup,
  type PublicProposal,
} from '@/lib/proposal';

const jakarta = Plus_Jakarta_Sans({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700', '800'],
});
const mono = JetBrains_Mono({ subsets: ['latin'], weight: ['400', '500'] });

type LoadState = 'loading' | 'error' | 'notfound' | 'ready';

const TIER_FALLBACK: Record<string, string> = { good: 'Good', better: 'Better', best: 'Best' };

/* ------------------------------- primitives ------------------------------ */

function Money({ value, className = '' }: { value: number; className?: string }) {
  return <span className={`${mono.className} tabular-nums ${className}`}>{formatUsd(value)}</span>;
}

function CheckIcon({ className = '' }: { className?: string }) {
  return (
    <svg viewBox="0 0 20 20" fill="currentColor" aria-hidden className={className}>
      <path
        fillRule="evenodd"
        d="M16.7 5.3a1 1 0 0 1 0 1.4l-7.5 7.5a1 1 0 0 1-1.4 0l-3.5-3.5a1 1 0 1 1 1.4-1.4l2.8 2.79 6.8-6.79a1 1 0 0 1 1.4 0Z"
        clipRule="evenodd"
      />
    </svg>
  );
}

function SectionCard({
  title,
  children,
  className = '',
}: {
  title?: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section
      className={`rounded-2xl border border-slate-200 bg-white p-6 shadow-sm sm:p-8 ${className}`}
    >
      {title ? (
        <h2 className="mb-4 text-xs font-bold uppercase tracking-[0.18em] text-slate-500">
          {title}
        </h2>
      ) : null}
      {children}
    </section>
  );
}

function ConfidenceBadge({ kind }: { kind: 'allowance' | 'verify' }) {
  const map = {
    allowance: 'border-amber-300 bg-amber-50 text-amber-800',
    verify: 'border-sky-300 bg-sky-50 text-sky-800',
  } as const;
  return (
    <span
      className={`inline-flex items-center whitespace-nowrap rounded-full border px-2.5 py-0.5 text-[11px] font-semibold uppercase tracking-wide ${map[kind]}`}
    >
      {kind === 'allowance' ? 'Allowance' : 'Verify on site'}
    </span>
  );
}

function LineRow({ line, accent }: { line: DocLine; accent?: 'allowance' | 'verify' }) {
  const border =
    accent === 'allowance'
      ? 'border-l-4 border-l-amber-400 pl-4'
      : accent === 'verify'
        ? 'border-l-4 border-l-sky-400 pl-4'
        : '';
  const qty = money(line.qty);
  const showQty = qty !== 1 || (line.unit && line.unit !== 'ea');
  return (
    <div className={`py-3.5 ${border}`}>
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <p className="font-semibold text-slate-900">{line.description}</p>
            {accent ? <ConfidenceBadge kind={accent} /> : null}
          </div>
          {showQty ? (
            <p className={`${mono.className} mt-0.5 text-xs text-slate-500`}>
              {line.qty}
              {line.unit ? ` ${line.unit}` : ''}
            </p>
          ) : null}
          {line.note ? <p className="mt-1.5 text-sm text-slate-500">{line.note}</p> : null}
        </div>
        <Money value={money(line.total)} className="shrink-0 text-slate-900" />
      </div>
    </div>
  );
}

/* ------------------------------ option cards ----------------------------- */

function OptionGroup({
  group,
  selectedIndex,
  onSelect,
}: {
  group: DocOptionGroup;
  selectedIndex: number;
  onSelect: (index: number) => void;
}) {
  const name = `opt-${group.base_description.replace(/\s+/g, '-')}`;
  return (
    <fieldset className="border-0 p-0">
      <legend className="mb-3 font-semibold text-slate-900">{group.base_description}</legend>
      <div className="flex flex-col gap-3">
        {group.tiers.map((tier, i) => {
          const active = i === selectedIndex;
          const label =
            tier.tier_label ?? (tier.tier ? TIER_FALLBACK[tier.tier] : `Option ${i + 1}`);
          return (
            <label
              key={i}
              className={`flex cursor-pointer items-start gap-3 rounded-xl border-2 p-4 transition-colors duration-150 ${
                active
                  ? 'border-orange-500 bg-orange-50/60 ring-1 ring-orange-500'
                  : 'border-slate-200 bg-white hover:border-slate-300'
              }`}
            >
              <input
                type="radio"
                name={name}
                checked={active}
                onChange={() => onSelect(i)}
                className="sr-only"
              />
              <span
                aria-hidden
                className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border-2 ${
                  active
                    ? 'border-orange-500 bg-orange-500 text-white'
                    : 'border-slate-300 bg-white'
                }`}
              >
                {active ? <CheckIcon className="h-3.5 w-3.5" /> : null}
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex flex-wrap items-baseline justify-between gap-2">
                  <span className="font-semibold text-slate-900">{label}</span>
                  <Money value={money(tier.total)} className="text-slate-900" />
                </span>
                {tier.description && tier.description !== group.base_description ? (
                  <span className="mt-1 block text-sm text-slate-500">{tier.description}</span>
                ) : null}
              </span>
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}

/* ------------------------------ decline modal ---------------------------- */

function DeclineModal({
  onClose,
  onConfirm,
  busy,
  error,
}: {
  onClose: () => void;
  onConfirm: (reason: string) => void;
  busy: boolean;
  error: string | null;
}) {
  const [reason, setReason] = useState('');
  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-slate-900/50 p-4 backdrop-blur-sm sm:items-center"
      role="dialog"
      aria-modal="true"
      aria-labelledby="decline-title"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md rounded-2xl bg-white p-6 shadow-xl sm:p-8"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 id="decline-title" className="text-lg font-bold text-slate-900">
          Decline this proposal?
        </h2>
        <p className="mt-2 text-sm text-slate-500">
          Let the contractor know if something isn&apos;t right — this is optional.
        </p>
        <textarea
          rows={3}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          disabled={busy}
          placeholder="Reason (optional)"
          className="mt-4 w-full rounded-lg border border-slate-300 bg-white px-3.5 py-3 text-base text-slate-900 transition-colors focus:border-slate-900 focus:outline-none focus:ring-2 focus:ring-slate-900/20 disabled:bg-slate-100"
        />
        {error ? <p className="mt-3 text-sm text-red-600">{error}</p> : null}
        <div className="mt-5 flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="min-h-[48px] cursor-pointer rounded-lg border border-slate-300 px-5 py-3 text-sm font-semibold text-slate-700 transition-colors hover:bg-slate-50 disabled:opacity-50"
          >
            Keep reviewing
          </button>
          <button
            type="button"
            onClick={() => onConfirm(reason)}
            disabled={busy}
            className="min-h-[48px] cursor-pointer rounded-lg bg-red-600 px-5 py-3 text-sm font-semibold text-white transition-colors hover:bg-red-700 disabled:opacity-50"
          >
            {busy ? 'Declining…' : 'Decline proposal'}
          </button>
        </div>
      </div>
    </div>
  );
}

/* --------------------------------- page ---------------------------------- */

type ProposalLoad = {
  key: string;
  state: LoadState;
  data: PublicProposal | null;
};

export default function ProposalClient({
  token,
  paidReturn,
}: {
  token: string;
  paidReturn: boolean;
}) {
  const [reload, setReload] = useState(0);
  const loadKey = `${token}:${reload}`;
  const [load, setLoad] = useState<ProposalLoad>({
    key: loadKey,
    state: 'loading',
    data: null,
  });

  const [selectedTiers, setSelectedTiers] = useState<Record<number, number>>({});

  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [consent, setConsent] = useState(false);
  const [signing, setSigning] = useState(false);
  const [signError, setSignError] = useState<string | null>(null);
  const [justSignedAt, setJustSignedAt] = useState<Date | null>(null);

  const [paying, setPaying] = useState(false);
  const [payError, setPayError] = useState<string | null>(null);

  const [declineOpen, setDeclineOpen] = useState(false);
  const [declining, setDeclining] = useState(false);
  const [declineError, setDeclineError] = useState<string | null>(null);

  // Stripe success redirect: /p/[token]?paid=1 → show a thank-you and refetch.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const params = new URLSearchParams(window.location.search);
    if (params.get('paid') === '1') {
      // Clean the URL so a refresh doesn't re-trigger the banner.
      window.history.replaceState(null, '', window.location.pathname);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const result = await proposalApi.get(token);
        if (cancelled) return;
        setLoad({ key: loadKey, state: 'ready', data: result });
      } catch (e) {
        if (cancelled) return;
        setLoad({
          key: loadKey,
          state: e instanceof ApiError && e.status === 404 ? 'notfound' : 'error',
          data: null,
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token, loadKey]);

  const state = load.key === loadKey ? load.state : 'loading';
  const data = load.key === loadKey ? load.data : null;
  const doc = data?.document ?? null;

  const defaultTierIndex = useCallback((group: DocOptionGroup) => {
    const idx = group.tiers.findIndex((t) => t.selected);
    return idx >= 0 ? idx : 0;
  }, []);

  // Live total: base already includes each group's default tier; swap in the
  // customer's pick (total = base - defaultTierTotal + chosenTierTotal).
  const liveTotal = useMemo(() => {
    if (!doc) return 0;
    let total = money(doc.total);
    doc.option_groups.forEach((group, gi) => {
      const di = defaultTierIndex(group);
      const ci = selectedTiers[gi] ?? di;
      total += money(group.tiers[ci]?.total) - money(group.tiers[di]?.total);
    });
    return total;
  }, [doc, selectedTiers, defaultTierIndex]);

  const grouped = useMemo(() => {
    const labor: DocLine[] = [];
    const allowances: DocLine[] = [];
    const verify: DocLine[] = [];
    doc?.lines.forEach((line) => {
      const b = bucketOf(line);
      if (b === 'allowance') allowances.push(line);
      else if (b === 'verify') verify.push(line);
      else labor.push(line);
    });
    return { labor, allowances, verify };
  }, [doc]);

  const handleSign = useCallback(async () => {
    setSigning(true);
    setSignError(null);
    try {
      const updated = await proposalApi.sign(token, {
        signer_name: name.trim(),
        signer_email: email.trim() || undefined,
        consent,
      });
      setJustSignedAt(new Date());
      setLoad((current) => ({ ...current, state: 'ready', data: updated }));
    } catch (e) {
      setSignError(e instanceof ApiError ? e.message : 'Could not sign. Please try again.');
    } finally {
      setSigning(false);
    }
  }, [token, name, email, consent]);

  const handlePay = useCallback(async () => {
    setPaying(true);
    setPayError(null);
    try {
      const { url } = await proposalApi.checkout(token);
      window.location.href = url; // Redirect to Stripe Checkout (do not clear busy).
    } catch (e) {
      setPaying(false);
      setPayError(
        e instanceof ApiError ? e.message : 'Could not start checkout. Please try again.',
      );
    }
  }, [token]);

  const handleDecline = useCallback(
    async (reason: string) => {
      setDeclining(true);
      setDeclineError(null);
      try {
        const updated = await proposalApi.decline(token, reason.trim() || undefined);
        setLoad((current) => ({ ...current, state: 'ready', data: updated }));
        setDeclineOpen(false);
      } catch (e) {
        setDeclineError(e instanceof ApiError ? e.message : 'Could not decline. Please try again.');
      } finally {
        setDeclining(false);
      }
    },
    [token],
  );

  /* ------------------------------ load states ---------------------------- */

  if (state === 'loading') {
    return (
      <main className={`${jakarta.className} flex-1 bg-slate-50`}>
        <div className="h-1.5 w-full bg-orange-500" />
        <div className="mx-auto w-full max-w-3xl px-4 py-8">
          <div className="animate-pulse space-y-6">
            <div className="h-16 rounded-2xl bg-slate-200" />
            <div className="h-48 rounded-2xl bg-slate-200" />
            <div className="h-64 rounded-2xl bg-slate-200" />
            <div className="h-40 rounded-2xl bg-slate-200" />
          </div>
        </div>
      </main>
    );
  }

  if (state === 'notfound') {
    return (
      <CenteredCard
        title="This proposal isn't available"
        body="The link may be incorrect, or the proposal hasn't been sent yet. Please check with your contractor for an up-to-date link."
      />
    );
  }

  if (state === 'error' || !data || !doc) {
    return (
      <CenteredCard
        title="Something went wrong"
        body="We couldn't load this proposal. Please check your connection and try again."
        action={
          <button
            type="button"
            onClick={() => setReload((n) => n + 1)}
            className="mt-6 min-h-[48px] cursor-pointer rounded-lg bg-slate-900 px-6 py-3 text-sm font-semibold text-white transition-colors hover:bg-slate-800"
          >
            Try again
          </button>
        }
      />
    );
  }

  /* -------------------------------- ready -------------------------------- */

  const { company, client } = doc;
  const status = data.status;
  const isSigned = data.signed || status === 'signed';
  const isDeclined = status === 'declined';
  const isExpired = status === 'expired';
  const canSign = !isSigned && !isDeclined && !isExpired;
  const hasOptions = doc.option_groups.length > 0;

  const payment = data.payment;
  const depositPaid = payment.deposit_paid || paidReturn;
  const depositAmount = payment.deposit_amount ?? doc.deposit_amount;
  const signerName = data.signer_name ?? name.trim();

  return (
    <main className={`${jakarta.className} flex-1 bg-slate-50 text-slate-900`}>
      {/* Panel-rail identity: a single safety-orange rule. Sparingly. */}
      <div className="h-1.5 w-full bg-orange-500" />

      {/* Branded header — clean and light, not the dark app chrome. */}
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex w-full max-w-3xl flex-wrap items-center gap-4 px-4 py-5">
          {company.logo_url ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={company.logo_url}
              alt={`${company.name} logo`}
              className="h-12 w-12 rounded-lg object-contain"
            />
          ) : (
            <div className="flex h-12 w-12 items-center justify-center rounded-lg bg-slate-900 text-lg font-extrabold text-white">
              {company.name.charAt(0).toUpperCase()}
            </div>
          )}
          <div className="min-w-0 flex-1">
            <p className="truncate text-lg font-extrabold tracking-tight text-slate-900">
              {company.name}
            </p>
            <p className="text-xs text-slate-500">
              {company.license_number ? (
                <span className={mono.className}>Lic. {company.license_number}</span>
              ) : null}
              {company.license_number && (company.phone || company.email) ? ' · ' : ''}
              {company.phone ?? company.email ?? ''}
            </p>
          </div>
        </div>
      </header>

      <div className="mx-auto w-full max-w-3xl space-y-6 px-4 py-8">
        {/* Status banners */}
        {isExpired ? (
          <Banner tone="warning" title="This proposal has expired">
            The validity period has passed. Contact {company.name} for an updated proposal.
          </Banner>
        ) : null}
        {isDeclined ? (
          <Banner tone="neutral" title="This proposal was declined">
            You&apos;ve declined this proposal. If that was a mistake, contact {company.name}.
          </Banner>
        ) : null}
        {depositPaid ? (
          <Banner tone="success" title="Deposit received — thank you!">
            Your deposit has been paid and {company.name} has been notified. You&apos;re all set.
          </Banner>
        ) : null}

        {/* Title + cover */}
        <div>
          <h1 className="text-2xl font-extrabold tracking-tight text-slate-900 sm:text-3xl">
            {doc.title}
          </h1>
          {client.name ? (
            <p className="mt-1 text-sm text-slate-500">Prepared for {client.name}</p>
          ) : null}
        </div>
        {doc.cover_photo_url ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={doc.cover_photo_url}
            alt={doc.title}
            className="max-h-80 w-full rounded-2xl border border-slate-200 object-cover shadow-sm"
          />
        ) : null}

        {/* Intro */}
        {doc.intro_message.trim() ? (
          <SectionCard>
            <p className="whitespace-pre-line text-base leading-relaxed text-slate-700">
              {doc.intro_message}
            </p>
          </SectionCard>
        ) : null}

        {/* Scope */}
        {doc.scope_prose.trim() ? (
          <SectionCard title="Scope of work">
            <div className="whitespace-pre-line text-base leading-relaxed text-slate-700">
              {doc.scope_prose}
            </div>
          </SectionCard>
        ) : null}

        {/* Line items */}
        {doc.lines.length > 0 ? (
          <SectionCard title="Estimate">
            {grouped.labor.length > 0 ? (
              <div className="mb-2">
                <h3 className="mb-1 text-sm font-bold text-slate-900">Labor &amp; materials</h3>
                <div className="divide-y divide-slate-100">
                  {grouped.labor.map((line, i) => (
                    <LineRow key={`l-${i}`} line={line} />
                  ))}
                </div>
              </div>
            ) : null}

            {grouped.allowances.length > 0 ? (
              <div className="mt-6">
                <h3 className="mb-1 text-sm font-bold text-slate-900">Allowances</h3>
                <p className="mb-2 text-xs text-slate-500">
                  Budgetary placeholders — the final amount is confirmed as work is scheduled.
                </p>
                <div className="space-y-1">
                  {grouped.allowances.map((line, i) => (
                    <LineRow key={`a-${i}`} line={line} accent="allowance" />
                  ))}
                </div>
              </div>
            ) : null}

            {grouped.verify.length > 0 ? (
              <div className="mt-6">
                <h3 className="mb-1 text-sm font-bold text-slate-900">Verify on site</h3>
                <p className="mb-2 text-xs text-slate-500">
                  Items your contractor will confirm on site before the work is finalized.
                </p>
                <div className="space-y-1">
                  {grouped.verify.map((line, i) => (
                    <LineRow key={`v-${i}`} line={line} accent="verify" />
                  ))}
                </div>
              </div>
            ) : null}
          </SectionCard>
        ) : null}

        {/* Options */}
        {hasOptions ? (
          <SectionCard title="Choose your options">
            <div className="space-y-6">
              {doc.option_groups.map((group, gi) => (
                <OptionGroup
                  key={gi}
                  group={group}
                  selectedIndex={selectedTiers[gi] ?? defaultTierIndex(group)}
                  onSelect={(index) => setSelectedTiers((prev) => ({ ...prev, [gi]: index }))}
                />
              ))}
            </div>
          </SectionCard>
        ) : null}

        {/* Inclusions / Exclusions */}
        {doc.inclusions.length > 0 || doc.exclusions.length > 0 ? (
          <SectionCard title="What's included">
            <div className="grid gap-6 sm:grid-cols-2">
              {doc.inclusions.length > 0 ? (
                <div>
                  <h3 className="mb-2 text-sm font-bold text-slate-900">Included</h3>
                  <ul className="space-y-2">
                    {doc.inclusions.map((item, i) => (
                      <li key={i} className="flex gap-2 text-sm text-slate-700">
                        <CheckIcon className="mt-0.5 h-4 w-4 shrink-0 text-green-600" />
                        <span>{item}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
              {doc.exclusions.length > 0 ? (
                <div>
                  <h3 className="mb-2 text-sm font-bold text-slate-900">Not included</h3>
                  <ul className="space-y-2">
                    {doc.exclusions.map((item, i) => (
                      <li key={i} className="flex gap-2 text-sm text-slate-500">
                        <span aria-hidden className="mt-0.5 shrink-0 font-bold text-slate-400">
                          ×
                        </span>
                        <span>{item}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </div>
          </SectionCard>
        ) : null}

        {/* Totals + deposit */}
        <SectionCard>
          <dl className="space-y-2.5">
            <div className="flex items-center justify-between text-sm">
              <dt className="text-slate-500">Subtotal</dt>
              <dd>
                <Money value={money(doc.subtotal)} className="text-slate-700" />
              </dd>
            </div>
            <div className="flex items-center justify-between text-sm">
              <dt className="text-slate-500">Tax</dt>
              <dd>
                <Money value={money(doc.tax)} className="text-slate-700" />
              </dd>
            </div>
            <div className="mt-2 flex items-center justify-between border-t border-slate-200 pt-3">
              <dt className="text-base font-bold text-slate-900">Total</dt>
              <dd>
                <Money value={liveTotal} className="text-xl font-semibold text-slate-900" />
              </dd>
            </div>
          </dl>

          <div className="mt-5 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-orange-200 bg-orange-50 px-4 py-3.5">
            <span className="text-sm font-semibold text-orange-900">{doc.deposit_label}</span>
            <Money value={money(depositAmount)} className="text-lg font-semibold text-orange-900" />
          </div>
        </SectionCard>

        {/* Accept & Sign / Signed confirmation */}
        {canSign ? (
          <SectionCard className="border-slate-900/10 ring-1 ring-slate-900/5">
            <h2 className="text-lg font-bold text-slate-900">Accept &amp; sign</h2>
            <p className="mt-1 text-sm text-slate-500">
              Review the details above. Type your full name and consent to sign electronically.
            </p>

            <div className="mt-5 space-y-4">
              <div>
                <label
                  htmlFor="signer-name"
                  className="mb-1 block text-sm font-semibold text-slate-700"
                >
                  Full name
                </label>
                <input
                  id="signer-name"
                  type="text"
                  autoComplete="name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  disabled={signing}
                  placeholder="Your full legal name"
                  className="min-h-[48px] w-full rounded-lg border border-slate-300 bg-white px-3.5 py-3 text-base text-slate-900 transition-colors focus:border-slate-900 focus:outline-none focus:ring-2 focus:ring-slate-900/20 disabled:bg-slate-100"
                />
              </div>
              <div>
                <label
                  htmlFor="signer-email"
                  className="mb-1 block text-sm font-semibold text-slate-700"
                >
                  Email{' '}
                  <span className="font-normal text-slate-400">(optional, for your receipt)</span>
                </label>
                <input
                  id="signer-email"
                  type="email"
                  autoComplete="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  disabled={signing}
                  placeholder="you@example.com"
                  className="min-h-[48px] w-full rounded-lg border border-slate-300 bg-white px-3.5 py-3 text-base text-slate-900 transition-colors focus:border-slate-900 focus:outline-none focus:ring-2 focus:ring-slate-900/20 disabled:bg-slate-100"
                />
              </div>

              <label className="flex cursor-pointer items-start gap-3 rounded-lg bg-slate-50 p-3.5">
                <input
                  type="checkbox"
                  checked={consent}
                  onChange={(e) => setConsent(e.target.checked)}
                  disabled={signing}
                  className="mt-0.5 h-5 w-5 shrink-0 cursor-pointer rounded border-slate-300 text-orange-600 focus:ring-orange-600/40"
                />
                <span className="text-sm leading-relaxed text-slate-600">{doc.esign_consent}</span>
              </label>

              {signError ? (
                <p className="rounded-lg border border-red-200 bg-red-50 px-3.5 py-3 text-sm text-red-700">
                  {signError}
                </p>
              ) : null}

              <button
                type="button"
                onClick={handleSign}
                disabled={signing || name.trim() === '' || !consent}
                className="min-h-[52px] w-full cursor-pointer rounded-xl bg-orange-600 px-6 py-3.5 text-base font-bold text-white shadow-sm transition-colors duration-200 hover:bg-orange-700 focus:outline-none focus:ring-2 focus:ring-orange-600/40 focus:ring-offset-2 disabled:cursor-not-allowed disabled:bg-slate-300 disabled:text-slate-500"
              >
                {signing ? 'Signing…' : 'Accept & Sign'}
              </button>
            </div>
          </SectionCard>
        ) : null}

        {isSigned ? (
          <SectionCard className="border-green-200 bg-green-50/50">
            <div className="flex items-start gap-3">
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-green-600 text-white">
                <CheckIcon className="h-6 w-6" />
              </span>
              <div>
                <h2 className="text-lg font-bold text-slate-900">
                  Signed{signerName ? ` by ${signerName}` : ''}
                </h2>
                {justSignedAt ? (
                  <p className={`${mono.className} mt-0.5 text-sm text-slate-500`}>
                    {justSignedAt.toLocaleString()}
                  </p>
                ) : (
                  <p className="mt-0.5 text-sm text-slate-500">
                    Thank you — your acceptance has been recorded.
                  </p>
                )}
              </div>
            </div>

            {/* Pay deposit */}
            <div className="mt-6 border-t border-green-200 pt-6">
              {depositPaid ? (
                <div className="flex items-center gap-2 text-green-800">
                  <CheckIcon className="h-5 w-5" />
                  <span className="font-semibold">Deposit paid — thank you!</span>
                </div>
              ) : payment.available && payment.stripe_live ? (
                <>
                  <button
                    type="button"
                    onClick={handlePay}
                    disabled={paying}
                    className="min-h-[52px] w-full cursor-pointer rounded-xl bg-orange-600 px-6 py-3.5 text-base font-bold text-white shadow-sm transition-colors duration-200 hover:bg-orange-700 focus:outline-none focus:ring-2 focus:ring-orange-600/40 focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {paying
                      ? 'Redirecting to secure checkout…'
                      : `Pay ${formatUsd(money(depositAmount))} deposit`}
                  </button>
                  <p className="mt-2 text-center text-xs text-slate-500">
                    Secure payment powered by Stripe.
                  </p>
                  {payError ? (
                    <p className="mt-3 rounded-lg border border-red-200 bg-red-50 px-3.5 py-3 text-sm text-red-700">
                      {payError}
                    </p>
                  ) : null}
                </>
              ) : (
                <p className="rounded-lg bg-white/70 px-4 py-3 text-sm text-slate-600">
                  Your contractor will follow up with you to collect the deposit.
                </p>
              )}
            </div>
          </SectionCard>
        ) : null}

        {/* Terms */}
        <SectionCard title="Terms">
          {doc.company_terms.trim() ? (
            <div className="whitespace-pre-line text-sm leading-relaxed text-slate-600">
              {doc.company_terms}
            </div>
          ) : null}
          <p className="mt-4 border-t border-slate-100 pt-4 text-xs italic leading-relaxed text-slate-400">
            {doc.platform_disclaimer}
          </p>
          <p className="mt-3 text-xs text-slate-400">
            {isExpired ? 'This proposal has expired.' : `Valid for ${doc.validity_days} days.`}
            {doc.terms_version ? ` · Terms ${doc.terms_version}` : ''}
          </p>
        </SectionCard>

        {/* Decline */}
        {canSign ? (
          <div className="pb-4 text-center">
            <button
              type="button"
              onClick={() => {
                setDeclineError(null);
                setDeclineOpen(true);
              }}
              className="cursor-pointer text-sm font-medium text-slate-400 underline-offset-4 transition-colors hover:text-slate-600 hover:underline"
            >
              Decline this proposal
            </button>
          </div>
        ) : null}
      </div>

      {declineOpen ? (
        <DeclineModal
          onClose={() => (declining ? undefined : setDeclineOpen(false))}
          onConfirm={handleDecline}
          busy={declining}
          error={declineError}
        />
      ) : null}
    </main>
  );
}

/* ------------------------------ shared bits ------------------------------ */

function CenteredCard({
  title,
  body,
  action,
}: {
  title: string;
  body: string;
  action?: React.ReactNode;
}) {
  return (
    <main className={`${jakarta.className} flex flex-1 flex-col bg-slate-50`}>
      <div className="h-1.5 w-full bg-orange-500" />
      <div className="flex flex-1 items-center justify-center px-4 py-16">
        <div className="w-full max-w-md rounded-2xl border border-slate-200 bg-white p-8 text-center shadow-sm">
          <h1 className="text-xl font-bold text-slate-900">{title}</h1>
          <p className="mt-2 text-sm text-slate-500">{body}</p>
          {action}
        </div>
      </div>
    </main>
  );
}

function Banner({
  tone,
  title,
  children,
}: {
  tone: 'success' | 'warning' | 'neutral';
  title: string;
  children: React.ReactNode;
}) {
  const map = {
    success: 'border-green-200 bg-green-50 text-green-900',
    warning: 'border-amber-200 bg-amber-50 text-amber-900',
    neutral: 'border-slate-200 bg-slate-100 text-slate-700',
  } as const;
  return (
    <div className={`rounded-xl border px-4 py-3.5 ${map[tone]}`}>
      <p className="font-bold">{title}</p>
      <p className="mt-0.5 text-sm opacity-90">{children}</p>
    </div>
  );
}
