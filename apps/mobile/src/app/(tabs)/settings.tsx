import { colors, radii, spacing, typography } from '@fieldquote/ui';
import { useQuery } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import { Alert, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { Button } from '@/components/ui';
import { api } from '@/lib/api';
import { useAuth } from '@/state/auth';

export default function SettingsScreen() {
  const router = useRouter();
  const { signOut } = useAuth();
  const rates = useQuery({ queryKey: ['rates'], queryFn: api.rates.get });
  const company = useQuery({ queryKey: ['company'], queryFn: api.company.get });

  const rows: { title: string; sub: string; badge?: string; onPress: () => void }[] = [
    {
      title: 'Rates & pricing',
      sub: rates.data
        ? `$${Number(rates.data.labor_rate)}/hr · ${Number(rates.data.target_margin_pct)}% ${rates.data.markup_model}`
        : 'Labor rate, margin model, tax',
      badge: rates.data && !rates.data.confirmed ? 'Using defaults' : undefined,
      onPress: () => router.push('/settings/rates'),
    },
    {
      title: 'Company & branding',
      sub: company.data?.name ?? 'Name, license, logo, contact info',
      onPress: () => router.push('/settings/branding'),
    },
    {
      title: 'Team',
      sub: 'Invite techs and office staff',
      onPress: () => Alert.alert('Coming soon', 'Team seats and roles arrive in Phase 8.'),
    },
    {
      title: 'Legal & disclaimers',
      sub: 'What customers see on every proposal',
      onPress: () => router.push('/settings/legal'),
    },
  ];

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.container}>
      {rows.map((row) => (
        <Pressable key={row.title} style={styles.row} onPress={row.onPress}>
          <View style={styles.rowText}>
            <View style={styles.rowTitleWrap}>
              <Text style={styles.rowTitle}>{row.title}</Text>
              {row.badge ? (
                <View style={styles.badge}>
                  <Text style={styles.badgeText}>{row.badge}</Text>
                </View>
              ) : null}
            </View>
            <Text style={styles.rowSub} numberOfLines={1}>
              {row.sub}
            </Text>
          </View>
          <Text style={styles.chevron}>›</Text>
        </Pressable>
      ))}
      <View style={styles.signOut}>
        <Button title="Sign out" variant="danger" onPress={() => void signOut()} />
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { backgroundColor: colors.bg },
  container: {
    width: '100%',
    maxWidth: 640,
    alignSelf: 'center',
    padding: spacing.md,
    gap: spacing.sm,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.surface,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.md,
  },
  rowText: { flex: 1, gap: 2 },
  rowTitleWrap: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  rowTitle: {
    fontSize: typography.size.md,
    fontFamily: typography.family.medium,
    color: colors.text,
  },
  rowSub: { fontSize: typography.size.sm, color: colors.textMuted },
  badge: {
    backgroundColor: colors.warningBg,
    borderRadius: radii.full,
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
  },
  badgeText: { fontSize: typography.size.xs, color: colors.warning },
  chevron: { fontSize: typography.size.xl, color: colors.textMuted },
  signOut: { marginTop: spacing.lg },
});
