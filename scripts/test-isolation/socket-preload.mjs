/** Apply the test-only OS namespace before a spawned Node CLI/tool imports it. */
import { installSocketNamespace } from './socket-namespace.mjs';
installSocketNamespace();
