import Link from 'next/link';

export default function MarketingPage() {
  return (
    <main className="flex flex-1 flex-col items-center justify-center gap-6 bg-slate-50 px-6 py-24 text-center">
      <span className="rounded-full bg-orange-100 px-3 py-1 text-sm font-medium text-orange-800">
        Built for residential electricians
      </span>
      <h1 className="max-w-2xl text-4xl font-bold tracking-tight text-slate-900 sm:text-5xl">
        Price the job before you leave the driveway
      </h1>
      <p className="max-w-xl text-lg text-slate-600">
        Photos + a voice note on site become a scoped, line-item estimate you review and approve —
        then a branded proposal your customer signs and pays a deposit on. Your rates. Your
        approval. Every line editable.
      </p>
      <div className="flex gap-4">
        <Link
          href="/login"
          className="rounded-lg bg-orange-600 px-6 py-3 font-semibold text-white hover:bg-orange-700"
        >
          Sign in
        </Link>
        <a
          href="#waitlist"
          className="rounded-lg border border-slate-300 px-6 py-3 font-semibold text-slate-700 hover:bg-white"
        >
          Join the waitlist
        </a>
      </div>
      <p className="text-sm text-slate-400">Full marketing site ships in Phase 11.</p>
    </main>
  );
}
