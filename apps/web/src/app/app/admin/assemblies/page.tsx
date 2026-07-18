'use client';

/**
 * /app/admin/assemblies — Phase 2 internal catalog browser/editor.
 * Role-gated server-side (PATCH returns 403 for non owner/admin).
 * Design: "Trust & Authority" — ink header band, safety-orange actions,
 * JetBrains Mono numerals (design-system/fieldquote/MASTER.md).
 */

import { JetBrains_Mono, Plus_Jakarta_Sans } from 'next/font/google';
import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';

import {
  ApiError,
  catalogApi,
  type Assembly,
  type AssemblyPatch,
  type Modifier,
} from '@/lib/catalog';
import { isSupabaseConfigured, supabase } from '@/lib/supabase';

const jakarta = Plus_Jakarta_Sans({ subsets: ['latin'] });
const jbMono = JetBrains_Mono({ subsets: ['latin'], weight: ['400', '500'] });

type AuthState = 'loading' | 'signed-out' | 'signed-in';
type LoadState = 'loading' | 'error' | 'ready';

function StatusBadge({ status }: { status: Assembly['status'] }) {
  const approved = status === 'advisor_approved';
  return (
    <span
      className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border px-2.5 py-0.5 text-xs font-semibold ${
        approved
          ? 'border-green-300 bg-green-50 text-green-800'
          : 'border-amber-300 bg-amber-50 text-amber-800'
      }`}
    >
      <span
        aria-hidden
        className={`h-1.5 w-1.5 rounded-full ${approved ? 'bg-green-600' : 'bg-amber-500'}`}
      />
      {approved ? 'Advisor approved' : 'Draft'}
    </span>
  );
}

function DetailPanel({
  assembly,
  modifiersByCode,
  onSaved,
}: {
  assembly: Assembly;
  modifiersByCode: Map<string, Modifier>;
  onSaved: (updated: Assembly) => void;
}) {
  const [description, setDescription] = useState(assembly.description ?? '');
  const [laborHours, setLaborHours] = useState(String(assembly.labor_hours));
  const [laborNotes, setLaborNotes] = useState(assembly.labor_notes ?? '');
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState<'forbidden' | 'network' | null>(null);
  const [lastPatch, setLastPatch] = useState<AssemblyPatch | null>(null);
  const [savedVersion, setSavedVersion] = useState<number | null>(null);

  const parsedHours = Number(laborHours);
  const hoursValid = laborHours.trim() !== '' && Number.isFinite(parsedHours) && parsedHours >= 0;

  const patch: AssemblyPatch = {};
  if (description !== (assembly.description ?? '')) patch.description = description;
  if (laborNotes !== (assembly.labor_notes ?? '')) patch.labor_notes = laborNotes;
  if (hoursValid && parsedHours !== assembly.labor_hours) patch.labor_hours = parsedHours;
  const dirty = Object.keys(patch).length > 0;
  const forbidden = saveError === 'forbidden';

  const apply = useCallback(
    async (p: AssemblyPatch) => {
      setBusy(true);
      setSaveError(null);
      setSavedVersion(null);
      setLastPatch(p);
      try {
        const updated = await catalogApi.patchAssembly(assembly.code, p);
        onSaved(updated);
        setSavedVersion(updated.version);
      } catch (e) {
        setSaveError(e instanceof ApiError && e.status === 403 ? 'forbidden' : 'network');
      } finally {
        setBusy(false);
      }
    },
    [assembly.code, onSaved],
  );

  const nextStatus: Assembly['status'] =
    assembly.status === 'advisor_approved' ? 'draft' : 'advisor_approved';

  return (
    <div className="border-t border-slate-200 bg-slate-50 px-4 py-5 sm:px-6">
      <div className="grid gap-6 lg:grid-cols-2">
        {/* Left: reference data */}
        <div className="flex flex-col gap-5">
          <section>
            <h3 className="mb-1.5 text-xs font-bold uppercase tracking-widest text-slate-500">
              Bill of materials
            </h3>
            {assembly.bom.length === 0 ? (
              <p className="text-sm text-slate-400">No materials — labor only.</p>
            ) : (
              <ul className="divide-y divide-slate-200 overflow-hidden rounded-lg border border-slate-200 bg-white">
                {assembly.bom.map((item) => (
                  <li
                    key={item.sku}
                    className="flex items-center justify-between gap-3 px-3 py-2 text-sm"
                  >
                    <span className={`${jbMono.className} text-slate-700`}>{item.sku}</span>
                    <span className={`${jbMono.className} text-slate-500`}>× {item.qty}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section>
            <h3 className="mb-1.5 text-xs font-bold uppercase tracking-widest text-slate-500">
              Allowed modifiers
            </h3>
            {assembly.modifiers_allowed.length === 0 ? (
              <p className="text-sm text-slate-400">None.</p>
            ) : (
              <div className="flex flex-wrap gap-1.5">
                {assembly.modifiers_allowed.map((code) => {
                  const mod = modifiersByCode.get(code);
                  return (
                    <span
                      key={code}
                      title={mod ? `${mod.name} — ${mod.description}` : undefined}
                      className="inline-flex items-center gap-1.5 rounded-full border border-slate-300 bg-white px-2.5 py-1 text-xs text-slate-700"
                    >
                      <span className={jbMono.className}>{code}</span>
                      {mod ? <span className="text-slate-500">{mod.name}</span> : null}
                    </span>
                  );
                })}
              </div>
            )}
          </section>

          {assembly.option_tiers && assembly.option_tiers.length > 0 ? (
            <section>
              <h3 className="mb-1.5 text-xs font-bold uppercase tracking-widest text-slate-500">
                Option tiers
              </h3>
              <div className="flex flex-col gap-2">
                {assembly.option_tiers.map((tier, i) => (
                  <div
                    key={i}
                    className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs text-slate-700"
                  >
                    {Object.entries(tier).map(([k, v]) => (
                      <div key={k} className="flex gap-2">
                        <span className="font-semibold text-slate-500">{k}:</span>
                        <span className={jbMono.className}>
                          {typeof v === 'string' ? v : JSON.stringify(v)}
                        </span>
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            </section>
          ) : null}
        </div>

        {/* Right: editable fields */}
        <div className="flex flex-col gap-4">
          <div>
            <label
              htmlFor={`desc-${assembly.code}`}
              className="mb-1 block text-xs font-bold uppercase tracking-widest text-slate-500"
            >
              Description
            </label>
            <textarea
              id={`desc-${assembly.code}`}
              rows={2}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              disabled={forbidden || busy}
              className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 transition-colors focus:border-slate-900 focus:outline-none focus:ring-2 focus:ring-slate-900/20 disabled:bg-slate-100 disabled:text-slate-500"
            />
          </div>

          <div className="max-w-[12rem]">
            <label
              htmlFor={`hours-${assembly.code}`}
              className="mb-1 block text-xs font-bold uppercase tracking-widest text-slate-500"
            >
              Labor hours
            </label>
            <input
              id={`hours-${assembly.code}`}
              type="number"
              inputMode="decimal"
              min={0}
              step={0.25}
              value={laborHours}
              onChange={(e) => setLaborHours(e.target.value)}
              disabled={forbidden || busy}
              className={`${jbMono.className} w-full rounded-lg border bg-white px-3 py-2 text-sm text-slate-900 transition-colors focus:outline-none focus:ring-2 disabled:bg-slate-100 disabled:text-slate-500 ${
                hoursValid
                  ? 'border-slate-300 focus:border-slate-900 focus:ring-slate-900/20'
                  : 'border-red-400 focus:border-red-500 focus:ring-red-500/20'
              }`}
            />
            {!hoursValid ? (
              <p className="mt-1 text-xs text-red-600">Enter a number of hours (0 or more).</p>
            ) : null}
          </div>

          <div>
            <label
              htmlFor={`notes-${assembly.code}`}
              className="mb-1 block text-xs font-bold uppercase tracking-widest text-slate-500"
            >
              Labor notes (rationale for advisors)
            </label>
            <textarea
              id={`notes-${assembly.code}`}
              rows={3}
              value={laborNotes}
              onChange={(e) => setLaborNotes(e.target.value)}
              disabled={forbidden || busy}
              className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 transition-colors focus:border-slate-900 focus:outline-none focus:ring-2 focus:ring-slate-900/20 disabled:bg-slate-100 disabled:text-slate-500"
            />
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={() => apply(patch)}
              disabled={!dirty || !hoursValid || busy || forbidden}
              className="cursor-pointer rounded-lg bg-orange-600 px-5 py-2.5 text-sm font-semibold text-white transition-all duration-200 hover:bg-orange-700 focus:outline-none focus:ring-2 focus:ring-orange-600/40 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {busy ? 'Saving…' : 'Save changes'}
            </button>
            <button
              type="button"
              onClick={() => apply({ status: nextStatus })}
              disabled={busy || forbidden}
              className={`cursor-pointer rounded-lg border-2 px-5 py-2 text-sm font-semibold transition-all duration-200 focus:outline-none focus:ring-2 disabled:cursor-not-allowed disabled:opacity-40 ${
                nextStatus === 'advisor_approved'
                  ? 'border-green-700 text-green-800 hover:bg-green-50 focus:ring-green-700/30'
                  : 'border-slate-900 text-slate-900 hover:bg-slate-100 focus:ring-slate-900/30'
              }`}
            >
              {nextStatus === 'advisor_approved' ? 'Mark advisor approved' : 'Revert to draft'}
            </button>
            {savedVersion !== null && !saveError ? (
              <span className={`${jbMono.className} text-sm text-green-700`}>
                Saved — now v{savedVersion}
              </span>
            ) : null}
          </div>

          {forbidden ? (
            <div className="rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900">
              <span className="font-semibold">Read-only.</span> You need owner or admin role to edit
              the catalog.
            </div>
          ) : null}
          {saveError === 'network' ? (
            <div className="flex flex-wrap items-center gap-3 rounded-lg border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-800">
              <span>Could not save. Check your connection and try again.</span>
              {lastPatch ? (
                <button
                  type="button"
                  onClick={() => apply(lastPatch)}
                  className="cursor-pointer rounded-md border border-red-400 px-3 py-1 font-semibold transition-colors hover:bg-red-100"
                >
                  Retry
                </button>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

export default function AssembliesAdminPage() {
  const [auth, setAuth] = useState<AuthState>(() => (supabase ? 'loading' : 'signed-out'));
  const [load, setLoad] = useState<LoadState>('loading');
  const [reload, setReload] = useState(0);
  const [assemblies, setAssemblies] = useState<Assembly[]>([]);
  const [modifiers, setModifiers] = useState<Modifier[]>([]);
  const [search, setSearch] = useState('');
  const [jobType, setJobType] = useState('all');
  const [statusFilter, setStatusFilter] = useState('all');
  const [expanded, setExpanded] = useState<string | null>(null);

  useEffect(() => {
    if (!supabase) return;
    let cancelled = false;
    supabase.auth.getSession().then(({ data }) => {
      if (!cancelled) setAuth(data.session ? 'signed-in' : 'signed-out');
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_event, session) => {
      setAuth(session ? 'signed-in' : 'signed-out');
    });
    return () => {
      cancelled = true;
      sub.subscription.unsubscribe();
    };
  }, []);

  useEffect(() => {
    if (auth !== 'signed-in') return;
    let cancelled = false;
    void (async () => {
      try {
        const [a, m] = await Promise.all([catalogApi.assemblies(), catalogApi.modifiers()]);
        if (cancelled) return;
        setAssemblies(a.items);
        setModifiers(m.items);
        setLoad('ready');
      } catch {
        if (!cancelled) setLoad('error');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [auth, reload]);

  const retryLoad = useCallback(() => {
    setLoad('loading');
    setReload((n) => n + 1);
  }, []);

  const modifiersByCode = useMemo(() => new Map(modifiers.map((m) => [m.code, m])), [modifiers]);

  const jobTypes = useMemo(
    () => Array.from(new Set(assemblies.flatMap((a) => a.job_type_codes))).sort(),
    [assemblies],
  );

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return assemblies.filter((a) => {
      if (q && !a.code.toLowerCase().includes(q) && !a.name.toLowerCase().includes(q)) return false;
      if (jobType !== 'all' && !a.job_type_codes.includes(jobType)) return false;
      if (statusFilter !== 'all' && a.status !== statusFilter) return false;
      return true;
    });
  }, [assemblies, search, jobType, statusFilter]);

  const draftCount = assemblies.filter((a) => a.status === 'draft').length;
  const approvedCount = assemblies.length - draftCount;
  const filtersActive = search.trim() !== '' || jobType !== 'all' || statusFilter !== 'all';

  const handleSaved = useCallback((updated: Assembly) => {
    setAssemblies((prev) => prev.map((a) => (a.code === updated.code ? updated : a)));
  }, []);

  return (
    <main className={`${jakarta.className} flex flex-1 flex-col bg-slate-50`}>
      {/* Ink header band */}
      <header className="bg-slate-900 px-4 py-8 text-slate-100 sm:px-6 lg:px-8">
        <div className="mx-auto flex max-w-6xl flex-wrap items-end justify-between gap-4">
          <div>
            <p className="text-xs font-bold uppercase tracking-[0.2em] text-orange-500">
              Catalog · Internal admin
            </p>
            <h1 className="mt-1 text-2xl font-extrabold tracking-tight text-white sm:text-3xl">
              Assemblies
            </h1>
            <p className="mt-1 text-sm text-slate-400">
              v0 placeholder data — pending licensed-advisor validation. Never reaches production
              pricing until approved.
            </p>
          </div>
          {auth === 'signed-in' && load === 'ready' ? (
            <dl className="flex gap-6 text-right">
              <div>
                <dt className="text-xs uppercase tracking-widest text-slate-400">Total</dt>
                <dd className={`${jbMono.className} text-xl text-white`}>{assemblies.length}</dd>
              </div>
              <div>
                <dt className="text-xs uppercase tracking-widest text-slate-400">Draft</dt>
                <dd className={`${jbMono.className} text-xl text-amber-400`}>{draftCount}</dd>
              </div>
              <div>
                <dt className="text-xs uppercase tracking-widest text-slate-400">Approved</dt>
                <dd className={`${jbMono.className} text-xl text-green-400`}>{approvedCount}</dd>
              </div>
            </dl>
          ) : null}
        </div>
      </header>

      <div className="mx-auto w-full max-w-6xl flex-1 px-4 py-6 sm:px-6 lg:px-8">
        {/* Auth states */}
        {auth === 'loading' ? (
          <p className="py-16 text-center text-sm text-slate-500">Checking your session…</p>
        ) : null}

        {auth === 'signed-out' ? (
          <div className="mx-auto mt-12 max-w-md rounded-xl border border-slate-200 bg-white p-8 text-center shadow-sm">
            <h2 className="text-lg font-bold text-slate-900">Sign in required</h2>
            <p className="mt-2 text-sm text-slate-500">
              {isSupabaseConfigured
                ? 'The catalog admin is for signed-in owners and admins.'
                : 'Supabase is not configured for this environment yet (see docs/HUMAN_TODO.md). Set NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY, then sign in.'}
            </p>
            <Link
              href="/login"
              className="mt-5 inline-block cursor-pointer rounded-lg bg-orange-600 px-6 py-3 text-sm font-semibold text-white transition-all duration-200 hover:bg-orange-700"
            >
              Go to sign in
            </Link>
          </div>
        ) : null}

        {auth === 'signed-in' ? (
          <>
            {/* Filters */}
            <div className="mb-4 flex flex-wrap items-center gap-3">
              <input
                type="search"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search code or name…"
                aria-label="Search assemblies by code or name"
                className="w-full max-w-xs rounded-lg border border-slate-300 bg-white px-3.5 py-2.5 text-sm text-slate-900 transition-colors focus:border-slate-900 focus:outline-none focus:ring-2 focus:ring-slate-900/20"
              />
              <select
                value={jobType}
                onChange={(e) => setJobType(e.target.value)}
                aria-label="Filter by job type"
                className="cursor-pointer rounded-lg border border-slate-300 bg-white px-3 py-2.5 text-sm text-slate-900 transition-colors focus:border-slate-900 focus:outline-none focus:ring-2 focus:ring-slate-900/20"
              >
                <option value="all">All job types</option>
                {jobTypes.map((jt) => (
                  <option key={jt} value={jt}>
                    {jt}
                  </option>
                ))}
              </select>
              <select
                value={statusFilter}
                onChange={(e) => setStatusFilter(e.target.value)}
                aria-label="Filter by status"
                className="cursor-pointer rounded-lg border border-slate-300 bg-white px-3 py-2.5 text-sm text-slate-900 transition-colors focus:border-slate-900 focus:outline-none focus:ring-2 focus:ring-slate-900/20"
              >
                <option value="all">All statuses</option>
                <option value="draft">Draft</option>
                <option value="advisor_approved">Advisor approved</option>
              </select>
              {load === 'ready' ? (
                <span className={`${jbMono.className} ml-auto text-sm text-slate-500`}>
                  {filtered.length} / {assemblies.length}
                </span>
              ) : null}
            </div>

            {/* Loading */}
            {load === 'loading' ? (
              <div className="overflow-hidden rounded-xl border border-slate-200 bg-white">
                {[...Array(8)].map((_, i) => (
                  <div
                    key={i}
                    className="flex animate-pulse items-center gap-4 border-b border-slate-100 px-4 py-4 last:border-b-0"
                  >
                    <div className="h-4 w-28 rounded bg-slate-200" />
                    <div className="h-4 flex-1 rounded bg-slate-100" />
                    <div className="h-4 w-16 rounded bg-slate-200" />
                    <div className="h-5 w-20 rounded-full bg-slate-100" />
                  </div>
                ))}
              </div>
            ) : null}

            {/* Error */}
            {load === 'error' ? (
              <div className="mx-auto mt-8 max-w-md rounded-xl border border-red-200 bg-white p-8 text-center shadow-sm">
                <h2 className="text-lg font-bold text-slate-900">Could not load the catalog</h2>
                <p className="mt-2 text-sm text-slate-500">
                  The API did not respond. Make sure the FastAPI server is running, then retry.
                </p>
                <button
                  type="button"
                  onClick={retryLoad}
                  className="mt-5 cursor-pointer rounded-lg bg-slate-900 px-6 py-3 text-sm font-semibold text-white transition-all duration-200 hover:bg-slate-800"
                >
                  Retry
                </button>
              </div>
            ) : null}

            {/* Empty catalog */}
            {load === 'ready' && assemblies.length === 0 ? (
              <div className="mx-auto mt-8 max-w-md rounded-xl border border-slate-200 bg-white p-8 text-center shadow-sm">
                <h2 className="text-lg font-bold text-slate-900">Catalog is empty</h2>
                <p className="mt-2 text-sm text-slate-500">
                  No assemblies seeded yet. Run the Phase 2 seed script in apps/api/seeds to load
                  the electrical catalog v0.
                </p>
              </div>
            ) : null}

            {/* Table */}
            {load === 'ready' && assemblies.length > 0 ? (
              filtered.length === 0 ? (
                <div className="mt-8 rounded-xl border border-slate-200 bg-white p-8 text-center">
                  <p className="text-sm text-slate-500">No assemblies match these filters.</p>
                  {filtersActive ? (
                    <button
                      type="button"
                      onClick={() => {
                        setSearch('');
                        setJobType('all');
                        setStatusFilter('all');
                      }}
                      className="mt-3 cursor-pointer text-sm font-semibold text-orange-700 transition-colors hover:text-orange-800"
                    >
                      Clear filters
                    </button>
                  ) : null}
                </div>
              ) : (
                <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm">
                  <table className="w-full min-w-[56rem] border-collapse text-left text-sm">
                    <thead>
                      <tr className="border-b border-slate-200 bg-slate-100/60 text-xs font-bold uppercase tracking-wider text-slate-500">
                        <th scope="col" className="px-4 py-3">
                          Code
                        </th>
                        <th scope="col" className="px-4 py-3">
                          Name
                        </th>
                        <th scope="col" className="px-4 py-3">
                          Job types
                        </th>
                        <th scope="col" className="px-4 py-3 text-right">
                          Labor hrs
                        </th>
                        <th scope="col" className="px-4 py-3 text-right">
                          Helper hrs
                        </th>
                        <th scope="col" className="px-4 py-3 text-right">
                          BOM
                        </th>
                        <th scope="col" className="px-4 py-3 text-right">
                          Ver
                        </th>
                        <th scope="col" className="px-4 py-3">
                          Status
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {filtered.map((a) => {
                        const isOpen = expanded === a.code;
                        return (
                          <FragmentRow
                            key={a.code}
                            assembly={a}
                            isOpen={isOpen}
                            onToggle={() => setExpanded(isOpen ? null : a.code)}
                            modifiersByCode={modifiersByCode}
                            onSaved={handleSaved}
                          />
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )
            ) : null}
          </>
        ) : null}
      </div>
    </main>
  );
}

function FragmentRow({
  assembly: a,
  isOpen,
  onToggle,
  modifiersByCode,
  onSaved,
}: {
  assembly: Assembly;
  isOpen: boolean;
  onToggle: () => void;
  modifiersByCode: Map<string, Modifier>;
  onSaved: (updated: Assembly) => void;
}) {
  return (
    <>
      <tr
        onClick={onToggle}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onToggle();
          }
        }}
        tabIndex={0}
        role="button"
        aria-expanded={isOpen}
        className={`cursor-pointer border-b border-slate-100 transition-colors duration-150 last:border-b-0 focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-slate-900/40 ${
          isOpen ? 'bg-orange-50/60' : 'hover:bg-slate-50'
        }`}
      >
        <td className={`${jbMono.className} whitespace-nowrap px-4 py-3 text-slate-900`}>
          {a.code}
        </td>
        <td className="px-4 py-3 font-medium text-slate-800">{a.name}</td>
        <td className="px-4 py-3 text-xs text-slate-500">{a.job_type_codes.join(', ')}</td>
        <td className={`${jbMono.className} px-4 py-3 text-right text-slate-900`}>
          {a.labor_hours}
        </td>
        <td className={`${jbMono.className} px-4 py-3 text-right text-slate-500`}>
          {a.helper_hours}
        </td>
        <td className={`${jbMono.className} px-4 py-3 text-right text-slate-500`}>
          {a.bom.length}
        </td>
        <td className={`${jbMono.className} px-4 py-3 text-right text-slate-500`}>v{a.version}</td>
        <td className="px-4 py-3">
          <StatusBadge status={a.status} />
        </td>
      </tr>
      {isOpen ? (
        <tr className="border-b border-slate-100 last:border-b-0">
          <td colSpan={8} className="p-0">
            <DetailPanel
              key={a.code}
              assembly={a}
              modifiersByCode={modifiersByCode}
              onSaved={onSaved}
            />
          </td>
        </tr>
      ) : null}
    </>
  );
}
