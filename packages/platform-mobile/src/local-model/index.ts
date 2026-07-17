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
export { createLocalNerClient, type LocalNerClient, type LocalPullProgress } from './ner-adapter.js';
