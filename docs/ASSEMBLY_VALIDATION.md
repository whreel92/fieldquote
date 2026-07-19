# Assembly Catalog Validation Packet — v0

**Status: PLACEHOLDER DATA.** Every assembly in the seed catalog is
`status: draft`, authored by the engineering team as invented-but-plausible
values. **No production launch until licensed electrician advisors review the
packet and assemblies are flipped to `advisor_approved`.** The API enforces
this: companies in a production environment can only price against
`advisor_approved` assemblies (unless the company has `dev_mode` set — dev/test
only).

## What advisors are reviewing

For each assembly (and each good/better/best tier):

1. **Labor hours** — is the estimate right for a typical residential job in
   your market? The `labor_notes` column explains the reasoning; correct it.
2. **BOM** — are the listed materials and quantities what you'd actually
   stock/buy for this job? Missing items? Wrong wire gauge/lengths?
3. **Allowed modifiers** — do the situational adjustments (occupied home,
   stucco exterior, attic run, obsolete panel brand…) make sense for this
   assembly, and are the multipliers fair?
4. **Anything unsafe or code-relevant we've framed as fact** — flag it. Code
   requirements must surface as _notes for the licensed contractor to confirm_,
   never as assertions.

## How to review

1. Regenerate the packet: `cd apps/api && uv run python scripts/export_validation_csv.py`
   → `docs/validation/assemblies_v0.csv`.
2. Send the CSV to each advisor. They fill in the last three columns:
   `advisor_verdict (approve / adjust)`, `adjusted_labor_hours`, `advisor_notes`.
3. Apply adjustments in the admin catalog browser (`/app/admin/assemblies`,
   owner/admin role) — each edit bumps the assembly `version` and is
   audit-logged. Flip the status to **advisor approved** only after the advisor
   has signed off on the row.
4. Material base prices are placeholders dated `price_asof: 2026-07-01` and
   sourced `placeholder_v0`. Pricing refresh is a separate workstream — advisors
   should sanity-check only that prices aren't wildly off.

## Modifier reference

| Code                 | Effect                |
| -------------------- | --------------------- |
| occupied_home        | labor ×1.15           |
| stucco_exterior      | labor ×1.25           |
| two_story            | labor ×1.2            |
| attic_run            | +0.75 h               |
| finished_walls       | labor ×1.35           |
| crawlspace           | +0.5 h                |
| permit_handling      | +1.0 h                |
| panel_brand_obsolete | +1.5 h                |
| long_run_over_50ft   | material ×1.5, +0.5 h |
| tight_workspace      | labor ×1.15           |
| ceiling_over_10ft    | +0.5 h                |
| trench_required      | +3.0 h, material ×1.2 |

Multiplicative effects apply before additive ones (ADR-0005).
