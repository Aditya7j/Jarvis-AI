import type {
  GenerateTextOptions,
  ProviderName,
  ProviderStatusDetail,
  VisionChatRequest,
  VisionRequest,
} from "../types";

export interface AIProvider {
  readonly name: ProviderName;

  isConfigured(): boolean;

  getModel(): string | null;

  supportsVision(): boolean;

  generateText(options: GenerateTextOptions): Promise<string>;

  streamText(options: GenerateTextOptions): AsyncGenerator<string, void, void>;

  generateVision(request: VisionRequest): Promise<string>;

  generateVisionChat?(request: VisionChatRequest): Promise<string>;

  streamVisionChat?(request: VisionChatRequest): AsyncGenerator<string, void, void>;

  healthCheck(): Promise<ProviderStatusDetail>;

  listModels(): Promise<string[]>;
}
