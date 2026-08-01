import { randomUUID } from "crypto";
import { MEMORY_CATEGORIES, type MemoryCategory } from "./types";

const MAX_TEXT = 2000;
const MAX_ENTRY_CONTENT = 2000;
const MAX_NOTE = 1000;
const MAX_LIST_ITEMS = 50;
const MAX_ARRAY_ITEM = 200;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const BIRTHDAY_RE = /^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?$/;

export function isMemoryCategory(value: unknown): value is MemoryCategory {
  return (
    typeof value === "string" &&
    (MEMORY_CATEGORIES as readonly string[]).includes(value)
  );
}

function cleanString(value: unknown, max: number): string {
  if (typeof value !== "string") return "";
  return value.trim().slice(0, max);
}

function cleanStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const cleaned: string[] = [];
  for (const item of value) {
    if (cleaned.length >= MAX_LIST_ITEMS) break;
    if (typeof item !== "string") continue;
    const trimmed = item.trim().slice(0, MAX_ARRAY_ITEM);
    if (trimmed && !cleaned.includes(trimmed)) cleaned.push(trimmed);
  }
  return cleaned;
}

function cleanList<T>(
  value: unknown,
  cleanItem: (item: unknown, index: number) => T | null
): T[] {
  if (!Array.isArray(value)) return [];
  const cleaned: T[] = [];
  for (let index = 0; index < value.length; index++) {
    if (cleaned.length >= MAX_LIST_ITEMS) break;
    const item = cleanItem(value[index], index);
    if (item !== null) cleaned.push(item);
  }
  return cleaned;
}

function cleanBirthday(value: unknown): string {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  if (!trimmed) return "";
  const match = BIRTHDAY_RE.exec(trimmed);
  if (!match) return "";
  const [, year, month, day] = match;
  if (!month) return year;
  if (!day) return `${year}-${month}`;
  return `${year}-${month}-${day}`;
}

function cleanObjectId(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim()
    ? value.trim().slice(0, 64)
    : fallback;
}

export interface SanitizedProfilePatch {
  name?: string;
  nickname?: string;
  email?: string;
  occupation?: string;
  skills?: string[];
  interests?: string[];
  goals?: string[];
  dailyRoutine?: string;
  preferences?: Array<{ id: string; key: string; value: string }>;
  location?: string;
  timezone?: string;
  birthday?: string;
  emergencyContacts?: Array<{
    id: string;
    name: string;
    relation: string;
    phone: string;
  }>;
  socialLinks?: Array<{ id: string; label: string; url: string }>;
  customNotes?: string;
}

export function sanitizeProfilePatch(
  input: Record<string, unknown>
): SanitizedProfilePatch {
  const output: SanitizedProfilePatch = {};

  if (input.name !== undefined) {
    output.name = cleanString(input.name, 120);
  }
  if (input.nickname !== undefined) {
    output.nickname = cleanString(input.nickname, 120);
  }
  if (input.email !== undefined) {
    const email = cleanString(input.email, 254);
    output.email = email && EMAIL_RE.test(email) ? email : "";
  }
  if (input.occupation !== undefined) {
    output.occupation = cleanString(input.occupation, 200);
  }
  if (input.skills !== undefined) {
    output.skills = cleanStringArray(input.skills);
  }
  if (input.interests !== undefined) {
    output.interests = cleanStringArray(input.interests);
  }
  if (input.goals !== undefined) {
    output.goals = cleanStringArray(input.goals);
  }
  if (input.dailyRoutine !== undefined) {
    output.dailyRoutine = cleanString(input.dailyRoutine, MAX_TEXT);
  }
  if (input.preferences !== undefined) {
    output.preferences = cleanList(
      input.preferences,
      (item, index): { id: string; key: string; value: string } | null => {
        if (typeof item !== "object" || item === null) return null;
        const record = item as Record<string, unknown>;
        const key = cleanString(record.key, 100);
        if (!key) return null;
        return {
          id: cleanObjectId(record.id, `preference-${index}`),
          key,
          value: cleanString(record.value, 500),
        };
      }
    );
  }
  if (input.location !== undefined) {
    output.location = cleanString(input.location, 200);
  }
  if (input.timezone !== undefined) {
    output.timezone = cleanString(input.timezone, 120);
  }
  if (input.birthday !== undefined) {
    output.birthday = cleanBirthday(input.birthday);
  }
  if (input.emergencyContacts !== undefined) {
    output.emergencyContacts = cleanList(
      input.emergencyContacts,
      (item, index): {
        id: string;
        name: string;
        relation: string;
        phone: string;
      } | null => {
        if (typeof item !== "object" || item === null) return null;
        const record = item as Record<string, unknown>;
        const name = cleanString(record.name, 120);
        if (!name) return null;
        return {
          id: cleanObjectId(record.id, `contact-${index}`),
          name,
          relation: cleanString(record.relation, 80),
          phone: cleanString(record.phone, 40),
        };
      }
    );
  }
  if (input.socialLinks !== undefined) {
    output.socialLinks = cleanList(
      input.socialLinks,
      (item, index): { id: string; label: string; url: string } | null => {
        if (typeof item !== "object" || item === null) return null;
        const record = item as Record<string, unknown>;
        const label = cleanString(record.label, 80);
        const url = cleanString(record.url, 500);
        if (!label || !url) return null;
        return {
          id: cleanObjectId(record.id, `social-${index}`),
          label,
          url,
        };
      }
    );
  }
  if (input.customNotes !== undefined) {
    output.customNotes = cleanString(input.customNotes, 4000);
  }

  return output;
}

