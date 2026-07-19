import { colors, radii } from '@fieldquote/ui';
import { StyleSheet, View } from 'react-native';

/** Number of rolling meter samples the waveform keeps on screen (~6s @ 100ms). */
export const WAVEFORM_SAMPLE_COUNT = 60;

/** Anything quieter than this dBFS floor renders as a baseline tick. */
const METER_FLOOR_DB = -50;
const MIN_LEVEL = 0.06;

/** Map a dBFS metering value (≈ -160..0) onto a 0..1 bar level. */
export function meterToLevel(meteringDb: number): number {
  if (!Number.isFinite(meteringDb)) return MIN_LEVEL;
  const clamped = Math.max(METER_FLOOR_DB, Math.min(0, meteringDb));
  const level = (clamped - METER_FLOOR_DB) / -METER_FLOOR_DB;
  return Math.max(MIN_LEVEL, Math.min(1, level));
}

/**
 * Rolling meter-bar waveform — newest sample lands on the right edge.
 * Purely decorative; hidden from the accessibility tree (the clock readout
 * and state captions carry the information).
 */
export function Waveform({
  samples,
  active,
  height = 72,
}: {
  samples: number[];
  active: boolean;
  height?: number;
}) {
  const recent = samples.slice(-WAVEFORM_SAMPLE_COUNT);
  const padCount = WAVEFORM_SAMPLE_COUNT - recent.length;
  const levels = [...new Array<number>(padCount).fill(MIN_LEVEL), ...recent];
  return (
    <View
      style={[styles.track, { height }]}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      {levels.map((level, index) => {
        const filled = index >= padCount;
        return (
          <View
            key={index}
            style={[
              styles.bar,
              {
                height: Math.max(3, level * height),
                backgroundColor: filled
                  ? active
                    ? colors.primary
                    : colors.textMuted
                  : colors.border,
              },
            ]}
          />
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  track: {
    width: '100%',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
  },
  bar: {
    flex: 1,
    minWidth: 1,
    borderRadius: radii.full,
  },
});
