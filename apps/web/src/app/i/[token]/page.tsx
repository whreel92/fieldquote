/**
 * Public hosted invoice pay page — /i/[token] (Phase 7).
 *
 * A homeowner opens this from an email/SMS link and pays by card or ACH,
 * in full or partially. No auth: the opaque token is the credential. Server
 * component sets noindex (private link) and hands off to the client component.
 */

import type { Metadata } from 'next';

import InvoiceClient from './InvoiceClient';

// Private link — must never be indexed by search engines.
export const metadata: Metadata = {
  title: 'Your invoice',
  robots: { index: false, follow: false, nocache: true },
};

export default async function HostedInvoicePage({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>;
  searchParams?: Promise<{ paid?: string | string[] }>;
}) {
  const { token } = await params;
  const query = searchParams ? await searchParams : {};
  const paidReturn = query.paid === '1';
  return <InvoiceClient token={token} paidReturn={paidReturn} />;
}
