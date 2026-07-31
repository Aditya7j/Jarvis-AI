import type {
  ProviderName,
  ProviderStatusDetail,
  ProviderStatusType,
} from "../types";

interface ProviderHealthOptions {
  provider: ProviderName;
  configured: boolean;
  model: string | null;
  vision: boolean;
  ping: () => Promise<void>;
  failureStatus?: ProviderStatusType;
  messageFor?: (error: unknown) => string;
}

export async function checkProviderHealth(
  options: ProviderHealthOptions
): Promise<ProviderStatusDetail> {
  const startedAt = Date.now();
  if (!options.configured) {
    return {
      provider: options.provider,
      status: "not_configured",
      configured: false,
      model: null,
      error: null,
      latencyMs: null,
      vision: options.vision,
    };
  }
  try {
    await options.ping();
    return {
      provider: options.provider,
      status: "connected",
      configured: true,
      model: options.model,
      error: null,
      latencyMs: Date.now() - startedAt,
      vision: options.vision,
    };
  } catch (error) {
    return {
      provider: options.provider,
      status: options.failureStatus ?? "error",
      configured: true,
      model: options.model,
      error: options.messageFor
        ? options.messageFor(error)
        : error instanceof Error
          ? error.message
          : String(error),
      latencyMs: Date.now() - startedAt,
      vision: options.vision,
    };
  }
}
