/**
 * Public hosted proposal page (Phase 6 builds the real thing: branding, line
 * items, e-sign, deposit). Route shape /p/[proposalId] is load-bearing —
 * tokens sent by SMS/email must never break.
 */

export default async function HostedProposalPage({
  params,
}: {
  params: Promise<{ proposalId: string }>;
}) {
  const { proposalId } = await params;
  return (
    <main className="flex flex-1 flex-col items-center justify-center gap-4 bg-slate-50 px-6 text-center">
      <h1 className="text-xl font-bold text-slate-900">Proposal</h1>
      <p className="text-slate-500">
        This proposal link isn&apos;t live yet. Hosted proposals ship in Phase 6.
      </p>
      <code className="rounded bg-slate-100 px-3 py-1 text-sm text-slate-400">{proposalId}</code>
    </main>
  );
}
