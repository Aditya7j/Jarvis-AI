import { create } from "zustand";

type AIState = "idle" | "listening" | "thinking" | "speaking";

export type MicErrorCode =
  | "unsupported"
  | "permission-denied"
  | "device-unavailable"
  | "recognition-error"
  | "transcription-failed";

interface MicError {
  code: MicErrorCode;
  message: string;
}

interface VoiceStore {
  state: AIState;
  isMicActive: boolean;
  audioLevel: number;
  transcript: string;
  interimTranscript: string;
  recordingMs: number;
  micError: MicError | null;
  continuousMode: boolean;
  setState: (state: AIState) => void;
  setMicActive: (active: boolean) => void;
  setAudioLevel: (level: number) => void;
  setTranscript: (text: string) => void;
  setInterimTranscript: (text: string) => void;
  setRecordingMs: (ms: number) => void;
  setMicError: (error: MicError | null) => void;
  clearMicError: () => void;
  setContinuousMode: (enabled: boolean) => void;
  recognition: SpeechRecognition | null;
  setRecognition: (rec: SpeechRecognition | null) => void;
}

export const useVoiceStore = create<VoiceStore>((set) => ({
  state: "idle",
  isMicActive: false,
  audioLevel: 0,
  transcript: "",
  interimTranscript: "",
  recordingMs: 0,
  micError: null,
  continuousMode: false,
  recognition: null,
  setState: (state) => set({ state }),
  setMicActive: (active) => set({ isMicActive: active }),
  setAudioLevel: (level) => set({ audioLevel: level }),
  setTranscript: (text) => set({ transcript: text }),
  setInterimTranscript: (text) => set({ interimTranscript: text }),
  setRecordingMs: (recordingMs) => set({ recordingMs }),
  setMicError: (micError) => set({ micError }),
  clearMicError: () => set({ micError: null }),
  setContinuousMode: (continuousMode) => set({ continuousMode }),
  setRecognition: (rec) => set({ recognition: rec }),
}));
