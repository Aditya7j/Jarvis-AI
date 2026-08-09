import { withAuthHeaders } from "@/lib/api/auth";

export function isSpeechRecognitionSupported(): boolean {
  if (typeof window === "undefined") return false;
  const w = window as unknown as {
    SpeechRecognition?: unknown;
    webkitSpeechRecognition?: unknown;
  };
  return Boolean(w.SpeechRecognition || w.webkitSpeechRecognition);
}

export async function transcribeViaServer(
  blob: Blob,
  mimeType: string = blob.type || "audio/webm"
): Promise<string> {
  const res = await fetch("/api/stt/transcribe", withAuthHeaders({
    method: "POST",
    headers: { "Content-Type": mimeType },
    body: blob,
  }));
  const body = (await res.json().catch(() => null)) as {
    transcript?: string;
    engine?: string;
    error?: { code?: string; message?: string };
  } | null;

  if (!res.ok || !body) {
    throw new Error(
      body?.error?.message ??
        `Speech-to-text failed (${res.status}). Install Whisper locally or use Chrome/Edge for built-in voice input.`
    );
  }
  return body.transcript ?? "";
}
