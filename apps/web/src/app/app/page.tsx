export default function AccountShell() {
  return (
    <main className="flex flex-1 flex-col gap-6 bg-slate-50 px-6 py-16">
      <h1 className="text-2xl font-bold text-slate-900">Account</h1>
      <div className="grid max-w-3xl gap-4 sm:grid-cols-2">
        {['Plan & billing', 'Team seats', 'Payouts (Stripe Connect)', 'Invoices'].map((item) => (
          <div
            key={item}
            className="rounded-xl border border-slate-200 bg-white p-6 text-slate-400"
          >
            <p className="font-semibold text-slate-700">{item}</p>
            <p className="text-sm">Ships in Phase 10.</p>
          </div>
        ))}
      </div>
    </main>
  );
}
