/**
 * Guided shot lists per job type (§Phase 4.1). Every shot is skippable —
 * the guide raises capture quality, it never blocks the contractor.
 */

export interface Shot {
  key: string;
  label: string;
  hint: string;
  safetyNote?: string;
}

export interface ShotList {
  jobTypeCode: string;
  label: string;
  shots: Shot[];
}

export const JOB_TYPE_CHIPS: { code: string; label: string }[] = [
  { code: 'panel_upgrade', label: 'Panel Upgrade' },
  { code: 'ev_charger', label: 'EV Charger' },
  { code: 'service_call', label: 'Service Call' },
  { code: 'circuits_outlets', label: 'Circuits / Outlets' },
  { code: 'fixtures_fans', label: 'Fixtures / Fans' },
  { code: 'remodel', label: 'Remodel' },
  { code: 'generator', label: 'Generator' },
  { code: 'other', label: 'Other' },
];

const PANEL_SHOTS: Shot[] = [
  { key: 'panel_exterior', label: 'Panel exterior', hint: 'Door closed, label visible' },
  {
    key: 'panel_interior',
    label: 'Panel interior',
    hint: 'Dead-front off, full breaker layout',
    safetyNote: 'Only remove the dead-front if you are qualified and it is safe to do so.',
  },
  { key: 'meter', label: 'Meter', hint: 'Meter base and number' },
  { key: 'service_entrance', label: 'Service entrance', hint: 'Mast / weatherhead or lateral' },
  { key: 'bonding', label: 'Main bonding', hint: 'Ground/bond connections if visible' },
  { key: 'surroundings', label: 'Surroundings', hint: 'Wide shot — wall, clearances, access' },
];

export const SHOT_LISTS: Record<string, ShotList> = {
  panel_upgrade: { jobTypeCode: 'panel_upgrade', label: 'Panel Upgrade', shots: PANEL_SHOTS },
  ev_charger: {
    jobTypeCode: 'ev_charger',
    label: 'EV Charger',
    shots: [
      { key: 'panel_interior', label: 'Panel', hint: 'Interior — breaker spaces + main rating' },
      { key: 'charger_location', label: 'Charger location', hint: 'Where the EVSE mounts' },
      { key: 'route', label: 'Cable route', hint: 'Path from panel to charger, key obstacles' },
      { key: 'exterior', label: 'Exterior walls', hint: 'If the run goes outside' },
    ],
  },
  service_call: {
    jobTypeCode: 'service_call',
    label: 'Service Call',
    shots: [
      { key: 'problem_area', label: 'Problem area', hint: 'The outlet / fixture / device' },
      { key: 'panel_interior', label: 'Panel', hint: 'Breaker layout and labels' },
      { key: 'context', label: 'Context', hint: 'Room-level view of the issue' },
    ],
  },
  circuits_outlets: {
    jobTypeCode: 'circuits_outlets',
    label: 'Circuits / Outlets',
    shots: [
      { key: 'locations', label: 'Locations', hint: 'Each spot getting a device' },
      { key: 'panel_interior', label: 'Panel', hint: 'Breaker spaces available' },
      { key: 'route', label: 'Route', hint: 'Attic / crawl / wall path if known' },
    ],
  },
  fixtures_fans: {
    jobTypeCode: 'fixtures_fans',
    label: 'Fixtures / Fans',
    shots: [
      { key: 'existing', label: 'Existing fixture', hint: 'What is there today' },
      { key: 'ceiling', label: 'Ceiling / box', hint: 'Mounting point, height' },
      { key: 'switch', label: 'Switch location', hint: 'Existing controls' },
    ],
  },
  remodel: {
    jobTypeCode: 'remodel',
    label: 'Remodel',
    shots: [
      { key: 'rooms', label: 'Each room', hint: 'Wide shots of the space' },
      { key: 'walls_open', label: 'Open walls', hint: 'If drywall is off' },
      { key: 'panel_interior', label: 'Panel', hint: 'Capacity for new circuits' },
    ],
  },
  generator: {
    jobTypeCode: 'generator',
    label: 'Generator',
    shots: [
      { key: 'panel_interior', label: 'Panel', hint: 'Interior + main breaker' },
      { key: 'inlet_location', label: 'Inlet location', hint: 'Where the inlet mounts' },
      { key: 'generator', label: 'Generator', hint: 'Nameplate if on site' },
    ],
  },
  other: {
    jobTypeCode: 'other',
    label: 'Other',
    shots: [
      { key: 'overview', label: 'Overview', hint: 'The work area' },
      { key: 'detail', label: 'Details', hint: 'Close-ups of anything relevant' },
      { key: 'panel_interior', label: 'Panel', hint: 'Always worth capturing' },
    ],
  },
};
