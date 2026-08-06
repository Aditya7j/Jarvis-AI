/**
 * Chat service — the orchestration facade of JARVIS.
 */

export {
  runPipeline,
  runPipelineText,
} from "./pipeline";
export type {
  PipelineEvent,
  PipelineModel,
  PipelineOptions,
} from "./pipeline";
export {
  hallucinationMonitor,
  isHallucination,
} from "./hallucination";
export type {
  HallucinationInstance,
  HallucinationRecord,
  HallucinationReport,
  ResponseSource,
  ToolTrace,
} from "./hallucination";