export function sanitizeEntryContent(input: {
  content: unknown;
  category?: unknown;
  note?: unknown;
}): {
  content: string;
  category: MemoryCategory;
  note: string;
} {
  const content = cleanString(input.content, MAX_ENTRY_CONTENT);
  const category: MemoryCategory =
    input.category && isMemoryCategory(input.category)
      ? input.category
      : "custom";
  const note = cleanString(input.note, MAX_NOTE);
  return { content, category, note };
}

export function sanitizeEntryPatch(input: {
  content?: unknown;
  category?: unknown;
  note?: unknown;
}): { content?: string; category?: MemoryCategory; note?: string } {
  const output: { content?: string; category?: MemoryCategory; note?: string } =
    {};
  if (input.content !== undefined) {
    output.content = cleanString(input.content, MAX_ENTRY_CONTENT);
  }
  if (input.category !== undefined) {
    output.category = isMemoryCategory(input.category) ? input.category : "custom";
  }
  if (input.note !== undefined) {
    output.note = cleanString(input.note, MAX_NOTE);
  }
  return output;
}

export function sanitizePrivacyPatch(
  input: Record<string, unknown>
): Partial<{ enabled: boolean; contextInjection: boolean; autoLearn: boolean }> {
  const output: Partial<{
    enabled: boolean;
    contextInjection: boolean;
    autoLearn: boolean;
  }> = {};
  if (input.enabled !== undefined) {
    output.enabled = input.enabled === true;
  }
  if (input.contextInjection !== undefined) {
    output.contextInjection = input.contextInjection === true;
  }
  if (input.autoLearn !== undefined) {
    output.autoLearn = input.autoLearn === true;
  }
  return output;
}

export function sanitizeLearnedFacts(
  facts: unknown
): Array<{ content: string; category: MemoryCategory; note: string; confidence: number | null }> {
  if (!Array.isArray(facts)) return [];
  const cleaned: Array<{
    content: string;
    category: MemoryCategory;
    note: string;
    confidence: number | null;
  }> = [];
  for (const fact of facts) {
    if (cleaned.length >= MAX_LIST_ITEMS) break;
    if (typeof fact !== "object" || fact === null) continue;
    const record = fact as Record<string, unknown>;
    const content = cleanString(record.content, MAX_ENTRY_CONTENT);
    if (!content) continue;
    const category: MemoryCategory =
      record.category && isMemoryCategory(record.category)
        ? record.category
        : "custom";
    const note = cleanString(record.note, MAX_NOTE);
    const rawConfidence = record.confidence;
    const confidence =
      typeof rawConfidence === "number" && Number.isFinite(rawConfidence)
        ? Math.min(1, Math.max(0, rawConfidence))
        : null;
    cleaned.push({ content, category, note, confidence });
  }
  return cleaned;
}

export function newId(): string {
  return randomUUID();
}
