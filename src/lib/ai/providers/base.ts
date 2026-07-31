import { aiLogger, type Logger } from "../logger";
import type {
  GenerateTextOptions,
  ProviderName,
  ProviderStatusDetail,
  VisionChatRequest,
  VisionRequest,
} from "../types";
import type { AIProvider } from "./types";

export interface ProviderConfig {
  apiKey: string | null;
  model: string;
  timeoutMs: number;
  healthTimeoutMs: number;
}

export abstract class BaseProvider<TClient> implements AIProvider {
  abstract readonly name: ProviderName;

  protected readonly modelName: string;
  protected readonly timeoutMs: number;
  protected readonly healthTimeoutMs: number;
  protected readonly client: TClient | null;
  protected readonly log: Logger;

  constructor(config: ProviderConfig, client: TClient | null, scope: string) {
    this.modelName = config.model;
    this.timeoutMs = config.timeoutMs;
    this.healthTimeoutMs = config.healthTimeoutMs;
    this.client = client;
    this.log = aiLogger.child(scope);
  }

  isConfigured(): boolean {
    return this.client !== null;
  }

  getModel(): string | null {
    return this.client ? this.modelName : null;
  }

  supportsVision(): boolean {
    return this.isConfigured();
  }

  abstract generateText(options: GenerateTextOptions): Promise<string>;
  abstract streamText(options: GenerateTextOptions): AsyncGenerator<string, void, void>;
  abstract generateVision(request: VisionRequest): Promise<string>;
  abstract generateVisionChat(request: VisionChatRequest): Promise<string>;
  abstract streamVisionChat(
    request: VisionChatRequest
  ): AsyncGenerator<string, void, void>;
  abstract healthCheck(): Promise<ProviderStatusDetail>;
  abstract listModels(): Promise<string[]>;
}
