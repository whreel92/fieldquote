export default function LoginPage() {
  return (
    <main className="flex flex-1 flex-col items-center justify-center gap-6 bg-slate-50 px-6">
      <h1 className="text-2xl font-bold text-slate-900">Sign in to FieldQuote</h1>
      <form className="flex w-full max-w-sm flex-col gap-3">
        <label className="text-sm font-medium text-slate-700" htmlFor="email">
          Email
        </label>
        <input
          id="email"
          type="email"
          placeholder="you@yourcompany.com"
          className="rounded-lg border border-slate-300 px-4 py-3"
          disabled
        />
        <button
          type="button"
          disabled
          className="rounded-lg bg-orange-600 px-6 py-3 font-semibold text-white opacity-50"
        >
          Email me a sign-in code
        </button>
      </form>
      <p className="max-w-sm text-center text-sm text-slate-400">
        Email one-time-code sign-in connects to Supabase Auth once the project is provisioned (see
        docs/HUMAN_TODO.md).
      </p>
    </main>
  );
}
