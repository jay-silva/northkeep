/**
 * On-device LLM seam (M6-4, ADR 0020). See types.ts for the contract and the
 * device-unverified caveat.
 */
export type {
  LocalBackend,
  LocalChatMessage,
  LocalGenerateOptions,
  LocalJsonSchema,
  LocalModel,
} from './types.js';
export { ENTITY_JSON_SCHEMA } from './types.js';
export { AppleFMModel } from './apple-fm.js';
export { LlamaRnModel, type LlamaRnModelConfig } from './llama-rn.js';
export { detectLocalModel, type DetectOptions, type LocalModelResolution } from './detect.js';
export {
  createLocalNerClient,
  type LocalNerClient,
  type LocalNerHooks,
  type LocalPullProgress,
} from './ner-adapter.js';
export {
  MIN_PASS_BUDGET_MS,
  NER_PASSES,
  NER_PROMPT_TEXT_MARKER,
  NerPassTimeoutError,
  extractNerText,
  mergeEntities,
  parseEntityReply,
  runPerKindNer,
  salvageEntityJson,
  type NerEntity,
  type NerEntityKind,
  type NerPass,
  type NerPassEvent,
} from './per-kind-ner.js';
