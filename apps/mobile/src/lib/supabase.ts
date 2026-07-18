/**
 * Supabase client. Reads EXPO_PUBLIC_SUPABASE_URL / EXPO_PUBLIC_SUPABASE_ANON_KEY.
 * Until Will provisions the project (docs/HUMAN_TODO.md), the client is null and
 * auth screens show a "not configured" state instead of crashing.
 */

import 'react-native-url-polyfill/auto';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { Platform } from 'react-native';

const url = process.env.EXPO_PUBLIC_SUPABASE_URL;
const anonKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;

export const supabase: SupabaseClient | null =
  url && anonKey
    ? createClient(url, anonKey, {
        auth: {
          // AsyncStorage is native-only; web/SSR falls back to supabase-js defaults.
          ...(Platform.OS === 'web' ? {} : { storage: AsyncStorage }),
          autoRefreshToken: true,
          persistSession: Platform.OS !== 'web',
          detectSessionInUrl: false,
        },
      })
    : null;

export const isSupabaseConfigured = supabase !== null;
