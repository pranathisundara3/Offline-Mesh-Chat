/**
 * @format
 */

import { AppRegistry } from 'react-native';
import { enableScreens } from 'react-native-screens';
import { name as appName } from './app.json';

// Must be called before any NavigationContainer renders.
// Without this, react-native-screens' native components are uninitialised
// and the JS bundle crashes on first render (shows "Reloading…" loop).
enableScreens();

// Require App dynamically to avoid Babel hoisting the import before enableScreens()
const App = require('./App').default;

AppRegistry.registerComponent(appName, () => App);
