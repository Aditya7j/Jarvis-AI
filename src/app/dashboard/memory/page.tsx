"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { DashboardPageFrame } from "../_components/dashboard-page-frame";
import { GlassCard } from "@/components/ui/glass-card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { memoryClient } from "@/lib/memory/client";
import { MEMORY_CATEGORIES, type MemoryCategory, type MemoryEntry, type MemorySnapshot, type MemoryStatus } from "@/lib/memory/types";
import { cn } from "@/lib/utils";
import {
  Brain,
  Briefcase,
  CalendarClock,
  Check,
  Clock,
  Eye,
  FolderGit2,
  Globe,
  Heart,
  Loader2,
  Pencil,
  Phone,
  Plus,
  Search,
  Shield,
  SlidersHorizontal,
  Sparkles,
  Trash2,
  User,
  X,
} from "lucide-react";

const CATEGORY_META: Record<
  MemoryCategory,
  { label: string; bg: string; color: string; icon: React.ComponentType<{ className?: string }> }
> = {
  identity: { label: "Identity", bg: "bg-blue-500/10", color: "text-blue-400", icon: User },
  personal: { label: "Personal", bg: "bg-purple-500/10", color: "text-purple-400", icon: Heart },
  preference: { label: "Preference", bg: "bg-amber-500/10", color: "text-amber-400", icon: SlidersHorizontal },
  contact: { label: "Contact", bg: "bg-cyan-500/10", color: "text-cyan-400", icon: Phone },
  work: { label: "Work", bg: "bg-green-500/10", color: "text-green-400", icon: Briefcase },
  routine: { label: "Routine", bg: "bg-teal-500/10", color: "text-teal-400", icon: CalendarClock },
  project: { label: "Project", bg: "bg-orange-500/10", color: "text-orange-400", icon: FolderGit2 },
  social: { label: "Social", bg: "bg-pink-500/10", color: "text-pink-400", icon: Globe },
  custom: { label: "Custom", bg: "bg-white/[0.06]", color: "text-white/50", icon: Brain },
};

const STATUS_META: Record<MemoryStatus, { variant: "success" | "warning" | "danger"; label: string }> = {
  approved: { variant: "success", label: "Approved" },
  pending: { variant: "warning", label: "Awaiting review" },
  rejected: { variant: "danger", label: "Rejected" },
};

