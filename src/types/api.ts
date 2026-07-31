import { z } from "zod";

export const MessageSchema = z.object({
  role: z.enum(["user", "assistant", "system"]),
  content: z.string(),
  timestamp: z.number().optional(),
});

export const ConversationRequestSchema = z.object({
  message: z.string(),
  conversationId: z.string().optional(),
  stream: z.boolean().default(true),
});

export const VisionAnalysisSchema = z.object({
  image: z.string(),
  prompt: z.string().optional(),
});

export const TaskExecutionSchema = z.object({
  task: z.string(),
  context: z.record(z.unknown()).optional(),
});

export const MemorySearchSchema = z.object({
  query: z.string(),
  limit: z.number().min(1).max(50).default(10),
});

export type ConversationRequest = z.infer<typeof ConversationRequestSchema>;
export type VisionAnalysis = z.infer<typeof VisionAnalysisSchema>;
export type TaskExecution = z.infer<typeof TaskExecutionSchema>;
export type MemorySearch = z.infer<typeof MemorySearchSchema>;
