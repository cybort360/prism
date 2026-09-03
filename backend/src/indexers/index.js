import { envioGraphqlIndexer } from './envioIndexer.js';

/** Envio-indexer registry. Production uses the GraphQL indexer; tests inject a mock. */
let active = envioGraphqlIndexer;

export function envioIndexer() { return active; }
export function setEnvioIndexer(indexer) { active = indexer; }
export function resetEnvioIndexer() { active = envioGraphqlIndexer; }

export { envioGraphqlIndexer };
