export const MEMORY_CATEGORIES = [
  "identity",
  "personal",
  "preference",
  "contact",
  "work",
  "routine",
  "project",
  "social",
  "custom",
] as const;

export type MemoryCategory = (typeof MEMORY_CATEGORIES)[number];

export const MEMORY_STATUSES = ["approved", "pending", "rejected"] as const;
export type MemoryStatus = (typeof MEMORY_STATUSES)[number];

export const MEMORY_SOURCES = ["manual", "ai", "import"] as const;
export type MemorySource = (typeof MEMORY_SOURCES)[number];

export interface EmergencyContact {
  id: string;
  name: string;
  relation: string;
  phone: string;
}

export interface SocialLink {
  id: string;
  label: string;
  url: string;
}

export interface PreferenceItem {
  id: string;
  key: string;
  value: string;
}

export interface OwnerProfile {
  id: string;
  name: string;
  nickname: string;
  email: string;
  occupation: string;
  skills: string[];
  interests: string[];
  goals: string[];
  dailyRoutine: string;
  preferences: PreferenceItem[];
  location: string;
  timezone: string;
  birthday: string;
  emergencyContacts: EmergencyContact[];
  socialLinks: SocialLink[];
  customNotes: string;
  createdAt: number;
  updatedAt: number;
}

export interface MemoryEntry {
  id: string;
  content: string;
  category: MemoryCategory;
  status: MemoryStatus;
  source: MemorySource;
  confidence: number | null;
  note: string;
  createdAt: number;
  updatedAt: number;
  reviewedAt: number | null;
}

export interface MemoryPrivacy {
  enabled: boolean;
  contextInjection: boolean;
  autoLearn: boolean;
}

export interface MemorySnapshot {
  profile: OwnerProfile;
  entries: MemoryEntry[];
  privacy: MemoryPrivacy;
}

export type ProfileInput = Partial<
  Omit<OwnerProfile, "id" | "createdAt" | "updatedAt">
>;

export interface MemoryEntryInput {
  content: string;
  category?: MemoryCategory;
  note?: string;
  confidence?: number;
}

export interface MemoryEntryPatch {
  content?: string;
  category?: MemoryCategory;
  note?: string;
}

export interface MemoryFilter {
  status?: MemoryStatus | "all";
  category?: MemoryCategory | "all";
  search?: string;
  limit?: number;
}

export interface LearnedFact {
  content: string;
  category?: MemoryCategory;
  confidence?: number;
  note?: string;
}
