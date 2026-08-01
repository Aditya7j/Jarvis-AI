"use client";

import { useCallback, useEffect, useState } from "react";
import { DashboardPageFrame } from "../_components/dashboard-page-frame";
import { GlassCard } from "@/components/ui/glass-card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { memoryClient } from "@/lib/memory/client";
import type {
  EmergencyContact,
  OwnerProfile,
  PreferenceItem,
  SocialLink,
} from "@/lib/memory/types";
import {
  Briefcase,
  CalendarClock,
  Check,
  Heart,
  Link as LinkIcon,
  Loader2,
  Mail,
  Phone,
  Plus,
  RotateCcw,
  Save,
  Shield,
  SlidersHorizontal,
  StickyNote,
  Target,
  User,
  Wrench,
  X,
} from "lucide-react";
import { cn } from "@/lib/utils";

interface ProfileDraft {
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
}

function toDraft(profile: OwnerProfile): ProfileDraft {
  return {
    name: profile.name,
    nickname: profile.nickname,
    email: profile.email,
    occupation: profile.occupation,
    skills: profile.skills,
    interests: profile.interests,
    goals: profile.goals,
    dailyRoutine: profile.dailyRoutine,
    preferences: profile.preferences,
    location: profile.location,
    timezone: profile.timezone,
    birthday: profile.birthday,
    emergencyContacts: profile.emergencyContacts,
    socialLinks: profile.socialLinks,
    customNotes: profile.customNotes,
  };
}

