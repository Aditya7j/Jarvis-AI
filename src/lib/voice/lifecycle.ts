export type VoiceEventName =
  | "VOICE_SESSION_START"
  | "MIC_STARTED"
  | "MIC_STOPPED"
  | "STT_STARTED"
  | "STT_FINISHED"
  | "TTS_STARTED"
  | "TTS_FINISHED"
  | "VOICE_PAUSED"
  | "VOICE_RESUMED"
  | "RECONNECTING"
  | "RECORDING_RESTARTED"
  | "ERROR";

export interface VoiceEvent {
  name: VoiceEventName;
  timestamp: string;
  detail?: string;
}

export type VoiceEventListener = (event: VoiceEvent) => void;

export interface RecognitionResultEventLike {
  resultIndex: number;
  results: ArrayLike<{
    isFinal: boolean;
    0: { transcript: string };
  }>;
}

export interface RecognitionLike {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  start: () => void;
  stop: () => void;
  abort: () => void;
  onstart: (() => void) | null;
  onresult: ((event: RecognitionResultEventLike) => void) | null;
  onend: (() => void) | null;
  onerror: ((event: { error: string }) => void) | null;
}

const RESTART_DELAY_MS = 300;
const RESTART_AFTER_CLOSE_MS = 150;
const START_TIMEOUT_MS = 3_000;
const STALE_SESSION_TIMEOUT_MS = 15_000;
const WATCHDOG_TICK_MS = 2_000;
const FORCE_RESET_GRACE_MS = 500;

export function logVoiceEvent(name: VoiceEventName, detail?: string): void {
  const timestamp = new Date().toISOString();
  console.info(
    `[${timestamp}] ${name}${detail !== undefined ? ` ${detail}` : ""}`
  );
}

export interface VoiceSessionControllerOptions {
  createRecognition: () => RecognitionLike | null;
  onFinal: (transcript: string) => void;
  onInterim: (transcript: string) => void;
  onError: (code: string) => void;
}

/**
 * Owns the single SpeechRecognition session for the voice pipeline.
 *
 * Responsibilities:
 * - Enforces exactly one live recognition session at a time (stale sessions
 *   are force-reset before a replacement is created).
 * - Pauses STT while the assistant speaks (`pause`) and resumes it afterwards
 *   (`resume`), which is what keeps the microphone from hearing its own voice.
 * - Auto-reconnects: any `onend` or failed `start()` schedules a fresh session.
 * - Watchdogs: recovers from sessions that silently die (no `onend`/`onerror`
 *   ever fires) so the mic can never freeze while the UI looks active.
 */
export class VoiceSessionController {
  private readonly options: VoiceSessionControllerOptions;
  private readonly listeners = new Set<VoiceEventListener>();

  private activeSession: RecognitionLike | null = null;
  private recognitionActive = false;
  private startedFired = false;
  private running = false;
  private paused = false;
  private lastActivityAt = 0;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private startTimer: ReturnType<typeof setTimeout> | null = null;
  private watchdogTimer: ReturnType<typeof setInterval> | null = null;

  constructor(options: VoiceSessionControllerOptions) {
    this.options = options;
  }

  get isRunning(): boolean {
    return this.running;
  }

  get isPaused(): boolean {
    return this.paused;
  }

  get isRecognizing(): boolean {
    return this.recognitionActive;
  }

  get hasActiveSession(): boolean {
    return this.activeSession !== null;
  }

