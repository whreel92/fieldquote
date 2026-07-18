import type { Session } from '@supabase/supabase-js';
import { create } from 'zustand';

import { supabase } from '@/lib/supabase';

interface AuthState {
  session: Session | null;
  initialized: boolean;
  initialize: () => Promise<void>;
  signOut: () => Promise<void>;
}

export const useAuth = create<AuthState>((set) => ({
  session: null,
  initialized: false,

  initialize: async () => {
    if (!supabase) {
      set({ initialized: true });
      return;
    }
    const { data } = await supabase.auth.getSession();
    set({ session: data.session, initialized: true });
    supabase.auth.onAuthStateChange((_event, session) => {
      set({ session });
    });
  },

  signOut: async () => {
    await supabase?.auth.signOut();
    set({ session: null });
  },
}));
