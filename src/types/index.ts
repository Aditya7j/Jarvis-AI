export type AIState = "idle" | "listening" | "thinking" | "speaking";

export type AIMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  timestamp: number;
};

export type Conversation = {
  id: string;
  title: string;
  messages: AIMessage[];
  createdAt: number;
  updatedAt: number;
};

export type VisionMode = "webcam" | "screen" | "image";

export type TaskStatus = "pending" | "in_progress" | "completed" | "failed";

export type Task = {
  id: string;
  title: string;
  description?: string;
  status: TaskStatus;
  createdAt: number;
  completedAt?: number;
};

export type Project = {
  id: string;
  name: string;
  description?: string;
  tasks: Task[];
  createdAt: number;
};

export type PluginConfig = {
  id: string;
  name: string;
  enabled: boolean;
  config: Record<string, unknown>;
};

export type AppSettings = {
  theme: "dark";
  wakeWord: string;
  voice: {
    provider: "elevenlabs" | "openai";
    voiceId: string;
    speed: number;
  };
  vision: {
    autoScreenCapture: boolean;
    webcamEnabled: boolean;
  };
  memory: {
    enabled: boolean;
    retentionDays: number;
  };
  plugins: PluginConfig[];
};