function newId(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}`;
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-xs text-white/40">{label}</span>
      {children}
      {hint && <span className="text-[10px] text-white/20">{hint}</span>}
    </label>
  );
}

function SectionCard({
  icon: Icon,
  title,
  description,
  children,
}: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <GlassCard className="p-5">
      <div className="flex items-center gap-2 mb-1">
        <Icon className="w-4 h-4 text-blue-400" />
        <h2 className="text-sm text-white/70">{title}</h2>
      </div>
      {description && (
        <p className="text-xs text-white/20 mb-4">{description}</p>
      )}
      <div className="mt-3">{children}</div>
    </GlassCard>
  );
}

function TagEditor({
  placeholder,
  values,
  onChange,
}: {
  placeholder: string;
  values: string[];
  onChange: (values: string[]) => void;
}) {
  const [value, setValue] = useState("");
  const add = () => {
    const tag = value.trim();
    if (tag && !values.includes(tag)) onChange([...values, tag]);
    setValue("");
  };
  return (
    <div>
      {values.length > 0 && (
        <div className="flex flex-wrap gap-1.5 mb-2">
          {values.map((tag) => (
            <span
              key={tag}
              className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-blue-500/10 border border-blue-500/20 text-xs text-blue-300/90"
            >
              {tag}
              <button
                type="button"
                onClick={() => onChange(values.filter((t) => t !== tag))}
                className="text-blue-300/40 hover:text-blue-300 transition-colors"
                aria-label={`Remove ${tag}`}
              >
                <X className="w-3 h-3" />
              </button>
            </span>
          ))}
        </div>
      )}
      <div className="flex items-center gap-2">
        <Input
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              add();
            }
          }}
          placeholder={placeholder}
        />
        <Button
          type="button"
          size="sm"
          variant="secondary"
          onClick={add}
          aria-label="Add"
        >
          <Plus className="w-3.5 h-3.5" />
        </Button>
      </div>
    </div>
  );
}

interface ListRowEditorProps<T> {
  items: T[];
  renderRow: (item: T) => React.ReactNode;
  onAdd: () => void;
  onRemove: (id: string) => void;
  addLabel: string;
}

function ListRowEditor<T extends { id: string }>({
  items,
  renderRow,
  onAdd,
  onRemove,
  addLabel,
}: ListRowEditorProps<T>) {
  return (
    <div className="space-y-2">
      {items.map((item) => (
        <div
          key={item.id}
          className="grid gap-2 rounded-xl bg-white/[0.02] border border-white/[0.05] p-2.5"
        >
          <div className="flex items-start gap-2">
            <div className="flex-1 grid gap-2 md:grid-cols-2">
              {renderRow(item)}
            </div>
            <button
              type="button"
              onClick={() => onRemove(item.id)}
              className="shrink-0 p-2 rounded-lg text-white/20 hover:text-red-400 hover:bg-red-500/10 transition-all"
              aria-label="Remove"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      ))}
      <Button
        type="button"
        size="sm"
        variant="secondary"
        onClick={onAdd}
        className="w-full"
      >
        <Plus className="w-3.5 h-3.5 mr-1" />
        {addLabel}
      </Button>
    </div>
  );
}

export default function ProfilePage() {
  const [draft, setDraft] = useState<ProfileDraft | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    memoryClient
      .getProfile()
      .then(({ profile }) => {
        if (!active) return;
        setDraft(toDraft(profile));
      })
      .catch((e: unknown) => {
        if (!active) return;
        setError(e instanceof Error ? e.message : "Could not load the owner profile.");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  const set = useCallback(<K extends keyof ProfileDraft>(key: K, value: ProfileDraft[K]) => {
    setDraft((current) => (current ? { ...current, [key]: value } : current));
  }, []);

  const handleSave = useCallback(async () => {
    if (!draft) return;
    setSaving(true);
    setError("");
    try {
      await memoryClient.updateProfile(draft);
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save the owner profile.");
    } finally {
      setSaving(false);
    }
  }, [draft]);

  const handleReset = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const { profile } = await memoryClient.getProfile();
      setDraft(toDraft(profile));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not reload the owner profile.");
    } finally {
      setLoading(false);
    }
  }, []);

  if (loading) {
    return (
      <DashboardPageFrame>
        <div className="flex items-center justify-center h-screen text-white/30">
          <Loader2 className="w-5 h-5 animate-spin mr-2" />
          Loading profile...
        </div>
      </DashboardPageFrame>
    );
  }

  if (!draft) {
    return (
      <DashboardPageFrame>
        <div className="p-6 max-w-4xl">
          <GlassCard className="p-5 border-red-500/10">
            <p className="text-sm text-red-400/80">{error || "Could not load the owner profile."}</p>
          </GlassCard>
        </div>
      </DashboardPageFrame>
    );
  }

  const updateTag = (key: "skills" | "interests" | "goals", values: string[]) =>
    set(key, values);

  const updatePreference = (id: string, patch: Partial<PreferenceItem>) =>
    set("preferences", draft.preferences.map((p) => (p.id === id ? { ...p, ...patch } : p)));

  const updateContact = (id: string, patch: Partial<EmergencyContact>) =>
    set("emergencyContacts", draft.emergencyContacts.map((c) => (c.id === id ? { ...c, ...patch } : c)));

  const updateSocial = (id: string, patch: Partial<SocialLink>) =>
    set("socialLinks", draft.socialLinks.map((s) => (s.id === id ? { ...s, ...patch } : s)));

  const initials =
    (draft.name || draft.nickname || "J")
      .split(/\s+/)
      .map((part) => part[0])
      .join("")
      .slice(0, 2)
      .toUpperCase() || "J";

  return (
    <DashboardPageFrame>
      <div>
        <header className="border-b border-white/[0.03] bg-black/60 backdrop-blur-xl px-6 py-3">
          <h1 className="text-sm text-white/60">Owner Profile</h1>
        </header>

        <main className="p-6 max-w-4xl space-y-4">
          <GlassCard className="p-5 border-blue-500/20">
            <div className="flex items-center gap-4">
              <div className="w-14 h-14 rounded-2xl bg-gradient-to-br from-blue-500 to-purple-600 flex items-center justify-center text-lg font-semibold text-white shadow-lg shadow-blue-500/20">
                {initials}
              </div>
              <div className="flex-1 min-w-0">
                <h2 className="text-base text-white/90 font-medium truncate">
                  {draft.name || "Unnamed Owner"}
                </h2>
                <p className="text-xs text-white/30 mt-0.5">
                  {draft.occupation || "No occupation set"} · {draft.location || "No location set"}
                </p>
                <p className="text-[10px] text-white/20 mt-1 flex items-center gap-1">
                  <Shield className="w-3 h-3 text-green-400/60" />
                  Stored locally in the JARVIS memory store — only used as private AI context.
                </p>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={handleReset}
                  disabled={saving}
                >
                  <RotateCcw className="w-3.5 h-3.5 mr-1" />
                  Reset
                </Button>
                <Button
                  size="sm"
                  onClick={handleSave}
                  disabled={saving}
                  variant={saved ? "secondary" : "default"}
                >
                  {saving ? (
                    <>
                      <Loader2 className="w-3.5 h-3.5 mr-1 animate-spin" />
                      Saving...
                    </>
                  ) : saved ? (
                    <>
                      <Check className="w-3.5 h-3.5 mr-1" />
                      Saved
                    </>
                  ) : (
                    <>
                      <Save className="w-3.5 h-3.5 mr-1" />
                      Save Changes
                    </>
                  )}
                </Button>
              </div>
            </div>
            {error && (
              <p className="text-xs text-red-400/80 mt-3 border-t border-red-500/10 pt-3">
                {error}
              </p>
            )}
          </GlassCard>

          <SectionCard
            icon={User}
            title="Basic Information"
            description="Who you are — used to greet you and personalize every conversation."
          >
            <div className="grid md:grid-cols-2 gap-4">
              <Field label="Name">
                <Input
                  value={draft.name}
                  onChange={(e) => set("name", e.target.value)}
                  placeholder="Tony Stark"
                />
              </Field>
              <Field label="Nickname">
                <Input
                  value={draft.nickname}
                  onChange={(e) => set("nickname", e.target.value)}
                  placeholder="Stark"
                />
              </Field>
              <Field label="Email">
                <Input
                  type="email"
                  value={draft.email}
                  onChange={(e) => set("email", e.target.value)}
                  placeholder="tony@starkindustries.com"
                />
              </Field>
              <Field label="Occupation">
                <Input
                  value={draft.occupation}
                  onChange={(e) => set("occupation", e.target.value)}
                  placeholder="Engineer, Inventor"
                />
              </Field>
              <Field label="Birthday" hint="Optional — used to wish you a happy birthday.">
                <Input
                  type="date"
                  value={draft.birthday}
                  onChange={(e) => set("birthday", e.target.value)}
                />
              </Field>
              <Field label="Timezone" hint="e.g. America/New_York (UTC-5)">
                <Input
                  value={draft.timezone}
                  onChange={(e) => set("timezone", e.target.value)}
                  placeholder="America/New_York"
                />
              </Field>
              <Field label="Location" hint="City, country, or time zone you usually operate from.">
                <Input
                  value={draft.location}
                  onChange={(e) => set("location", e.target.value)}
                  placeholder="Malibu, California"
                />
              </Field>
            </div>
          </SectionCard>

          <SectionCard
            icon={Target}
            title="Skills, Interests & Goals"
            description="Press Enter or click + to add a tag. Click × on a tag to remove it."
          >
            <div className="space-y-4">
              <div>
                <span className="text-xs text-white/40 flex items-center gap-1.5 mb-2">
                  <Wrench className="w-3.5 h-3.5 text-white/20" /> Skills
                </span>
                <TagEditor
                  values={draft.skills}
                  onChange={(values) => updateTag("skills", values)}
                  placeholder="e.g. TypeScript, Product Design"
                />
              </div>
              <div>
                <span className="text-xs text-white/40 flex items-center gap-1.5 mb-2">
                  <Heart className="w-3.5 h-3.5 text-white/20" /> Interests
                </span>
                <TagEditor
                  values={draft.interests}
                  onChange={(values) => updateTag("interests", values)}
                  placeholder="e.g. AI, Photography, F1"
                />
              </div>
              <div>
                <span className="text-xs text-white/40 flex items-center gap-1.5 mb-2">
                  <Target className="w-3.5 h-3.5 text-white/20" /> Goals
                </span>
                <TagEditor
                  values={draft.goals}
                  onChange={(values) => updateTag("goals", values)}
                  placeholder="e.g. Ship JARVIS v1.0"
                />
              </div>
            </div>
          </SectionCard>

          <SectionCard
            icon={CalendarClock}
            title="Daily Routine"
            description="A summary of your typical day — lets Jarvis time its suggestions and reminders."
          >
            <Textarea
              value={draft.dailyRoutine}
              onChange={(e) => set("dailyRoutine", e.target.value)}
              placeholder="Wake up at 7am, coffee, deep-work 9–12, gym in the afternoon, wind down by 11pm..."
              className="min-h-[120px]"
            />
          </SectionCard>

          <SectionCard
            icon={SlidersHorizontal}
            title="Preferences"
            description="Key-value preferences Jarvis should honor (tone, tools, hotkeys, coffee order...)."
          >
            <ListRowEditor<PreferenceItem>
              items={draft.preferences}
              addLabel="Add preference"
              onAdd={() =>
                set("preferences", [
                  ...draft.preferences,
                  { id: newId("pref"), key: "", value: "" },
                ])
              }
              onRemove={(id) =>
                set("preferences", draft.preferences.filter((p) => p.id !== id))
              }
              renderRow={(item) => (
                <>
                  <Input
                    value={item.key}
                    onChange={(e) => updatePreference(item.id, { key: e.target.value })}
                    placeholder="Key (e.g. Coffee order)"
                    className="md:col-span-1"
                  />
                  <Input
                    value={item.value}
                    onChange={(e) => updatePreference(item.id, { value: e.target.value })}
                    placeholder="Value (e.g. Flat white, oat milk)"
                    className="md:col-span-1"
                  />
                </>
              )}
            />
          </SectionCard>

          <SectionCard
            icon={Phone}
            title="Emergency Contacts"
            description="Who to reach in an emergency. Jarvis can surface these quickly when asked."
          >
            <ListRowEditor<EmergencyContact>
              items={draft.emergencyContacts}
              addLabel="Add emergency contact"
              onAdd={() =>
                set("emergencyContacts", [
                  ...draft.emergencyContacts,
                  { id: newId("contact"), name: "", relation: "", phone: "" },
                ])
              }
              onRemove={(id) =>
                set("emergencyContacts", draft.emergencyContacts.filter((c) => c.id !== id))
              }
              renderRow={(item) => (
                <>
                  <Input
                    value={item.name}
                    onChange={(e) => updateContact(item.id, { name: e.target.value })}
                    placeholder="Name (e.g. Pepper Potts)"
                  />
                  <div className="grid grid-cols-2 gap-2">
                    <Input
                      value={item.relation}
                      onChange={(e) => updateContact(item.id, { relation: e.target.value })}
                      placeholder="Relation (e.g. Spouse)"
                    />
                    <Input
                      value={item.phone}
                      onChange={(e) => updateContact(item.id, { phone: e.target.value })}
                      placeholder="Phone"
                      type="tel"
                    />
                  </div>
                </>
              )}
            />
          </SectionCard>

          <SectionCard
            icon={LinkIcon}
            title="Social Links"
            description="Public profiles — GitHub, LinkedIn, X, personal site."
          >
            <ListRowEditor<SocialLink>
              items={draft.socialLinks}
              addLabel="Add social link"
              onAdd={() =>
                set("socialLinks", [
                  ...draft.socialLinks,
                  { id: newId("social"), label: "", url: "" },
                ])
              }
              onRemove={(id) =>
                set("socialLinks", draft.socialLinks.filter((s) => s.id !== id))
              }
              renderRow={(item) => (
                <>
                  <Input
                    value={item.label}
                    onChange={(e) => updateSocial(item.id, { label: e.target.value })}
                    placeholder="Platform (e.g. GitHub)"
                  />
                  <Input
                    value={item.url}
                    onChange={(e) => updateSocial(item.id, { url: e.target.value })}
                    placeholder="https://github.com/..."
                  />
                </>
              )}
            />
          </SectionCard>

          <SectionCard
            icon={StickyNote}
            title="Custom Notes"
            description="Anything else Jarvis should know — freeform and private."
          >
            <Textarea
              value={draft.customNotes}
              onChange={(e) => set("customNotes", e.target.value)}
              placeholder="Add any other context you want Jarvis to remember about you..."
              className="min-h-[140px]"
            />
          </SectionCard>

          <div className={cn("flex items-center justify-end gap-2 pb-6")}>
            <Button size="sm" variant="secondary" onClick={handleReset} disabled={saving}>
              <RotateCcw className="w-3.5 h-3.5 mr-1" />
              Reset
            </Button>
            <Button size="sm" onClick={handleSave} disabled={saving} variant={saved ? "secondary" : "default"}>
              {saving ? (
                <>
                  <Loader2 className="w-3.5 h-3.5 mr-1 animate-spin" />
                  Saving...
                </>
              ) : saved ? (
                <>
                  <Check className="w-3.5 h-3.5 mr-1" />
                  Saved
                </>
              ) : (
                <>
                  <Save className="w-3.5 h-3.5 mr-1" />
                  Save Changes
                </>
              )}
            </Button>
          </div>
        </main>
      </div>
    </DashboardPageFrame>
  );
}
