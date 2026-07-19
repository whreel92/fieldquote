/**
 * Proposal composer (Phase 6.1). Loads api.proposals.get(id) into the query
 * cache (['proposal', id]). Every edit is saved via api.proposals.updateConfig,
 * which returns the full ProposalWithDocument (config + freshly-rendered
 * document) and replaces the cache — so the live PREVIEW always reflects saved
 * state. Text fields save on blur; structured controls (deposit kind, validity,
 * list add/remove) save immediately. Save-on-blur keeps this simple and safe.
 *
 * "Send proposal" confirms, then calls api.proposals.send — this freezes the
 * proposal (content_hash set, status → sent). A sent proposal is immutable:
 * the screen then renders the read-only sent summary with the shareable link
 * and lifecycle timeline. Loading a proposal that is already non-draft lands on
 * that same summary instead of the editor.
 */

import { colors, radii, spacing, touchTarget, typography } from '@fieldquote/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Image } from 'expo-image';
import { useLocalSearchParams, useRouter, type Href } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import * as WebBrowser from 'expo-web-browser';
import {
  Check,
  ExternalLink,
  Link as LinkIcon,
  Minus,
  Plus,
  Share2,
  X,
} from 'lucide-react-native';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Pressable,
  ScrollView,
  Share,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { EquipmentLabel, HeaderBand } from '@/components/header-band';
import { ProposalTimeline } from '@/components/proposal-timeline';
import { Button } from '@/components/ui';
import { api, ApiError, type ProposalConfig, type ProposalWithDocument } from '@/lib/api';

/** Dynamic route not yet in generated typings. */
const href = (path: string) => path as Href;

const WEB_URL = process.env.EXPO_PUBLIC_WEB_URL ?? 'http://localhost:3000';

// ── untyped-JSON helpers (document is an unknown map) ────────────────────────

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function strList(value: unknown): string[] {
  return asArray(value).filter((v): v is string => typeof v === 'string');
}

function numeric(value: unknown): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'string' && value.trim() !== '') return Number(value);
  return NaN;
}

