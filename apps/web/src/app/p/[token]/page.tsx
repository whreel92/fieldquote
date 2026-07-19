/**
 * Public hosted proposal — /p/[token] (Phase 6, the revenue moment).
 *
 * A homeowner opens this from an SMS/email link, reviews the branded proposal,
 * picks any options, signs, and pays a deposit. No auth: the opaque token is
 * the credential. This server component sets a noindex robots policy (private
 * link) and hands off to the interactive client component.
 */

import type { Metadata } from 'next';

import ProposalClient from './ProposalClient';

// Private link — must never be indexed by search engines.
export const metadata: Metadata = {
  title: 'Your proposal',
  robots: { index: false, follow: false, nocache: true },
};

export default async function HostedProposalPage({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>;
  searchParams?: Promise<{ paid?: string | string[] }>;
}) {
  const { token } = await params;
  const query = searchParams ? await searchParams : {};
  const paidReturn = query.paid === '1';
  return <ProposalClient token={token} paidReturn={paidReturn} />;
}
