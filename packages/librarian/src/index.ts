export {
  EXTRACT_MODEL,
  EMBED_MODEL,
  REVIEW_MODEL_PREFERRED,
  REVIEW_MODEL_FALLBACK,
  createOllamaClient,
  createOllamaEmbedder,
  hasOllamaModel,
  ollamaState,
  ollamaUrl,
  parseOllamaProgressLine,
  resolveReviewModel,
  type OllamaClient,
  type PullProgress,
} from './ollama.js';
export {
  extractFromConversation,
  heuristicExtract,
  sanitizeCandidates,
  type ExtractionResult,
} from './extract.js';
export { dedupeCandidates, jaccard, tokenize, type DedupeResult } from './dedupe.js';
export { runImport, type ImportRunOptions, type ImportRunResult } from './import.js';
export {
  runReviewPass,
  selectReviewEntries,
  type ReviewPassOptions,
  type ReviewPassResult,
} from './review.js';
export {
  extractRawProposals,
  parseReviewResponse,
  validateProposals,
  REVIEW_KINDS,
  type MemberDecision,
  type ProposalStatus,
  type ReviewKind,
  type ReviewProposal,
  type ReviewQuote,
  type ValidateResult,
} from './reviewSchema.js';
export {
  REVIEW_REPORT_SCHEMA,
  assembleReviewReport,
  assertReportVault,
  findProposal,
  loadReviewReport,
  proposalFingerprint,
  operationFingerprint,
  reviewReportPath,
  saveReviewReport,
  type ReviewReport,
} from './reviewReport.js';
export {
  applyReviewAction,
  recordReviewDecision,
  reconcileReviewOperations,
  restoreReviewOperation,
  type RestoreRequest,
  type ReviewActionRequest,
} from './reviewSession.js';
export {
  acceptProposal,
  forgetDuplicateMember,
  keepDuplicateMember,
  rejectProposal,
  rejectRemaining,
} from './reviewApply.js';
export {
  selectConsolidationEntries,
  suggestConsolidations,
  type ConsolidationGroup,
  type ConsolidationOptions,
  type ConsolidationSuggestionResult,
} from './consolidation.js';