function timeAgo(timestamp: number): string {
  const minutes = Math.floor((Date.now() - timestamp) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.floor(months / 12)}y ago`;
}

export default function MemoryPage() {
  const [snapshot, setSnapshot] = useState<MemorySnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const [search, setSearch] = useState("");
  const [categoryFilter, setCategoryFilter] = useState<MemoryCategory | "all">("all");
  const [statusFilter, setStatusFilter] = useState<MemoryStatus | "all">("all");

  const [composer, setComposer] = useState({ content: "", category: "custom" as MemoryCategory, note: "" });
  const [composing, setComposing] = useState(false);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState({ content: "", note: "" });

  const [confirmClear, setConfirmClear] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [preview, setPreview] = useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      setSnapshot(await memoryClient.getSnapshot());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load memory.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const updateSnapshotEntry = useCallback((entry: MemoryEntry) => {
    setSnapshot((previous) =>
      previous
        ? { ...previous, entries: previous.entries.map((e) => (e.id === entry.id ? entry : e)) }
        : previous
    );
  }, []);

  const handleCreate = useCallback(async () => {
    const content = composer.content.trim();
    if (!content || composing) return;
    setComposing(true);
    setError("");
    try {
      const { entry } = await memoryClient.createEntry({
        content,
        category: composer.category,
        note: composer.note.trim() || undefined,
      });
      setSnapshot((previous) =>
        previous ? { ...previous, entries: [entry, ...previous.entries] } : previous
      );
      setComposer({ content: "", category: "custom", note: "" });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save the memory.");
    } finally {
      setComposing(false);
    }
  }, [composer, composing]);

  const startEdit = useCallback((entry: MemoryEntry) => {
    setEditingId(entry.id);
    setEditDraft({ content: entry.content, note: entry.note });
  }, []);

  const handleSaveEdit = useCallback(async () => {
    const content = editDraft.content.trim();
    if (!editingId || !content) return;
    setError("");
    try {
      const { entry } = await memoryClient.updateEntry(editingId, {
        content,
        note: editDraft.note.trim() || undefined,
      });
      updateSnapshotEntry(entry);
      setEditingId(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not update the memory.");
    }
  }, [editingId, editDraft, updateSnapshotEntry]);

  const handleReview = useCallback(
    async (id: string, approved: boolean) => {
      setError("");
      try {
        const { entry } = approved ? await memoryClient.approveEntry(id) : await memoryClient.rejectEntry(id);
        updateSnapshotEntry(entry);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Could not review the memory.");
      }
    },
    [updateSnapshotEntry]
  );

  const handleDelete = useCallback(
    async (id: string) => {
      setError("");
      try {
        await memoryClient.deleteEntry(id);
        setSnapshot((previous) =>
          previous ? { ...previous, entries: previous.entries.filter((e) => e.id !== id) } : previous
        );
      } catch (e) {
        setError(e instanceof Error ? e.message : "Could not delete the memory.");
      }
    },
    []
  );

  const handleClearAll = useCallback(async () => {
    setClearing(true);
    setError("");
    try {
      await memoryClient.clearAll();
      setSnapshot((previous) => (previous ? { ...previous, entries: [] } : previous));
      setConfirmClear(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not clear memory.");
    } finally {
      setClearing(false);
    }
  }, []);

  const setPrivacyKey = useCallback(
    async (key: "enabled" | "contextInjection" | "autoLearn", value: boolean) => {
      setError("");
      const previous = snapshot?.privacy;
      setSnapshot((prev) => (prev ? { ...prev, privacy: { ...prev.privacy, [key]: value } } : prev));
      try {
        const { privacy } = await memoryClient.setPrivacy({ [key]: value });
        setSnapshot((prev) => (prev ? { ...prev, privacy } : prev));
      } catch (e) {
        if (previous) setSnapshot((prev) => (prev ? { ...prev, privacy: previous } : prev));
        setError(e instanceof Error ? e.message : "Could not update privacy settings.");
      }
    },
    [snapshot]
  );

  const togglePreview = useCallback(async () => {
    setPreviewOpen((open) => !open);
    if (!previewOpen) {
      setPreviewLoading(true);
      setError("");
      try {
        const { context } = await memoryClient.getContext();
        setPreview(context);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Could not preview the AI context.");
      } finally {
        setPreviewLoading(false);
      }
    }
  }, [previewOpen]);

  const visible = useMemo(() => {
    if (!snapshot) return [];
    const query = search.trim().toLowerCase();
    return snapshot.entries
      .filter((entry) => statusFilter === "all" || entry.status === statusFilter)
      .filter((entry) => categoryFilter === "all" || entry.category === categoryFilter)
      .filter(
        (entry) =>
          !query ||
          entry.content.toLowerCase().includes(query) ||
          entry.note.toLowerCase().includes(query)
      )
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }, [snapshot, search, categoryFilter, statusFilter]);

  const counts = useMemo(() => {
    if (!snapshot) return { total: 0, approved: 0, pending: 0, rejected: 0 };
    const entries = snapshot.entries;
    return {
      total: entries.length,
      approved: entries.filter((e) => e.status === "approved").length,
      pending: entries.filter((e) => e.status === "pending").length,
      rejected: entries.filter((e) => e.status === "rejected").length,
    };
  }, [snapshot]);

  const privacy = snapshot?.privacy;

  return (
    <DashboardPageFrame>
      <div>
        <header className="border-b border-white/[0.03] bg-black/60 backdrop-blur-xl px-6 py-3">
          <h1 className="text-sm text-white/60">Memory</h1>
        </header>

        <main className="p-6 max-w-4xl space-y-4">
          {error && (
            <GlassCard className="p-4 border-red-500/10">
              <p className="text-xs text-red-400/80">{error}</p>
            </GlassCard>
          )}

          <div className="grid grid-cols-4 gap-4">
            {[
              { label: "Total", value: counts.total, color: "text-white/80" },
              { label: "Active", value: counts.approved, color: "text-green-400" },
              { label: "Awaiting review", value: counts.pending, color: "text-amber-400" },
              { label: "Rejected", value: counts.rejected, color: "text-red-400/80" },
            ].map((stat) => (
              <GlassCard key={stat.label} className="p-4">
                <p className="text-2xl font-light tracking-tight">
                  <span className={stat.color}>{stat.value}</span>
                </p>
                <p className="text-[10px] text-white/30 uppercase tracking-wider mt-1">
                  {stat.label}
                </p>
              </GlassCard>
            ))}
          </div>

          {privacy && (
            <GlassCard className="p-5 border-blue-500/20">
              <div className="flex items-center gap-2 mb-4">
                <Shield className="w-4 h-4 text-blue-400" />
                <h2 className="text-sm text-white/70">Privacy & Storage</h2>
              </div>
              <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
                <div className="space-y-4">
                  <Switch
                    checked={privacy.enabled}
                    onCheckedChange={(checked) => setPrivacyKey("enabled", checked)}
                    label="Memory enabled"
                    description="Store profile and learned facts on this machine."
                  />
                  <Switch
                    checked={privacy.contextInjection}
                    onCheckedChange={(checked) => setPrivacyKey("contextInjection", checked)}
                    disabled={!privacy.enabled}
                    label="Inject into AI context"
                    description="Automatically include your profile and memories in every AI request."
                  />
                  <Switch
                    checked={privacy.autoLearn}
                    onCheckedChange={(checked) => setPrivacyKey("autoLearn", checked)}
                    disabled={!privacy.enabled}
                    label="Allow Jarvis to learn"
                    description="Jarvis may propose new facts, always awaiting your approval."
                  />
                </div>
                <div className="flex flex-col items-start gap-2 md:items-end">
                  <Button
                    size="sm"
                    variant={confirmClear ? "outline" : "secondary"}
                    onClick={() => (confirmClear ? handleClearAll() : setConfirmClear(true))}
                    disabled={clearing}
                    className={cn(
                      confirmClear && "border-red-500/40 text-red-400 hover:bg-red-500/10"
                    )}
                  >
                    {clearing ? (
                      <>
                        <Loader2 className="w-3.5 h-3.5 mr-1 animate-spin" />
                        Clearing...
                      </>
                    ) : confirmClear ? (
                      <>
                        <Trash2 className="w-3.5 h-3.5 mr-1" />
                        Confirm clear all?
                      </>
                    ) : (
                      <>
                        <Trash2 className="w-3.5 h-3.5 mr-1" />
                        Clear all memories
                      </>
                    )}
                  </Button>
                  {confirmClear && (
                    <button
                      onClick={() => setConfirmClear(false)}
                      className="text-[10px] text-white/30 hover:text-white/50"
                    >
                      Cancel
                    </button>
                  )}
                </div>
              </div>
            </GlassCard>
          )}

          <GlassCard className="p-5">
            <div className="flex items-center gap-2 mb-3">
              <Brain className="w-4 h-4 text-purple-400" />
              <h2 className="text-sm text-white/70">Add a memory</h2>
            </div>
            <div className="space-y-2">
              <Textarea
                value={composer.content}
                onChange={(e) => setComposer((c) => ({ ...c, content: e.target.value }))}
                placeholder="What should Jarvis remember? e.g. I prefer email summaries over long meetings..."
                className="min-h-[70px]"
              />
              <div className="flex items-center gap-2">
                <Select
                  value={composer.category}
                  onChange={(e) =>
                    setComposer((c) => ({ ...c, category: e.target.value as MemoryCategory }))
                  }
                  className="w-40"
                >
                  {MEMORY_CATEGORIES.map((category) => (
                    <option key={category} value={category}>
                      {CATEGORY_META[category].label}
                    </option>
                  ))}
                </Select>
                <Input
                  value={composer.note}
                  onChange={(e) => setComposer((c) => ({ ...c, note: e.target.value }))}
                  placeholder="Optional context (private note attached to this memory)"
                  className="flex-1"
                />
                <Button size="sm" onClick={handleCreate} disabled={!composer.content.trim() || composing}>
                  {composing ? (
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  ) : (
                    <>
                      <Plus className="w-3.5 h-3.5 mr-1" />
                      Add
                    </>
                  )}
                </Button>
              </div>
            </div>
          </GlassCard>

          {counts.pending > 0 && (
            <GlassCard className="p-4 border-amber-500/20 bg-amber-500/[0.03]">
              <div className="flex items-center gap-2 text-amber-300/90">
                <Sparkles className="w-4 h-4 shrink-0" />
                <p className="text-xs">
                  Jarvis learned {counts.pending} new{" "}
                  {counts.pending === 1 ? "fact" : "facts"} — approve or reject them below.
                </p>
              </div>
            </GlassCard>
          )}

          <GlassCard className="p-5">
            <div className="flex items-center gap-2 mb-4">
              <Clock className="w-4 h-4 text-white/30" />
              <h2 className="text-sm text-white/70">Memory Timeline</h2>
              <button
                onClick={togglePreview}
                className="ml-auto flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white/[0.03] border border-white/[0.05] text-xs text-white/40 hover:text-white/70 transition-all"
              >
                <Eye className="w-3 h-3" />
                {previewOpen ? "Hide" : "Preview"} AI context
              </button>
            </div>

            {previewOpen && (
              <div className="mb-4 rounded-xl border border-white/[0.05] bg-black/40 p-4">
                <p className="text-[10px] text-white/30 uppercase tracking-wider mb-2">
                  What Jarvis currently sees about you
                </p>
                {previewLoading ? (
                  <p className="text-xs text-white/30 flex items-center gap-1.5">
                    <Loader2 className="w-3 h-3 animate-spin" /> Building context...
                  </p>
                ) : preview ? (
                  <pre className="text-xs text-white/50 leading-relaxed whitespace-pre-wrap font-mono">
                    {preview}
                  </pre>
                ) : (
                  <p className="text-xs text-white/30">
                    Context is currently disabled or empty. Add profile details or memories to see them here.
                  </p>
                )}
              </div>
            )}

            <div className="flex items-center gap-2 mb-4">
              <div className="relative flex-1">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-white/20" />
                <Input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search memories..."
                  className="pl-10"
                />
              </div>
              <Select
                value={categoryFilter}
                onChange={(e) => setCategoryFilter(e.target.value as MemoryCategory | "all")}
                className="w-36"
              >
                <option value="all">All categories</option>
                {MEMORY_CATEGORIES.map((category) => (
                  <option key={category} value={category}>
                    {CATEGORY_META[category].label}
                  </option>
                ))}
              </Select>
              <Select
                value={statusFilter}
                onChange={(e) => setStatusFilter(e.target.value as MemoryStatus | "all")}
                className="w-36"
              >
                <option value="all">All statuses</option>
                <option value="approved">Approved</option>
                <option value="pending">Awaiting review</option>
                <option value="rejected">Rejected</option>
              </Select>
            </div>

            {loading ? (
              <div className="flex items-center justify-center py-16 text-white/30">
                <Loader2 className="w-5 h-5 animate-spin mr-2" />
                Loading memories...
              </div>
            ) : visible.length === 0 ? (
              <div className="py-16 text-center">
                <Brain className="w-8 h-8 text-white/10 mx-auto mb-3" />
                <p className="text-sm text-white/30">
                  {search || categoryFilter !== "all" || statusFilter !== "all"
                    ? "No memories match your filters."
                    : "No memories yet. Add one above or talk to Jarvis."}
                </p>
              </div>
            ) : (
              <div className="grid gap-2">
                {visible.map((entry) => {
                  const category = CATEGORY_META[entry.category];
                  const status = STATUS_META[entry.status];
                  const editing = editingId === entry.id;
                  return (
                    <GlassCard key={entry.id} className="p-4">
                      <div className="flex items-start gap-3">
                        <div className={cn("w-8 h-8 rounded-lg flex items-center justify-center shrink-0", category.bg)}>
                          <category.icon className={cn("w-4 h-4", category.color)} />
                        </div>
                        <div className="flex-1 min-w-0">
                          {editing ? (
                            <div className="space-y-2">
                              <Textarea
                                value={editDraft.content}
                                onChange={(e) => setEditDraft((d) => ({ ...d, content: e.target.value }))}
                                className="min-h-[60px]"
                                autoFocus
                              />
                              <div className="flex items-center gap-2">
                                <Button
                                  size="sm"
                                  onClick={handleSaveEdit}
                                  disabled={!editDraft.content.trim()}
                                >
                                  <Check className="w-3.5 h-3.5 mr-1" />
                                  Save
                                </Button>
                                <Button size="sm" variant="ghost" onClick={() => setEditingId(null)}>
                                  Cancel
                                </Button>
                              </div>
                            </div>
                          ) : (
                            <>
                              <p className="text-sm text-white/70 leading-relaxed">{entry.content}</p>
                              {entry.note && (
                                <p className="text-xs text-white/30 mt-1">{entry.note}</p>
                              )}
                            </>
                          )}
                          <div className="flex items-center gap-2 mt-2 flex-wrap">
                            <Badge variant={status.variant}>{status.label}</Badge>
                            <Badge variant="muted">{category.label}</Badge>
                            {entry.source === "ai" ? (
                              <Badge variant="info">
                                <Sparkles className="w-2.5 h-2.5" /> Jarvis
                              </Badge>
                            ) : (
                              <Badge variant="muted">You</Badge>
                            )}
                            <span className="text-[10px] text-white/20 flex items-center gap-1">
                              <Clock className="w-3 h-3" />
                              {timeAgo(entry.updatedAt)}
                            </span>
                          </div>
                        </div>
                        <div className="flex items-center gap-1 shrink-0">
                          {entry.status === "pending" && (
                            <>
                              <button
                                onClick={() => handleReview(entry.id, true)}
                                className="p-2 rounded-lg text-amber-300/70 hover:text-green-400 hover:bg-green-500/10 transition-all"
                                title="Approve"
                              >
                                <Check className="w-3.5 h-3.5" />
                              </button>
                              <button
                                onClick={() => handleReview(entry.id, false)}
                                className="p-2 rounded-lg text-amber-300/70 hover:text-red-400 hover:bg-red-500/10 transition-all"
                                title="Reject"
                              >
                                <X className="w-3.5 h-3.5" />
                              </button>
                            </>
                          )}
                          {!editing && (
                            <button
                              onClick={() => startEdit(entry)}
                              className="p-2 rounded-lg text-white/20 hover:text-white/70 hover:bg-white/[0.05] transition-all"
                              title="Edit"
                            >
                              <Pencil className="w-3.5 h-3.5" />
                            </button>
                          )}
                          <button
                            onClick={() => handleDelete(entry.id)}
                            className="p-2 rounded-lg text-white/20 hover:text-red-400 hover:bg-red-500/10 transition-all"
                            title="Delete"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      </div>
                    </GlassCard>
                  );
                })}
              </div>
            )}
          </GlassCard>
        </main>
      </div>
    </DashboardPageFrame>
  );
}
