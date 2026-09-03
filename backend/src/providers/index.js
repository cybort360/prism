import { alchemyProvider } from './alchemyProvider.js';

/**
 * Chain-provider registry. Production uses the Alchemy-backed provider; tests inject a mock via
 * `setChainProvider`. All chain I/O in the backend goes through `chainProvider()`.
 */
let active = alchemyProvider;

export function chainProvider() { return active; }
export function setChainProvider(provider) { active = provider; }
export function resetChainProvider() { active = alchemyProvider; }

export { alchemyProvider };
