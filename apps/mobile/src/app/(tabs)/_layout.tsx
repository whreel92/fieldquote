import { colors, typography } from '@fieldquote/ui';
import { Tabs } from 'expo-router';
import { Camera, ClipboardList, Settings, Wallet } from 'lucide-react-native';

export default function TabsLayout() {
  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarStyle: {
          backgroundColor: colors.ink,
          borderTopColor: colors.inkBorder,
          borderTopWidth: 1,
          height: 64,
          paddingTop: 6,
        },
        tabBarActiveTintColor: colors.primary,
        tabBarInactiveTintColor: colors.textMuted,
        tabBarLabelStyle: {
          fontFamily: typography.family.semibold,
          fontSize: typography.size.xs,
        },
      }}
    >
      <Tabs.Screen
        name="jobs"
        options={{
          title: 'Jobs',
          tabBarIcon: ({ color }) => <ClipboardList size={22} color={color} strokeWidth={2} />,
        }}
      />
      <Tabs.Screen
        name="capture"
        options={{
          title: 'Capture',
          tabBarIcon: ({ color }) => <Camera size={22} color={color} strokeWidth={2} />,
        }}
      />
      <Tabs.Screen
        name="money"
        options={{
          title: 'Money',
          tabBarIcon: ({ color }) => <Wallet size={22} color={color} strokeWidth={2} />,
        }}
      />
      <Tabs.Screen
        name="settings"
        options={{
          title: 'Settings',
          tabBarIcon: ({ color }) => <Settings size={22} color={color} strokeWidth={2} />,
        }}
      />
    </Tabs>
  );
}
