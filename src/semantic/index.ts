/**
 * Semantisk sökning för Fornsök MCP (SPEC 5.2, etapp 5).
 *
 * - `runEmbedBatch(env, { max })`: grundinbäddning och ombäddning i delar;
 *   körs från en schemalagd körning tills `klar` är true, och sedan dagligen
 *   efter nattsynken (tar då bara ändrade poster).
 * - `semanticSearch(env, fraga, filter, topK)` → `{ uuid, score }[]`.
 * - `scopeCovers(filter, scope)`: synkront; true om filtrets geografiska
 *   avgränsning ligger helt inom omfånget.
 * - `createSemanticSearch(env)`: `SemanticSearch` för `createDeps({ semantic })`.
 */
export { MODELL, DIMENSIONER, type AiLike, type SemanticEnv, type VectorizeLike } from "./bindings";
export { runEmbedBatch, embedStatus, type EmbedResult, AI_BATCH, STANDARD_MAX } from "./embed";
export { semanticSearch, scopeCovers, createSemanticSearch, MAX_TOPK } from "./search";
export { parseScope, scopeText, inScope, type Scope, DEFAULT_SEMANTIC_LAN } from "./scope";
export { inbaddningstext, rensa, STANDARDFRAS_RE } from "./text";
export { tillVectorizeFilter, varianter, kort64 } from "./filter";
export { hasGeoFilter } from "./coverage";