function money(value: unknown): string {
  const n = numeric(value);
  if (!Number.isFinite(n)) return '—';
  return `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function fmtNum(value: unknown): string {
  const n = numeric(value);
  if (!Number.isFinite(n)) return '—';
  return String(parseFloat(n.toFixed(2)));
}

function firstSentence(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return '';
  const match = trimmed.match(/^.*?[.!?](\s|$)/);
  return (match ? match[0] : trimmed).trim();
}

// ── editable form model ──────────────────────────────────────────────────────

type Form = {
  title: string;
  intro_message: string;
  cover_photo_url: string;
  inclusions: string[];
  exclusions: string[];
  depositKind: 'percent' | 'flat';
  depositValue: string;
  validity_days: number;
  company_terms: string;
};

function seedForm(proposal: ProposalWithDocument): Form {
  const config = asRecord(proposal.config) ?? {};
  const doc = asRecord(proposal.document) ?? {};
  const deposit = asRecord(config['deposit']);
  const depositKind = deposit?.['kind'] === 'flat' ? 'flat' : 'percent';

  const configIntro = str(config['intro_message']);
  const intro = configIntro || firstSentence(str(doc['scope_prose']));

  const validity = numeric(config['validity_days']);
  const docValidity = numeric(doc['validity_days']);

  return {
    title: str(config['title']) || str(doc['title']),
    intro_message: intro,
    cover_photo_url: str(config['cover_photo_url']) || str(doc['cover_photo_url']),
    inclusions: config['inclusions'] ? strList(config['inclusions']) : strList(doc['inclusions']),
    exclusions: config['exclusions'] ? strList(config['exclusions']) : strList(doc['exclusions']),
    depositKind,
    depositValue: str(deposit?.['value']),
    validity_days: Number.isFinite(validity)
      ? validity
      : Number.isFinite(docValidity)
        ? docValidity
        : 30,
    company_terms: str(config['company_terms']) || str(doc['company_terms']),
  };
}

function buildConfig(form: Form): ProposalConfig {
  return {
    title: form.title,
    cover_photo_url: form.cover_photo_url.trim() ? form.cover_photo_url.trim() : null,
    intro_message: form.intro_message,
    inclusions: form.inclusions,
    exclusions: form.exclusions,
    deposit: { kind: form.depositKind, value: form.depositValue.trim() },
    validity_days: form.validity_days,
    company_terms: form.company_terms,
  };
}

// ── screen ────────────────────────────────────────────────────────────────────

export default function ProposalComposeScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const queryClient = useQueryClient();

  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showToast = useCallback((message: string) => {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    setToast(message);
    toastTimer.current = setTimeout(() => setToast(null), 3200);
  }, []);
  useEffect(
    () => () => {
      if (toastTimer.current) clearTimeout(toastTimer.current);
    },
    [],
  );

  const queryKey = useMemo(() => ['proposal', id] as const, [id]);
  const proposalQuery = useQuery({
    queryKey,
    queryFn: () => api.proposals.get(id),
    enabled: Boolean(id),
  });
  const proposal = proposalQuery.data;

  // Resolve the owning job (for deposit-paid state + "Done" navigation).
  const estimateId = proposal?.estimate_id;
  const estimateQuery = useQuery({
    queryKey: ['estimate', estimateId],
    queryFn: () => api.estimates.get(estimateId as string),
    enabled: Boolean(estimateId),
  });
  const jobId = estimateQuery.data?.job_id;
  const jobQuery = useQuery({
    queryKey: ['job', jobId],
    queryFn: () => api.jobs.get(jobId as string),
    enabled: Boolean(jobId),
  });

  const applyDetail = useCallback(
    (detail: ProposalWithDocument) => {
      queryClient.setQueryData(queryKey, detail);
      if (jobId) void queryClient.invalidateQueries({ queryKey: ['proposals', jobId] });
    },
    [queryClient, queryKey, jobId],
  );

  // ── form state (seeded once from the loaded draft) ─────────────────────────

  const [form, setForm] = useState<Form | null>(null);
  const formRef = useRef<Form | null>(null);
  const seededRef = useRef(false);
  useEffect(() => {
    formRef.current = form;
  });
  useEffect(() => {
    if (!seededRef.current && proposal && proposal.status === 'draft') {
      seededRef.current = true;
      setForm(seedForm(proposal));
    }
  }, [proposal]);

  const saveMutation = useMutation({
    mutationFn: (config: ProposalConfig) => api.proposals.updateConfig(id, config),
    onSuccess: applyDetail,
    onError: (err) => {
      if (err instanceof ApiError && err.status === 409) {
        showToast('This proposal was already sent — it can no longer be edited.');
        void proposalQuery.refetch();
        return;
      }
      showToast(err instanceof ApiError ? err.message : 'Could not save your changes.');
    },
  });
  const { mutate: mutateSave } = saveMutation;

  const save = useCallback(() => {
    if (formRef.current) mutateSave(buildConfig(formRef.current));
  }, [mutateSave]);

  const commit = useCallback(
    (next: Form) => {
      setForm(next);
      formRef.current = next;
      mutateSave(buildConfig(next));
    },
    [mutateSave],
  );

  const setField = useCallback(<K extends keyof Form>(key: K, value: Form[K]) => {
    setForm((f) => (f ? { ...f, [key]: value } : f));
  }, []);

  const sendMutation = useMutation({
    mutationFn: () => api.proposals.send(id),
    onSuccess: (detail) => {
      queryClient.setQueryData(queryKey, detail);
      if (jobId) {
        void queryClient.invalidateQueries({ queryKey: ['proposals', jobId] });
        void queryClient.invalidateQueries({ queryKey: ['job', jobId] });
        void queryClient.invalidateQueries({ queryKey: ['estimates', jobId] });
      }
      void queryClient.invalidateQueries({ queryKey: ['jobs'] });
    },
    onError: (err) => showToast(err instanceof ApiError ? err.message : 'Could not send. Try again.'),
  });

  const confirmSend = useCallback(() => {
    Alert.alert(
      'Send this proposal?',
      "This freezes the proposal and makes it viewable by the client. You can't edit a sent proposal — only create a new version.",
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Send proposal', onPress: () => sendMutation.mutate() },
      ],
    );
  }, [sendMutation]);

  const goToJob = useCallback(() => {
    if (jobId) router.replace(href(`/job/${jobId}`));
    else router.back();
  }, [jobId, router]);

  // ── loading / error ─────────────────────────────────────────────────────────

  if (!proposal) {
    return (
      <View style={styles.screen}>
        <StatusBar style="light" />
        <View style={{ height: insets.top, backgroundColor: colors.ink }} />
        <HeaderBand eyebrow="PROPOSAL" title="Compose" />
        <View style={styles.stateBody}>
          {proposalQuery.isError ? (
            <>
              <Text style={styles.stateText}>
                {proposalQuery.error instanceof ApiError
                  ? proposalQuery.error.message
                  : 'Could not load this proposal.'}
              </Text>
              <Button title="Retry" onPress={() => void proposalQuery.refetch()} />
            </>
          ) : (
            <View style={styles.skeleton}>
              {[64, 24, 48, 120, 48].map((height, i) => (
                <View key={i} style={[styles.skeletonBlock, { height }]} />
              ))}
            </View>
          )}
        </View>
      </View>
    );
  }

  const depositPaid = ['won', 'in_progress', 'complete', 'paid'].includes(
    jobQuery.data?.status ?? '',
  );

  // ── sent (immutable) summary ─────────────────────────────────────────────────

  if (proposal.status !== 'draft') {
    return (
      <SentSummary
        proposal={proposal}
        depositPaid={depositPaid}
        justSent={sendMutation.isSuccess}
        onDone={goToJob}
        showToast={showToast}
        insetsTop={insets.top}
        insetsBottom={insets.bottom}
      />
    );
  }

  const doc = asRecord(proposal.document) ?? {};

  // ── draft editor ──────────────────────────────────────────────────────────

  return (
    <View style={styles.screen}>
      <StatusBar style="light" />
      <View style={{ height: insets.top, backgroundColor: colors.ink }} />
      <HeaderBand
        eyebrow={`PROPOSAL / V${proposal.version}`}
        title="Compose"
        meta={money(doc['total'])}
      >
        <Text style={styles.headerHint}>
          Draft — nothing is sent until you approve and send it.
        </Text>
      </HeaderBand>

      <ScrollView
        style={styles.body}
        contentContainerStyle={styles.bodyContent}
        keyboardShouldPersistTaps="handled"
      >
        {form ? (
          <>
            <Section label="TITLE">
              <TextInput
                style={styles.input}
                value={form.title}
                placeholder="Proposal title"
                placeholderTextColor={colors.textMuted}
                accessibilityLabel="Proposal title"
                onChangeText={(v) => setField('title', v)}
                onBlur={save}
              />
            </Section>

            <Section label="INTRO MESSAGE" hint="AI-drafted from your scope — edit freely.">
              <TextInput
                style={[styles.input, styles.multiline]}
                value={form.intro_message}
                placeholder="A short, friendly note to your client…"
                placeholderTextColor={colors.textMuted}
                accessibilityLabel="Intro message"
                multiline
                onChangeText={(v) => setField('intro_message', v)}
                onBlur={save}
              />
            </Section>

            <Section label="COVER PHOTO" hint="Paste an image URL, or leave blank for no cover.">
              <TextInput
                style={styles.input}
                value={form.cover_photo_url}
                placeholder="https://…"
                placeholderTextColor={colors.textMuted}
                accessibilityLabel="Cover photo URL"
                autoCapitalize="none"
                autoCorrect={false}
                keyboardType="url"
                onChangeText={(v) => setField('cover_photo_url', v)}
                onBlur={save}
              />
              {form.cover_photo_url.trim() ? (
                <Pressable
                  onPress={() => commit({ ...form, cover_photo_url: '' })}
                  accessibilityRole="button"
                  accessibilityLabel="Remove cover photo"
                  hitSlop={8}
                  style={({ pressed }) => pressed && styles.pressed}
                >
                  <Text style={styles.inlineAction}>Remove cover</Text>
                </Pressable>
              ) : null}
            </Section>

            <EditableList
              label="INCLUDED"
              items={form.inclusions}
              placeholder="Add an included item…"
              onChange={(next) => commit({ ...form, inclusions: next })}
            />

            <EditableList
              label="EXCLUDED"
              items={form.exclusions}
              placeholder="Add an excluded item…"
              onChange={(next) => commit({ ...form, exclusions: next })}
            />

            <Section label="DEPOSIT" hint="Collected when the client signs.">
              <View style={styles.segmented}>
                <SegButton
                  label="Percent"
                  selected={form.depositKind === 'percent'}
                  onPress={() => commit({ ...form, depositKind: 'percent' })}
                />
                <SegButton
                  label="Flat"
                  selected={form.depositKind === 'flat'}
                  onPress={() => commit({ ...form, depositKind: 'flat' })}
                />
              </View>
              <View style={styles.depositRow}>
                <TextInput
                  style={[styles.input, styles.depositInput]}
                  value={form.depositValue}
                  placeholder={form.depositKind === 'percent' ? '25' : '0.00'}
                  placeholderTextColor={colors.textMuted}
                  accessibilityLabel="Deposit value"
                  keyboardType="decimal-pad"
                  onChangeText={(v) => setField('depositValue', v)}
                  onBlur={save}
                />
                <Text style={styles.depositUnit}>
                  {form.depositKind === 'percent' ? '% of total' : 'flat'}
                </Text>
              </View>
              <Text style={styles.computed}>
                Deposit due: {money(doc['deposit_amount'])}
                {str(doc['deposit_label']) ? ` · ${str(doc['deposit_label'])}` : ''}
              </Text>
            </Section>

            <Section label="VALID FOR">
              <View style={styles.stepperRow}>
                <Pressable
                  onPress={() =>
                    commit({ ...form, validity_days: Math.max(1, form.validity_days - 1) })
                  }
                  accessibilityRole="button"
                  accessibilityLabel="Fewer days"
                  style={({ pressed }) => [styles.stepBtn, pressed && styles.stepBtnPressed]}
                >
                  <Minus size={16} color={colors.ink} />
                </Pressable>
                <Text style={styles.stepValue}>{form.validity_days} days</Text>
                <Pressable
                  onPress={() =>
                    commit({ ...form, validity_days: Math.min(365, form.validity_days + 1) })
                  }
                  accessibilityRole="button"
                  accessibilityLabel="More days"
                  style={({ pressed }) => [styles.stepBtn, pressed && styles.stepBtnPressed]}
                >
                  <Plus size={16} color={colors.ink} />
                </Pressable>
              </View>
            </Section>

            <Section label="YOUR TERMS" hint="Company terms shown to the client.">
              <TextInput
                style={[styles.input, styles.multiline]}
                value={form.company_terms}
                placeholder="Payment terms, warranty, scheduling notes…"
                placeholderTextColor={colors.textMuted}
                accessibilityLabel="Company terms"
                multiline
                onChangeText={(v) => setField('company_terms', v)}
                onBlur={save}
              />
            </Section>

            <View style={styles.saveState}>
              {saveMutation.isPending ? (
                <Text style={styles.saveText}>Saving…</Text>
              ) : (
                <Text style={styles.saveText}>All changes saved</Text>
              )}
            </View>
          </>
        ) : (
          <ActivityIndicator color={colors.accentText} style={{ marginVertical: spacing.lg }} />
        )}

        <PreviewCard doc={doc} />
      </ScrollView>

      <View style={[styles.bottomBar, { paddingBottom: insets.bottom + spacing.sm }]}>
        <Button
          title="Send proposal"
          loading={sendMutation.isPending}
          onPress={confirmSend}
        />
      </View>

      {toast ? (
        <View pointerEvents="none" style={[styles.toast, { bottom: insets.bottom + 96 }]}>
          <Text style={styles.toastText}>{toast}</Text>
        </View>
      ) : null}
    </View>
  );
}

// ── sent summary ───────────────────────────────────────────────────────────

function SentSummary({
  proposal,
  depositPaid,
  justSent,
  onDone,
  showToast,
  insetsTop,
  insetsBottom,
}: {
  proposal: ProposalWithDocument;
  depositPaid: boolean;
  justSent: boolean;
  onDone: () => void;
  showToast: (message: string) => void;
  insetsTop: number;
  insetsBottom: number;
}) {
  const url = `${WEB_URL}/p/${proposal.public_token}`;
  const doc = asRecord(proposal.document) ?? {};

  const share = useCallback(async () => {
    try {
      await Share.share({ message: url });
    } catch {
      showToast('Link is selectable below — long-press to copy.');
    }
  }, [url, showToast]);

  const openPreview = useCallback(() => {
    void WebBrowser.openBrowserAsync(url).catch(() => showToast('Could not open the preview.'));
  }, [url, showToast]);

  const statusLabel = proposal.status.charAt(0).toUpperCase() + proposal.status.slice(1);

  return (
    <View style={styles.screen}>
      <StatusBar style="light" />
      <View style={{ height: insetsTop, backgroundColor: colors.ink }} />
      <HeaderBand eyebrow={`PROPOSAL / V${proposal.version}`} title="Sent" meta={money(doc['total'])} />

      <ScrollView style={styles.body} contentContainerStyle={styles.bodyContent}>
        <View style={styles.sentCard}>
          <View style={styles.sentBadgeRow}>
            <View style={styles.sentBadge}>
              <Check size={16} color={colors.textOnInk} />
            </View>
            <Text style={styles.sentTitle}>
              {justSent ? 'Proposal sent' : `Proposal ${statusLabel.toLowerCase()}`}
            </Text>
          </View>
          <Text style={styles.sentBody}>
            This proposal is locked. Share the link so your client can review, sign, and pay the
            deposit. To change anything, create a new version.
          </Text>
        </View>

        <Section label="SHAREABLE LINK">
          <View style={styles.linkBox}>
            <LinkIcon size={16} color={colors.textMuted} />
            <Text style={styles.linkText} selectable numberOfLines={2}>
              {url}
            </Text>
          </View>
          <View style={styles.linkActions}>
            <Pressable
              onPress={share}
              accessibilityRole="button"
              accessibilityLabel="Share link"
              style={({ pressed }) => [styles.linkBtn, pressed && styles.pressed]}
            >
              <Share2 size={16} color={colors.ink} />
              <Text style={styles.linkBtnText}>Share link</Text>
            </Pressable>
            <Pressable
              onPress={openPreview}
              accessibilityRole="button"
              accessibilityLabel="Open preview"
              style={({ pressed }) => [styles.linkBtn, pressed && styles.pressed]}
            >
              <ExternalLink size={16} color={colors.ink} />
              <Text style={styles.linkBtnText}>Open preview</Text>
            </Pressable>
          </View>
          <Text style={styles.linkHint}>Long-press the link to copy it.</Text>
        </Section>

        <Section label="STATUS">
          <ProposalTimeline
            sentAt={proposal.sent_at}
            firstViewedAt={proposal.first_viewed_at}
            viewCount={proposal.view_count}
            signedAt={proposal.signature?.signed_at ?? null}
            signerName={proposal.signature?.signer_name ?? null}
            depositPaid={depositPaid}
          />
        </Section>
      </ScrollView>

      <View style={[styles.bottomBar, { paddingBottom: insetsBottom + spacing.sm }]}>
        <Button title="Done" onPress={onDone} />
      </View>
    </View>
  );
}

// ── preview ────────────────────────────────────────────────────────────────

function PreviewCard({ doc }: { doc: Record<string, unknown> }) {
  const company = asRecord(doc['company']);
  const client = asRecord(doc['client']);
  const lines = asArray(doc['lines'])
    .map(asRecord)
    .filter((l): l is Record<string, unknown> => l !== null);
  const optionGroups = asArray(doc['option_groups'])
    .map(asRecord)
    .filter((g): g is Record<string, unknown> => g !== null);
  const inclusions = strList(doc['inclusions']);
  const exclusions = strList(doc['exclusions']);
  const disclaimer = str(doc['platform_disclaimer']);
  const cover = str(doc['cover_photo_url']);
  const logo = str(company?.['logo_url']);

  return (
    <View style={styles.previewWrap}>
      <EquipmentLabel text="LIVE PREVIEW" />
      <View style={styles.preview}>
        {cover ? (
          <Image source={{ uri: cover }} style={styles.cover} contentFit="cover" transition={150} />
        ) : (
          <View style={[styles.cover, styles.coverEmpty]}>
            <Text style={styles.coverEmptyText}>No cover photo</Text>
          </View>
        )}

        <View style={styles.previewInner}>
          <View style={styles.previewHead}>
            {logo ? (
              <Image source={{ uri: logo }} style={styles.logo} contentFit="contain" />
            ) : null}
            <View style={styles.previewHeadText}>
              <Text style={styles.previewCompany}>{str(company?.['name']) || 'Your company'}</Text>
              {client ? <Text style={styles.previewClient}>For {str(client['name'])}</Text> : null}
            </View>
          </View>

          {str(doc['title']) ? <Text style={styles.previewTitle}>{str(doc['title'])}</Text> : null}
          {str(doc['intro_message']) ? (
            <Text style={styles.previewIntro}>{str(doc['intro_message'])}</Text>
          ) : null}
          {str(doc['scope_prose']) ? (
            <Text style={styles.previewScope}>{str(doc['scope_prose'])}</Text>
          ) : null}

          {lines.length > 0 ? (
            <View style={styles.previewLines}>
              {lines.map((line, i) => {
                const lineType = str(line['line_type']);
                const confidence = str(line['confidence']);
                const isAllowance = lineType === 'allowance';
                const isVerify = lineType === 'verify' || confidence === 'verify';
                return (
                  <View key={`line-${i}`} style={styles.previewLine}>
                    <View style={styles.previewLineLeft}>
                      <Text style={styles.previewLineDesc}>{str(line['description'])}</Text>
                      <View style={styles.previewBadgeRow}>
                        {isAllowance ? (
                          <View style={[styles.previewBadge, styles.badgeAllowance]}>
                            <Text style={[styles.previewBadgeText, { color: colors.warning }]}>
                              ALLOWANCE
                            </Text>
                          </View>
                        ) : null}
                        {isVerify ? (
                          <View style={[styles.previewBadge, styles.badgeVerify]}>
                            <Text style={[styles.previewBadgeText, { color: colors.accentText }]}>
                              VERIFY ON SITE
                            </Text>
                          </View>
                        ) : null}
                        {numeric(line['qty']) > 1 ? (
                          <Text style={styles.previewQty}>×{fmtNum(line['qty'])}</Text>
                        ) : null}
                      </View>
                      {str(line['note']) ? (
                        <Text style={styles.previewLineNote}>{str(line['note'])}</Text>
                      ) : null}
                    </View>
                    <Text style={styles.previewLineTotal}>{money(line['total'])}</Text>
                  </View>
                );
              })}
            </View>
          ) : null}

          {optionGroups.map((group, i) => {
            const tiers = asArray(group['tiers'])
              .map(asRecord)
              .filter((t): t is Record<string, unknown> => t !== null);
            return (
              <View key={`opt-${i}`} style={styles.optionGroup}>
                <Text style={styles.optionTitle}>{str(group['base_description'])}</Text>
                {tiers.map((tier, j) => (
                  <View key={`tier-${j}`} style={styles.optionTier}>
                    <Text style={styles.optionTierLabel}>{str(tier['label'])}</Text>
                    <Text style={styles.optionTierTotal}>{money(tier['total'])}</Text>
                  </View>
                ))}
              </View>
            );
          })}

          {inclusions.length > 0 ? (
            <PreviewBullets title="Included" items={inclusions} />
          ) : null}
          {exclusions.length > 0 ? (
            <PreviewBullets title="Not included" items={exclusions} />
          ) : null}

          <View style={styles.previewTotals}>
            <PreviewTotal label="Subtotal" value={doc['subtotal']} />
            <PreviewTotal label="Tax" value={doc['tax']} />
            <PreviewTotal label="Total" value={doc['total']} grand />
          </View>

          <View style={styles.depositCallout}>
            <Text style={styles.depositCalloutLabel}>
              {str(doc['deposit_label']) || 'Deposit due at signing'}
            </Text>
            <Text style={styles.depositCalloutValue}>{money(doc['deposit_amount'])}</Text>
          </View>

          {numeric(doc['validity_days']) > 0 ? (
            <Text style={styles.previewValidity}>
              Valid for {fmtNum(doc['validity_days'])} days.
            </Text>
          ) : null}

          {str(doc['company_terms']) ? (
            <View style={styles.previewTermsBlock}>
              <EquipmentLabel text="TERMS" />
              <Text style={styles.previewTerms}>{str(doc['company_terms'])}</Text>
            </View>
          ) : null}

          {disclaimer ? (
            <View style={styles.disclaimerBlock}>
              <Text style={styles.disclaimerLabel}>ALWAYS INCLUDED, NON-REMOVABLE</Text>
              <Text style={styles.disclaimerText}>{disclaimer}</Text>
            </View>
          ) : null}
        </View>
      </View>
    </View>
  );
}

function PreviewBullets({ title, items }: { title: string; items: string[] }) {
  return (
    <View style={styles.bulletsBlock}>
      <Text style={styles.bulletsTitle}>{title}</Text>
      {items.map((item, i) => (
        <View key={`${title}-${i}`} style={styles.bulletRow}>
          <Text style={styles.bulletDot}>•</Text>
          <Text style={styles.bulletText}>{item}</Text>
        </View>
      ))}
    </View>
  );
}

function PreviewTotal({
  label,
  value,
  grand,
}: {
  label: string;
  value: unknown;
  grand?: boolean;
}) {
  return (
    <View style={[styles.previewTotalRow, grand && styles.previewGrandRow]}>
      <Text style={[styles.previewTotalLabel, grand && styles.previewGrandLabel]}>{label}</Text>
      <Text style={[styles.previewTotalValue, grand && styles.previewGrandValue]}>
        {money(value)}
      </Text>
    </View>
  );
}

// ── small building blocks ──────────────────────────────────────────────────

function Section({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <View style={styles.section}>
      <EquipmentLabel text={label} />
      {hint ? <Text style={styles.sectionHint}>{hint}</Text> : null}
      {children}
    </View>
  );
}

function SegButton({
  label,
  selected,
  onPress,
}: {
  label: string;
  selected: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityState={{ selected }}
      style={({ pressed }) => [
        styles.segBtn,
        selected && styles.segBtnSelected,
        pressed && styles.pressed,
      ]}
    >
      <Text style={[styles.segBtnText, selected && styles.segBtnTextSelected]}>{label}</Text>
    </Pressable>
  );
}

function EditableList({
  label,
  items,
  placeholder,
  onChange,
}: {
  label: string;
  items: string[];
  placeholder: string;
  onChange: (next: string[]) => void;
}) {
  const [draft, setDraft] = useState('');
  const add = () => {
    const value = draft.trim();
    if (!value) return;
    onChange([...items, value]);
    setDraft('');
  };
  return (
    <Section label={label}>
      {items.length > 0 ? (
        <View style={styles.chipList}>
          {items.map((item, i) => (
            <View key={`${item}-${i}`} style={styles.itemChip}>
              <Text style={styles.itemChipText}>{item}</Text>
              <Pressable
                onPress={() => onChange(items.filter((_, idx) => idx !== i))}
                accessibilityRole="button"
                accessibilityLabel={`Remove ${item}`}
                hitSlop={8}
                style={({ pressed }) => pressed && styles.pressed}
              >
                <X size={14} color={colors.textMuted} />
              </Pressable>
            </View>
          ))}
        </View>
      ) : null}
      <View style={styles.addRow}>
        <TextInput
          style={[styles.input, styles.addInput]}
          value={draft}
          placeholder={placeholder}
          placeholderTextColor={colors.textMuted}
          accessibilityLabel={placeholder}
          onChangeText={setDraft}
          onSubmitEditing={add}
          returnKeyType="done"
        />
        <Pressable
          onPress={add}
          accessibilityRole="button"
          accessibilityLabel={`Add to ${label.toLowerCase()}`}
          style={({ pressed }) => [styles.addBtn, pressed && styles.stepBtnPressed]}
        >
          <Plus size={18} color={colors.ink} />
        </Pressable>
      </View>
    </Section>
  );
}

// ── styles ─────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  pressed: { opacity: 0.7 },
  headerHint: {
    color: colors.textMuted,
    fontSize: typography.size.xs,
    fontFamily: typography.family.medium,
    marginTop: spacing.xs,
  },

  // states
  stateBody: {
    flex: 1,
    padding: spacing.lg,
    gap: spacing.md,
    width: '100%',
    maxWidth: 640,
    alignSelf: 'center',
  },
  stateText: { color: colors.textSecondary, fontSize: typography.size.md, lineHeight: 22 },
  skeleton: { gap: spacing.sm },
  skeletonBlock: { backgroundColor: colors.surfaceSunken, borderRadius: radii.md },

  // body
  body: { flex: 1 },
  bodyContent: {
    width: '100%',
    maxWidth: 640,
    alignSelf: 'center',
    padding: spacing.lg,
    paddingBottom: spacing.xxl,
    gap: spacing.lg,
  },

  section: { gap: spacing.sm },
  sectionHint: { color: colors.textMuted, fontSize: typography.size.xs, lineHeight: 16 },

  input: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: 1.5,
    borderRadius: radii.md,
    minHeight: touchTarget,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm + 2,
    fontSize: typography.size.md,
    fontFamily: typography.family.regular,
    color: colors.text,
  },
  multiline: { minHeight: 96, textAlignVertical: 'top', paddingTop: spacing.sm + 2 },
  inlineAction: {
    color: colors.accentText,
    fontSize: typography.size.sm,
    fontFamily: typography.family.semibold,
    paddingVertical: spacing.xs,
  },

  // editable lists
  chipList: { gap: spacing.sm },
  itemChip: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    minHeight: 44,
  },
  itemChipText: {
    flex: 1,
    color: colors.text,
    fontSize: typography.size.sm,
    fontFamily: typography.family.regular,
  },
  addRow: { flexDirection: 'row', gap: spacing.sm },
  addInput: { flex: 1 },
  addBtn: {
    width: touchTarget,
    height: touchTarget,
    borderRadius: radii.md,
    borderWidth: 1.5,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },

  // segmented
  segmented: { flexDirection: 'row', gap: spacing.sm },
  segBtn: {
    flex: 1,
    minHeight: touchTarget,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radii.md,
    borderWidth: 1.5,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  segBtnSelected: { backgroundColor: colors.ink, borderColor: colors.ink },
  segBtnText: {
    color: colors.text,
    fontSize: typography.size.sm,
    fontFamily: typography.family.semibold,
  },
  segBtnTextSelected: { color: colors.textOnInk },
  depositRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  depositInput: { width: 120, fontFamily: typography.family.mono, textAlign: 'right' },
  depositUnit: { color: colors.textSecondary, fontSize: typography.size.sm },
  computed: {
    color: colors.text,
    fontSize: typography.size.sm,
    fontFamily: typography.family.mono,
  },

  // stepper
  stepperRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  stepBtn: {
    width: touchTarget,
    height: touchTarget,
    borderRadius: radii.md,
    borderWidth: 1.5,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  stepBtnPressed: { backgroundColor: colors.surfaceSunken },
  stepValue: {
    minWidth: 96,
    textAlign: 'center',
    color: colors.text,
    fontSize: typography.size.md,
    fontFamily: typography.family.mono,
  },

  saveState: { alignItems: 'flex-end' },
  saveText: {
    color: colors.textMuted,
    fontSize: typography.size.xs,
    fontFamily: typography.family.medium,
  },

  // preview
  previewWrap: { gap: spacing.sm },
  preview: {
    backgroundColor: colors.surface,
    borderRadius: radii.lg,
    borderWidth: 1,
    borderColor: colors.border,
    overflow: 'hidden',
  },
  cover: { width: '100%', height: 160, backgroundColor: colors.surfaceSunken },
  coverEmpty: { alignItems: 'center', justifyContent: 'center' },
  coverEmptyText: {
    color: colors.textMuted,
    fontSize: typography.size.xs,
    fontFamily: typography.family.medium,
    letterSpacing: 1,
  },
  previewInner: { padding: spacing.lg, gap: spacing.md },
  previewHead: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  logo: { width: 44, height: 44, borderRadius: radii.sm },
  previewHeadText: { flex: 1, gap: 2 },
  previewCompany: {
    color: colors.ink,
    fontSize: typography.size.md,
    fontFamily: typography.family.bold,
  },
  previewClient: { color: colors.textSecondary, fontSize: typography.size.sm },
  previewTitle: {
    color: colors.text,
    fontSize: typography.size.lg,
    fontFamily: typography.family.extrabold,
    letterSpacing: -0.5,
  },
  previewIntro: {
    color: colors.text,
    fontSize: typography.size.md,
    fontFamily: typography.family.regular,
    lineHeight: 24,
  },
  previewScope: {
    color: colors.textSecondary,
    fontSize: typography.size.sm,
    lineHeight: 22,
  },
  previewLines: {
    borderTopWidth: 1,
    borderTopColor: colors.border,
    paddingTop: spacing.sm,
    gap: spacing.sm,
  },
  previewLine: { flexDirection: 'row', justifyContent: 'space-between', gap: spacing.md },
  previewLineLeft: { flex: 1, gap: spacing.xs },
  previewLineDesc: {
    color: colors.text,
    fontSize: typography.size.sm,
    fontFamily: typography.family.medium,
    lineHeight: 20,
  },
  previewLineNote: { color: colors.textMuted, fontSize: typography.size.xs, lineHeight: 16 },
  previewLineTotal: {
    color: colors.text,
    fontSize: typography.size.sm,
    fontFamily: typography.family.mono,
    textAlign: 'right',
  },
  previewBadgeRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: spacing.xs },
  previewBadge: { borderRadius: radii.sm, paddingHorizontal: spacing.sm, paddingVertical: 2 },
  badgeAllowance: { backgroundColor: colors.warningBg },
  badgeVerify: { backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.accentText },
  previewBadgeText: { fontSize: 10, fontFamily: typography.family.semibold, letterSpacing: 1 },
  previewQty: {
    color: colors.textSecondary,
    fontSize: typography.size.xs,
    fontFamily: typography.family.mono,
  },
  optionGroup: {
    borderTopWidth: 1,
    borderTopColor: colors.border,
    paddingTop: spacing.sm,
    gap: spacing.xs,
  },
  optionTitle: {
    color: colors.text,
    fontSize: typography.size.sm,
    fontFamily: typography.family.semibold,
  },
  optionTier: { flexDirection: 'row', justifyContent: 'space-between', paddingLeft: spacing.md },
  optionTierLabel: { color: colors.textSecondary, fontSize: typography.size.sm },
  optionTierTotal: {
    color: colors.text,
    fontSize: typography.size.sm,
    fontFamily: typography.family.mono,
  },
  bulletsBlock: { gap: spacing.xs },
  bulletsTitle: {
    color: colors.text,
    fontSize: typography.size.sm,
    fontFamily: typography.family.semibold,
  },
  bulletRow: { flexDirection: 'row', gap: spacing.sm },
  bulletDot: { color: colors.primary, fontSize: typography.size.sm },
  bulletText: { flex: 1, color: colors.textSecondary, fontSize: typography.size.sm, lineHeight: 20 },
  previewTotals: {
    borderTopWidth: 1,
    borderTopColor: colors.border,
    paddingTop: spacing.sm,
    gap: spacing.xs,
  },
  previewTotalRow: { flexDirection: 'row', justifyContent: 'space-between' },
  previewTotalLabel: { color: colors.textSecondary, fontSize: typography.size.sm },
  previewTotalValue: {
    color: colors.text,
    fontSize: typography.size.sm,
    fontFamily: typography.family.mono,
  },
  previewGrandRow: {
    borderTopWidth: 1,
    borderTopColor: colors.ink,
    paddingTop: spacing.xs,
    marginTop: spacing.xs,
    alignItems: 'baseline',
  },
  previewGrandLabel: {
    color: colors.text,
    fontSize: typography.size.sm,
    fontFamily: typography.family.semibold,
  },
  previewGrandValue: {
    color: colors.ink,
    fontSize: typography.size.lg,
    fontFamily: typography.family.mono,
  },
  depositCallout: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.md,
    backgroundColor: colors.warningBg,
    borderRadius: radii.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  depositCalloutLabel: {
    flex: 1,
    color: colors.warning,
    fontSize: typography.size.sm,
    fontFamily: typography.family.semibold,
  },
  depositCalloutValue: {
    color: colors.warning,
    fontSize: typography.size.md,
    fontFamily: typography.family.mono,
  },
  previewValidity: { color: colors.textMuted, fontSize: typography.size.xs },
  previewTermsBlock: {
    borderTopWidth: 1,
    borderTopColor: colors.border,
    paddingTop: spacing.sm,
    gap: spacing.xs,
  },
  previewTerms: { color: colors.textSecondary, fontSize: typography.size.xs, lineHeight: 18 },
  disclaimerBlock: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.md,
    backgroundColor: colors.surfaceSunken,
    padding: spacing.md,
    gap: spacing.xs,
  },
  disclaimerLabel: {
    color: colors.textMuted,
    fontSize: 10,
    fontFamily: typography.family.semibold,
    letterSpacing: 1,
  },
  disclaimerText: { color: colors.textSecondary, fontSize: typography.size.xs, lineHeight: 18 },

  // sent summary
  sentCard: {
    backgroundColor: colors.surface,
    borderRadius: radii.lg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.lg,
    gap: spacing.sm,
  },
  sentBadgeRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  sentBadge: {
    width: 28,
    height: 28,
    borderRadius: radii.full,
    backgroundColor: colors.success,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sentTitle: { color: colors.text, fontSize: typography.size.lg, fontFamily: typography.family.bold },
  sentBody: { color: colors.textSecondary, fontSize: typography.size.sm, lineHeight: 20 },
  linkBox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    backgroundColor: colors.surface,
    borderWidth: 1.5,
    borderColor: colors.border,
    borderRadius: radii.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm + 2,
  },
  linkText: {
    flex: 1,
    color: colors.text,
    fontSize: typography.size.sm,
    fontFamily: typography.family.mono,
  },
  linkActions: { flexDirection: 'row', gap: spacing.sm },
  linkBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    minHeight: touchTarget,
    borderRadius: radii.md,
    borderWidth: 1.5,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  linkBtnText: { color: colors.ink, fontSize: typography.size.sm, fontFamily: typography.family.semibold },
  linkHint: { color: colors.textMuted, fontSize: typography.size.xs },

  // bottom bar
  bottomBar: {
    borderTopWidth: 1,
    borderTopColor: colors.border,
    backgroundColor: colors.surface,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.sm,
  },

  // toast
  toast: {
    position: 'absolute',
    left: spacing.lg,
    right: spacing.lg,
    backgroundColor: colors.ink,
    borderRadius: radii.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm + 2,
  },
  toastText: {
    color: colors.textOnInk,
    fontSize: typography.size.sm,
    fontFamily: typography.family.medium,
    textAlign: 'center',
  },
});