  subscribe(listener: VoiceEventListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  start(): void {
    if (!this.running) {
      this.running = true;
    }
    this.ensureWatchdog();

    if (this.activeSession) {
      if (!this.recognitionActive && !this.startedFired) {
        this.scheduleRestart(
          "awaiting previous session close",
          RESTART_AFTER_CLOSE_MS
        );
      }
      return;
    }

    const recognition = this.options.createRecognition();
    if (!recognition) {
      this.emit("ERROR", "recognition unsupported");
      this.options.onError("unsupported");
      return;
    }

    this.activeSession = recognition;
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = "en-US";
    this.emit("VOICE_SESSION_START");

    recognition.onstart = () => {
      this.startedFired = true;
      this.recognitionActive = true;
      this.touch();
      this.emit("MIC_STARTED");
    };

    recognition.onresult = (event) => {
      this.touch();
      if (this.paused) {
        return;
      }
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        const transcript = result[0].transcript;
        if (result.isFinal) {
          this.emit("STT_FINISHED", transcript);
          this.options.onFinal(transcript);
        } else {
          this.options.onInterim(transcript);
        }
      }
    };

    recognition.onend = () => {
      this.recognitionActive = false;
      this.startedFired = false;
      if (this.activeSession === recognition) {
        this.activeSession = null;
      }
      this.emit("MIC_STOPPED");
      if (!this.running) return;
      if (this.paused) {
        return;
      }
      this.scheduleRestart("session ended", RESTART_DELAY_MS);
    };

    recognition.onerror = (event) => {
      this.touch();
      if (event.error === "aborted") return;
      this.emit("ERROR", event.error);
      this.options.onError(event.error);
    };

    try {
      recognition.start();
      this.emit("STT_STARTED");
      this.recognitionActive = true;
      this.startedFired = false;
      this.touch();
      this.clearStartTimer();
      this.startTimer = setTimeout(() => {
        this.startTimer = null;
        if (
          this.activeSession === recognition &&
          !this.startedFired &&
          !this.paused
        ) {
          this.forceReset("onstart did not fire within timeout");
        }
      }, START_TIMEOUT_MS);
    } catch {
      if (this.activeSession === recognition) {
        this.activeSession = null;
      }
      this.recognitionActive = false;
      this.emit("ERROR", "start failed");
      this.options.onError("start-failed");
      if (this.running) {
        this.scheduleRestart("start failed", RESTART_DELAY_MS);
      }
    }
  }

  pause(reason: string): void {
    if (this.paused) return;
    this.paused = true;
    this.emit("VOICE_PAUSED", reason);
    const session = this.activeSession;
    if (session && this.recognitionActive) {
      try {
        session.stop();
      } catch {
        // onend may still fire; the paused flag prevents any restart.
      }
    }
  }

  resume(): void {
    const wasPaused = this.paused;
    this.paused = false;
    if (wasPaused) {
      this.emit("VOICE_RESUMED");
    }
    this.start();
  }

  forceReset(reason: string): void {
    this.emit("RECORDING_RESTARTED", reason);
    this.recognitionActive = false;
    this.startedFired = false;
    const session = this.activeSession;
    if (session) {
      try {
        session.abort();
      } catch {
        // ignore
      }
      try {
        session.stop();
      } catch {
        // ignore
      }
    }
    if (!this.running || this.paused) return;
    setTimeout(() => {
      if (this.activeSession === session) {
        this.activeSession = null;
        if (this.running && !this.paused) {
          this.scheduleRestart(reason, RESTART_DELAY_MS);
        }
      }
    }, FORCE_RESET_GRACE_MS);
  }

  dispose(): void {
    this.running = false;
    this.paused = false;
    this.clearRestartTimer();
    this.clearStartTimer();
    if (this.watchdogTimer !== null) {
      clearInterval(this.watchdogTimer);
      this.watchdogTimer = null;
    }
    const session = this.activeSession;
    this.activeSession = null;
    this.recognitionActive = false;
    this.startedFired = false;
    if (session) {
      try {
        session.abort();
      } catch {
        // ignore
      }
    }
  }

  private touch(): void {
    this.lastActivityAt = Date.now();
  }

  private ensureWatchdog(): void {
    if (this.watchdogTimer !== null) return;
    this.watchdogTimer = setInterval(() => {
      if (!this.running || this.paused) return;
      if (!this.recognitionActive) return;
      if (Date.now() - this.lastActivityAt > STALE_SESSION_TIMEOUT_MS) {
        this.forceReset("no recognition activity for too long");
      }
    }, WATCHDOG_TICK_MS);
  }

  private scheduleRestart(reason: string, delay: number): void {
    this.emit("RECONNECTING", reason);
    this.clearRestartTimer();
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      this.start();
    }, delay);
  }

  private clearRestartTimer(): void {
    if (this.restartTimer !== null) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
  }

  private clearStartTimer(): void {
    if (this.startTimer !== null) {
      clearTimeout(this.startTimer);
      this.startTimer = null;
    }
  }

  private emit(name: VoiceEventName, detail?: string): void {
    const event: VoiceEvent = {
      name,
      timestamp: new Date().toISOString(),
      detail,
    };
    logVoiceEvent(name, detail);
    this.listeners.forEach((listener) => listener(event));
  }
}
