/**
 * Supabase browser client for the web app.
 *
 * Env (no apps/web/.env.example yet — add these to apps/web/.env.local):
 *   NEXT_PUBLIC_SUPABASE_URL      — Supabase project URL
 *   NEXT_PUBLIC_SUPABASE_ANON_KEY — Supabase anon (public) key
 *
 * Mirrors apps/mobile/src/lib/supabase.ts: until Will provisions the project
 * (docs/HUMAN_TODO.md) the client is null and pages render a
 * "not configured" state instead of crashing.
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

export const supabase: SupabaseClient | null =
  url && anonKey
    ? createClient(url, anonKey, {
        auth: {
          autoRefreshToken: true,
          persistSession: true,
          detectSessionInUrl: true,
        },
      })
    : null;

export const isSupabaseConfigured = supabase !== null;
