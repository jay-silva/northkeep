export {
  classifyEndpoint,
  type ChatMessage,
  type ChatOptions,
  type ChatTurnResult,
  type ModelProvider,
  type PrivacyTier,
  type StopReason,
  type TierClassification,
  type ToolCallRequest,
  type ToolSpec,
} from './provider.js';
export {
  createOpenAICompatibleProvider,
  normalizeBaseUrl,
  type OpenAICompatibleConfig,
} from './openai.js';
export {
  createAnthropicProvider,
  DEFAULT_ANTHROPIC_MODEL,
  type AnthropicProviderConfig,
} from './anthropic.js';
export {
  createSession,
  recordDisclosedMemory,
  runTurn,
  TurnError,
  vaultAdapter,
  type ConverseSession,
  type ConverseVault,
  type TurnOptions,
  type TurnResult,
} from './turn.js';
export {
  runTask,
  type ApprovalAnswer,
  type ApprovalRequest,
  type TaskEvent,
  type TaskHooks,
  type TaskOptions,
  type TaskResult,
} from './task.js';
export { redactJsonLeaves, restoreJsonLeaves, transformJsonLeaves } from './jsonLeaves.js';
export {
  type ToolContext,
  type ToolDefinition,
  type ToolResult,
} from './tools/types.js';
export { placeholderGate, type PermissionGate, type PermissionRequest } from './tools/gate.js';
export {
  describeFlag,
  screenArguments,
  type ExfilClass,
  type ExfilFlag,
  type ExfilScreenInput,
} from './tools/exfil.js';
export {
  getMcpCatalogEntry,
  listMcpCatalog,
  type McpCatalogEntry,
  type ResolvedMcpCatalogEntry,
} from './tools/mcp/catalog.js';
export {
  collectMcpTools,
  type McpCollection,
  type McpUnavailable,
} from './tools/mcp/collect.js';
export {
  connectServer,
  sanitizeServerText,
  MAX_SCHEMA_CHARS,
  TOOL_NAME_RE,
  McpFingerprintChangedError,
  McpNotConnectedError,
  McpOriginChangedError,
  McpPinChangedError,
  type McpConnection,
  type McpClientLike,
} from './tools/mcp/client.js';
export {
  addRemoteServer,
  addServer,
  getServer,
  isHttpServer,
  isStdioServer,
  loadMcpConfig,
  mcpConfigPath,
  endpointOrigin,
  remoteUrlRefusal,
  removeServer,
  riskOf,
  setSafeRead,
  setToolsPin,
  type McpConfig,
  type McpHttpServer,
  type McpServerConfig,
  type McpStdioServer,
  type McpTransport,
  type McpTrust,
} from './tools/mcp/config.js';
export {
  awaitOAuthCallback,
  KeychainOAuthProvider,
  openInBrowser,
  OAuthNotAvailableError,
  OAUTH_CALLBACK_PORT,
  OAUTH_REDIRECT_URI,
  requireTokenStore,
} from './tools/mcp/oauth.js';
export {
  McpServerNotAuthenticatedError,
  probeRequiresAuth,
  startRemoteConnect,
  type PendingConnect,
  type RemoteConnectOptions,
} from './tools/mcp/connect-remote.js';
export {
  credentialsOriginMatches,
  deleteCredentials,
  hasRemoteTokens,
  loadCredentials,
  saveCredentials,
  setTokenBackend,
  tokenStoreAvailable,
  updateCredentials,
  type RemoteCredentials,
  type TokenBackend,
} from './tools/mcp/tokens.js';
export {
  allowedGuiRoots,
  isUnderAllowedRoot,
  fingerprintLaunch,
  isValidServerId,
  namespacedName,
  pinTools,
  splitNamespaced,
} from './tools/mcp/identity.js';
export {
  addGrant,
  clearGrants,
  createPermissionEngine,
  listGrants,
  loadPermissions,
  permissionsPath,
  removeGrant,
  type GrantScope,
  type GrantSubject,
  grantSubject,
  hostSubject,
  serverSubject,
  subjectLabel,
  type PermissionEngine,
  type PermissionGrant,
  type PermissionsConfig,
} from './tools/policy.js';
export {
  classifyFetchTarget,
  FetchRefusedError,
  hardenedFetch,
  type AuthToken,
  type FetchRefusalCode,
  type HardenedFetchOptions,
  type HardenedFetchResult,
  type NetTestOverrides,
} from './tools/net.js';
export { extractText } from './tools/extract-text.js';
export { createWebFetchTool, type WebFetchConfig } from './tools/webFetch.js';
export {
  BRAVE_HOST,
  buildBraveUrl,
  createWebSearchTool,
  type WebSearchConfig,
} from './tools/webSearch.js';
export { newFenceNonce, untrustedSystemLine, wrapUntrusted } from './tools/untrusted.js';
export {
  BRAVE_KEY_ID,
  enabledTools,
  getBraveKey,
  KNOWN_TOOL_NAMES,
  loadToolsConfig,
  saveToolsConfig,
  setToolEnabled,
  toolsConfigPath,
  webSearchNeedsKey,
  type ToolsConfig,
} from './tools/registry.js';
export {
  budgetPath,
  daySpend,
  DEFAULT_TOOL_BUDGET,
  getToolBudget,
  listBudgetedTools,
  loadBudget,
  recordSpend,
  reserveDailySpend,
  setToolBudget,
  withinDailyCap,
  type BudgetConfig,
  type ToolBudget,
} from './tools/budget.js';
export {
  BASELINE_CATALOG,
  catalogPath,
  compareTurnCost,
  costLabel,
  estimateTokensFromChars,
  estimateTurnCost,
  loadCatalog,
  lookupModel,
  type CatalogEntry,
  type CostTier,
  type TokenUsage,
} from './catalog.js';
export {
  getProvider,
  KNOWN_PROVIDERS,
  type ProviderInfo,
  type ProviderModel,
} from './provider-catalog.js';
export {
  detectHardware,
  recommendLocalModel,
  type HardwareProfile,
} from './hardware.js';
export {
  classifyTask,
  isRoutingRule,
  loadRoutingPolicy,
  route,
  RouteError,
  routingPath,
  saveRoutingPolicy,
  suggestBetterModel,
  type PrivacyCeiling,
  type RouteDecision,
  type RoutePolicy,
  type RoutingRule,
  type TaskKind,
} from './route.js';
export {
  addEndpoint,
  EndpointExistsError,
  getDefaultEndpoint,
  getEndpoint,
  getEndpointKey,
  deleteEndpointKey,
  setEndpointKey,
  listEndpoints,
  providersPath,
  removeEndpoint,
  setDefaultEndpoint,
  type AddEndpointInput,
  type EndpointConfig,
} from './settings.js';
