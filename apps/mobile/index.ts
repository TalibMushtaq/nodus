import { registerRootComponent } from 'expo';

// Define the background queue-drain task before the app mounts; the OS may run
// this entry point headlessly, and the task must exist in that context.
import './src/background/sync';

import App from './App';

// registerRootComponent calls AppRegistry.registerComponent('main', () => App);
// It also ensures that whether you load the app in Expo Go or in a native build,
// the environment is set up appropriately
registerRootComponent(App);
