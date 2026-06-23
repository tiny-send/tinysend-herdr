// Action: mute/unmute notifications. `node toggle.mjs [on|off]`, or no arg to flip.
import { loadDotEnv, modeEnabled, setMode } from './lib.mjs';

loadDotEnv();

const arg = process.argv[2]?.trim().toLowerCase();
const enabled = arg === 'on' || arg === 'enable' || arg === 'enabled' ? true
  : arg === 'off' || arg === 'disable' || arg === 'disabled' ? false
  : !modeEnabled();

setMode(enabled);
console.log(`tinysend notifications ${enabled ? 'enabled' : 'disabled'}.`);
