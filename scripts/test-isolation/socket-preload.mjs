import { URL } from 'node:url';
/** Install the exact runtime boundary before a child loads any product modules. */
import { installSocketNamespace } from './socket-namespace.mjs';
const scope = new URL(import.meta.url).searchParams.get('scope');
installSocketNamespace(scope ? JSON.parse(scope) : undefined);
