import { colors } from '@fieldquote/ui';
import { Tabs } from 'expo-router';
import { Text, type ColorValue } from 'react-native';

function TabIcon({ glyph, color }: { glyph: string; color: ColorValue }) {
  // Placeholder glyph icons; real icon set arrives with the design pass (Phase 4).
  return <Text style={{ fontSize: 20, color }}>{glyph}</Text>;
}

export default function TabsLayout() {
  return (
    <Tabs
      screenOptions={{
        tabBarActiveTintColor: colors.primary,
        tabBarInactiveTintColor: colors.textMuted,
        headerTitleStyle: { color: colors.text },
      }}
    >
      <Tabs.Screen
        name="jobs"
        options={{
          title: 'Jobs',
          tabBarIcon: ({ color }) => <TabIcon glyph="🗂" color={color} />,
        }}
      />
      <Tabs.Screen
        name="capture"
        options={{
          title: 'Capture',
          tabBarIcon: ({ color }) => <TabIcon glyph="📷" color={color} />,
        }}
      />
      <Tabs.Screen
        name="money"
        options={{
          title: 'Money',
          tabBarIcon: ({ color }) => <TabIcon glyph="💵" color={color} />,
        }}
      />
      <Tabs.Screen
        name="settings"
        options={{
          title: 'Settings',
          tabBarIcon: ({ color }) => <TabIcon glyph="⚙️" color={color} />,
        }}
      />
    </Tabs>
  );
}
