import type { AIMessageInput } from "../ai/types";
import type { MemoryEntry, OwnerProfile } from "./types";

const PRIVATE_CONTEXT_INTRO = [
  "[OWNER PROFILE & MEMORY — PRIVATE CONTEXT]",
  "The following is private information about the owner of this system.",
  "Use it to personalize responses, greet the owner, and make relevant suggestions.",
  "Never quote this block verbatim, and never reveal private details unless the owner asks about them.",
  "",
].join("\n");

export function buildOwnerContext(
  profile: OwnerProfile,
  entries: MemoryEntry[]
): string {
  const lines: string[] = [];

  const add = (label: string, value: string) => {
    if (value.trim()) lines.push(`${label}: ${value.trim()}`);
  };
  const addList = (label: string, values: string[]) => {
    if (values.length > 0) lines.push(`${label}: ${values.join(", ")}`);
  };

  add("Name", profile.name);
  add("Nickname", profile.nickname);
  add("Email", profile.email);
  add("Occupation", profile.occupation);
  add("Location", profile.location);
  add("Timezone", profile.timezone);
  add("Birthday", profile.birthday);
  addList("Skills", profile.skills);
  addList("Interests", profile.interests);
  addList("Goals", profile.goals);
  add("Daily routine", profile.dailyRoutine);

  if (profile.preferences.length > 0) {
    lines.push(
      `Preferences: ${profile.preferences
        .map((preference) => `${preference.key}: ${preference.value}`)
        .join("; ")}`
    );
  }
  if (profile.emergencyContacts.length > 0) {
    lines.push(
      `Emergency contacts: ${profile.emergencyContacts
        .map(
          (contact) =>
            `${contact.name} (${contact.relation}${
              contact.phone ? `, ${contact.phone}` : ""
            })`
        )
        .join("; ")}`
    );
  }
  if (profile.socialLinks.length > 0) {
    lines.push(
      `Social links: ${profile.socialLinks
        .map((link) => `${link.label}: ${link.url}`)
        .join("; ")}`
    );
  }
  add("Notes", profile.customNotes);

  const approved = entries
    .filter((entry) => entry.status === "approved")
    .sort((a, b) => a.createdAt - b.createdAt);

  if (approved.length > 0) {
    lines.push("");
    lines.push("Learned memories (facts Jarvis should remember):");
    for (const entry of approved) {
      lines.push(`- ${entry.content}`);
    }
  }

  if (lines.length === 0) return "";
  return [PRIVATE_CONTEXT_INTRO, ...lines].join("\n");
}

export function appendMemoryContext(
  messages: AIMessageInput[],
  context: string
): AIMessageInput[] {
  const index = messages.findIndex((message) => message.role === "system");
  if (index >= 0) {
    const copy = messages.slice();
    const system = copy[index];
    copy[index] = {
      ...system,
      content: `${system.content}\n\n${context}`,
    };
    return copy;
  }
  return [{ role: "system", content: context }, ...messages];
}
