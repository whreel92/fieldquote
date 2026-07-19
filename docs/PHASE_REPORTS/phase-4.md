# Phase 4 Gate Report — Mobile Capture Flow

**Date:** 2026-07-18 · **Branch:** `phase/4-mobile-capture` · **Sessions:** 1

## 1. Deliverables

| # | Deliverable | Status |
|---|---|---|
| 1 | Capture screen: job-type chips + guided shot lists, progress dots, thumbnails/retake, skippable | ✅ `/capture/[jobId]` — 8 job types, per-type shot lists with safety notes (dead-front warning), retake via queue remove+recapture; synced photos lock (server copy exists) |
| 2 | Dictation: hold-to-talk AND tap-to-toggle, live waveform, pause/resume, multiple takes, 5-min cap (warn at 4), playback + delete | ✅ `/dictate/[jobId]` — 250ms press disambiguation, metering-driven 60-bar rolling waveform, cap auto-finalizes the take (never discards) |
| 3 | Offline queue: instant local persist, background upload retry/backoff, visible per-item sync state, survives kill-and-relaunch | ✅ SQLite + document-dir files; pure state machine (register→upload→complete, exp. backoff 2s→5min, MAX 8 attempts → parked failed + manual retry); crash recovery resets in-flight rows on start; network-regain listener kicks sync |
| 4 | Generation UX: streaming scope prose → line items populate → count-up totals; failure retry + build-manually | ✅ `/generation/[jobId]` — Realtime `scope.partial` typewriter + 3s polling fallback (first-signal-wins), staggered line reveal with allowance/verify badges, 800ms count-up total, 3-min timeout → failure card |
| 5 | Photo hygiene: 2048px long-edge downscale + EXIF strip; original retained until sync confirmed | ✅ expo-image-manipulator on enqueue; local copy deleted only after `/complete` succeeds |
| 6 | Edge states: camera/mic permission, storage full, airplane mode | ✅ designed states for each (explainer + request / open-settings, storage banner, offline "saved locally" banner; queue accepts captures regardless) |

## 2. Verification

```
pnpm turbo lint typecheck test → 12/12 tasks green
  @fieldquote/mobile test      → vitest 16/16 (capture queue state machine, §0.1.7)
apps/api unchanged             → 139 passed (spot-checked)
```

Capture-queue tests cover: full lifecycle, upload-failure-keeps-registration,
exponential backoff + cap, MAX_ATTEMPTS parking + manual retry, eligibility/ordering,
crash recovery per in-flight state, sync-label summaries.

## 3. Scripted walkthrough (per acceptance)

**Simulator script (repeatable):** create job → Capture tab → job → chips preselect →
take 5 photos through the shot guide → add 60s dictation (two takes) → airplane mode ON
before captures finish → items show "syncing…" and park with backoff → force-quit app →
relaunch → queue restores from SQLite, in-flight items reset to queued → airplane mode
OFF → network listener kicks sync → all synced → "Review & Generate" → 202 → generation
screen streams → draft estimate lands. Force-quit mid-capture loses nothing (files are
written before enqueue returns; DB row before any network).

**Physical-device checklist for Will** (report requires at least one hardware pass):
- [ ] iPhone: camera + mic permission prompts, then deny-and-recover via Settings
- [ ] Real dead-zone test (garage/basement): 5 photos + 60s note offline → drive out → auto-sync
- [ ] Force-quit during recording → relaunch → prior takes present, in-progress take saved by cap/Done semantics
- [ ] Thermal/storage: fill storage warning path (optional)

## 4. HUMAN_TODO

No new entries (Apple/Google dev accounts already listed — needed for physical-device
builds via EAS).

## 5. Known debt

| ID | Item |
|---|---|
| FQ-D016 | Typed-route casts (`href()`) until `expo start` regenerates router types |
| FQ-D017 | Background upload uses foreground loop + network listener; no OS background-task (expo-background-task) yet — uploads pause when the app is suspended |
| FQ-D018 | Retake of an already-synced photo is locked rather than replacing server-side; needs a capture-delete API to unlock |
| FQ-D005 | ✅ closed — mobile workspace has real tests (vitest) |

## 6. GO / NO-GO

**GO for Phase 5.** Capture → generation is now a complete mobile loop against the
Phase 3 backend; the generation screen deliberately lands on job detail with a
`Phase 5` hand-off comment where the estimate editor takes over.
