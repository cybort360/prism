import { auroraApiClient } from './auroraClient.js';

/**
 * Aurora-client registry. Production uses the live HTTP client; tests inject a mock via
 * `setAuroraClient`. All Aurora I/O in the backend goes through `auroraClient()`.
 */
let active = auroraApiClient;

export function auroraClient() { return active; }
export function setAuroraClient(client) { active = client; }
export function resetAuroraClient() { active = auroraApiClient; }

export { auroraApiClient };
