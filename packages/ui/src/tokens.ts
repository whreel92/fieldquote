/**
 * FieldQuote design tokens — single source for mobile (RN) and web (Tailwind).
 * Numbers are unitless; web maps them to px, RN uses them directly.
 */

export const colors = {
  // Brand: high-contrast electric blue with a safety-amber accent.
  primary: '#1D4ED8',
  primaryPressed: '#1E40AF',
  accent: '#F59E0B',

  bg: '#F8FAFC',
  surface: '#FFFFFF',
  border: '#E2E8F0',

  text: '#0F172A',
  textSecondary: '#475569',
  textMuted: '#94A3B8',
  textOnPrimary: '#FFFFFF',

  success: '#16A34A',
  warning: '#D97706',
  danger: '#DC2626',

  /** Job pipeline status colors (Jobs tab grouping). */
  status: {
    lead: '#64748B',
    estimating: '#2563EB',
    sent: '#7C3AED',
    won: '#16A34A',
    lost: '#94A3B8',
    in_progress: '#D97706',
    complete: '#0D9488',
    paid: '#15803D',
  },
} as const;

export const spacing = {
  xs: 4,
  sm: 8,
  md: 16,
  lg: 24,
  xl: 32,
  xxl: 48,
} as const;

export const radii = {
  sm: 6,
  md: 10,
  lg: 16,
  full: 9999,
} as const;

export const typography = {
  /** Font sizes */
  size: {
    xs: 12,
    sm: 14,
    md: 16,
    lg: 20,
    xl: 24,
    xxl: 32,
  },
  weight: {
    regular: '400',
    medium: '500',
    semibold: '600',
    bold: '700',
  },
} as const;

export type JobStatus = keyof typeof colors.status;
