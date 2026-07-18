import { Redirect } from 'expo-router';

/** Entry route: land on sign-in; the root gate re-routes signed-in users. */
export default function Index() {
  return <Redirect href="/(auth)/sign-in" />;
}
