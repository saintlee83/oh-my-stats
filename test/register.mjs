// Loaded with --import before the tests: Next's modules exist only inside vinext's build, so the
// tests get stand-ins that draw the same markup.
import { register } from 'node:module';

register('./resolve.mjs', import.meta.url);
