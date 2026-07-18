/**
 * Address autocomplete interface (CLAUDE.md Phase 1: "stubbed geocode
 * interface"). Real provider (e.g. Google Places) slots in behind
 * `suggestAddresses` without touching the create-job flow.
 */

export interface AddressSuggestion {
  label: string;
}

export async function suggestAddresses(query: string): Promise<AddressSuggestion[]> {
  // Stub: echo the typed address as the only suggestion.
  const trimmed = query.trim();
  return trimmed.length > 5 ? [{ label: trimmed }] : [];
}
