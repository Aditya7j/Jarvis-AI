import type {
  MemoryEntry,
  MemoryEntryInput,
  MemoryEntryPatch,
  MemoryFilter,
  MemoryPrivacy,
  MemorySnapshot,
  OwnerProfile,
  ProfileInput,
} from "./types";

interface ErrorBody {
  error?: { message?: string; code?: string };
}

async function request<T>(
  path: string,
  init?: RequestInit
): Promise<T> {
  const response = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...init,
  });
  const payload = (await response.json().catch(() => null)) as
    | (T & ErrorBody)
    | null;
  if (!response.ok) {
    const message =
      payload?.error?.message ?? `Request failed with status ${response.status}`;
    throw new Error(message);
  }
  return payload as T;
}

export class MemoryClient {
  getSnapshot(): Promise<MemorySnapshot> {
    return request<MemorySnapshot>("/api/memory");
  }

  getProfile(): Promise<{ profile: OwnerProfile }> {
    return request<{ profile: OwnerProfile }>("/api/owner/profile");
  }

  updateProfile(input: ProfileInput): Promise<{ profile: OwnerProfile }> {
    return request<{ profile: OwnerProfile }>("/api/owner/profile", {
      method: "PUT",
      body: JSON.stringify(input),
    });
  }

  createEntry(input: MemoryEntryInput): Promise<{ entry: MemoryEntry }> {
    return request<{ entry: MemoryEntry }>("/api/memory", {
      method: "POST",
      body: JSON.stringify(input),
    });
  }

  updateEntry(
    id: string,
    patch: MemoryEntryPatch
  ): Promise<{ entry: MemoryEntry }> {
    return request<{ entry: MemoryEntry }>(`/api/memory/${id}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    });
  }

  approveEntry(id: string): Promise<{ entry: MemoryEntry }> {
    return request<{ entry: MemoryEntry }>(`/api/memory/${id}/approve`, {
      method: "POST",
      body: JSON.stringify({ approved: true }),
    });
  }

  rejectEntry(id: string): Promise<{ entry: MemoryEntry }> {
    return request<{ entry: MemoryEntry }>(`/api/memory/${id}/approve`, {
      method: "POST",
      body: JSON.stringify({ approved: false }),
    });
  }

  deleteEntry(id: string): Promise<{ ok: true }> {
    return request<{ ok: true }>(`/api/memory/${id}`, { method: "DELETE" });
  }

  clearAll(): Promise<{ ok: true }> {
    return request<{ ok: true }>("/api/memory/clear", { method: "POST" });
  }

  getPrivacy(): Promise<{ privacy: MemoryPrivacy }> {
    return request<{ privacy: MemoryPrivacy }>("/api/memory/privacy");
  }

  setPrivacy(
    patch: Partial<MemoryPrivacy>
  ): Promise<{ privacy: MemoryPrivacy }> {
    return request<{ privacy: MemoryPrivacy }>("/api/memory/privacy", {
      method: "PUT",
      body: JSON.stringify(patch),
    });
  }

  getContext(): Promise<{ enabled: boolean; context: string | null }> {
    return request<{ enabled: boolean; context: string | null }>(
      "/api/memory/context"
    );
  }
}

export type { MemoryFilter };

export const memoryClient = new MemoryClient();
