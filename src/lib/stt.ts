export function isSpeechRecognitionSupported(): boolean {
  if (typeof window === "undefined") return false;
  const w = window as unknown as {
    SpeechRecognition?: unknown;
    webkitSpeechRecognition?: unknown;
  };
  return Boolean(w.SpeechRecognition || w.webkitSpeechRecognition);
}

export async function transcribeViaDeepgram(
  blob: Blob,
  mimeType: string = blob.type || "audio/webm"
): Promise<string> {
  const res = await fetch("/api/stt/transcribe", {
    method: "POST",
    headers: { "Content-Type": mimeType },
    body: blob,
  });
  const body = (await res.json().catch(() => null)) as {
    transcript?: string;
    error?: { code?: string; message?: string };
  } | null;

  if (!res.ok || !body) {
    throw new Error(
      body?.error?.message ??
        `Speech-to-text failed (${res.status}). Enable DEEPGRAM_API_KEY in .env, or use Chrome/Edge for built-in voice input.`
    );
  }
  return body.transcript ?? "";
}
