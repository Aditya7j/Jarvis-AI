export { AIProviderService, aiService, PROVIDER_PRIORITY } from "./provider";
export { AIError, toAIError, toErrorPayload } from "./errors";
export { loadEnvConfig } from "./config";
export { aiLogger } from "./logger";
export { APP_VERSION } from "./version";
export {
  getRuntimeKey,
  setRuntimeKey,
  clearRuntimeKey,
} from "./registry";
export {
  roleModelName,
  describeRoles,
  pickLocalVisionModel,
  isVisionModel,
  isReasoningModel,
  VISION_KEYWORDS,
} from "./router";
export {
  JARVIS_TOOLS,
  executeTool,
  registerTool,
  hasTool,
} from "./tools";
export type { ToolExecutor } from "./tools";
export {
  classifyToolIntent,
  toolLabelFor,
  buildVerifiedFactContext,
  detectOcr,
  detectSystemClock,
  detectGeolocation,
  detectWeather,
  detectBattery,
  GEOLOCATION_DENIED_REPLY,
  BATTERY_DENIED_REPLY,
  WEATHER_NO_LOCATION_REPLY,
  WEATHER_FAILED_REPLY,
} from "./intent-router";
export type { ToolIntent } from "./intent-router";
export {
  getSystemClock,
  getWeather,
} from "./system-tools";
export type {
  SystemClockFact,
  GeolocationFact,
  BatteryFact,
  WeatherFact,
  GeolocationResult,
  BatteryResult,
  ToolDenied,
} from "./system-tools";
export type {
  ModelRole,
  RouterCapabilities,
  RouterModelInfo,
  RouterSttInfo,
  RouterTtsInfo,
} from "./router";
export type { EnvConfig } from "./config";
export type {
  AIMessageInput,
  ChatRole,
  GenerateTextOptions,
  HealthSummary,
  ProviderName,
  ProviderStatusDetail,
  ProviderStatusType,
  ToolCall,
  ToolCallInvocation,
  ToolCallResponse,
  VisionRequest,
} from "./types";
