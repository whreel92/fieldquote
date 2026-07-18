/**
 * FieldQuote design tokens — single source for mobile (RN) and web (Tailwind).
 * System: "Trust & Authority" (design-system/fieldquote/MASTER.md).
 * Navy ink base + safety-orange action color; built for sunlight, gloves, speed.
 * Numbers are unitless; web maps them to px, RN uses them directly.
 */

export const colors = {
  /** Action color — safety orange. Large fills only; use accentText on white text. */
  primary: '#EA580C',
  primaryPressed: '#C2410C',
  /** Orange dark enough for 4.5:1 as text on white. */
  accentText: '#C2410C',

  /** Authority base — headers, nav, emphasis surfaces. */
  ink: '#0F172A',
  inkPressed: '#1E293B',

  bg: '#F8FAFC',
  surface: '#FFFFFF',
  surfaceSunken: '#E8ECF1',
  border: '#E2E8F0',

  text: '#0F172A',
  textSecondary: '#475569',
  textMuted: '#64748B',
  textOnPrimary: '#FFFFFF',
  textOnInk: '#F1F5F9',

  success: '#15803D',
  warning: '#B45309',
  warningBg: '#FEF3C7',
  danger: '#DC2626',

  /** Job pipeline status colors (paired with labels — never color alone). */
  status: {
    lead: '#64748B',
    estimating: '#0369A1',
    sent: '#7C3AED',
    won: '#15803D',
    lost: '#94A3B8',
    in_progress: '#B45309',
    complete: '#0D9488',
    paid: '#166534',
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
  /** Loaded via @expo-google-fonts/plus-jakarta-sans on mobile; CSS on web. */
  family: {
    regular: 'PlusJakartaSans_400Regular',
    medium: 'PlusJakartaSans_500Medium',
    semibold: 'PlusJakartaSans_600SemiBold',
    bold: 'PlusJakartaSans_700Bold',
    extrabold: 'PlusJakartaSans_800ExtraBold',
  },
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

/** Minimum touch target (px) — field-use rule, gloves-friendly. */
export const touchTarget = 48;

export type JobStatus = keyof typeof colors.status;
