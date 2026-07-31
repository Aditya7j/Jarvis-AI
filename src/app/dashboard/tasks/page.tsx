"use client";

import { useCallback, useMemo, useState } from "react";
import { DashboardPageFrame } from "../_components/dashboard-page-frame";
import { GlassCard } from "@/components/ui/glass-card";
import { cn } from "@/lib/utils";
import { Plus, Circle, CheckCircle, Clock, AlertCircle } from "lucide-react";

type TaskItem = {
  id: string;
  title: string;
  completed: boolean;
  priority: "low" | "medium" | "high";
  createdAt: number;
};

export default function TasksPage() {
  const [tasks, setTasks] = useState<TaskItem[]>([
    { id: "1", title: "Set up JARVIS AI project", completed: true, priority: "high", createdAt: Date.now() - 86400000 },
    { id: "2", title: "Integrate Gemini API", completed: false, priority: "high", createdAt: Date.now() - 43200000 },
    { id: "3", title: "Build voice interface", completed: false, priority: "medium", createdAt: Date.now() - 21600000 },
  ]);
  const [newTask, setNewTask] = useState("");

  const addTask = useCallback(() => {
    if (!newTask.trim()) return;
    setTasks([...tasks, { id: crypto.randomUUID(), title: newTask, completed: false, priority: "medium", createdAt: Date.now() }]);
    setNewTask("");
  }, [newTask, tasks]);

  const toggleTask = useCallback((id: string) => {
    setTasks((prev) => prev.map(t => t.id === id ? { ...t, completed: !t.completed } : t));
  }, []);

  const stats = useMemo(
    () => ({
      total: tasks.length,
      completed: tasks.filter(t => t.completed).length,
      pending: tasks.filter(t => !t.completed).length,
    }),
    [tasks]
  );

  return (
    <DashboardPageFrame>
      <div>
        <header className="border-b border-white/[0.03] bg-black/60 backdrop-blur-xl px-6 py-3">
          <h1 className="text-sm text-white/60">Tasks</h1>
        </header>
        <main className="p-6 max-w-4xl">
          <div className="grid grid-cols-3 gap-4 mb-6">
            <GlassCard className="p-4 text-center">
              <p className="text-2xl text-white/80 font-light">{stats.total}</p>
              <p className="text-xs text-white/30 mt-1">Total Tasks</p>
            </GlassCard>
            <GlassCard className="p-4 text-center">
              <p className="text-2xl text-green-400/80 font-light">{stats.completed}</p>
              <p className="text-xs text-white/30 mt-1">Completed</p>
            </GlassCard>
            <GlassCard className="p-4 text-center">
              <p className="text-2xl text-blue-400/80 font-light">{stats.pending}</p>
              <p className="text-xs text-white/30 mt-1">Pending</p>
            </GlassCard>
          </div>

          <GlassCard className="p-4 mb-4">
            <div className="flex items-center gap-3">
              <input
                type="text"
                value={newTask}
                onChange={(e) => setNewTask(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && addTask()}
                placeholder="Add a new task..."
                className="flex-1 bg-transparent text-sm text-white/70 placeholder:text-white/20 outline-none"
              />
              <button onClick={addTask} className="p-2 rounded-lg bg-blue-500/20 text-blue-400 hover:bg-blue-500/30 transition-all">
                <Plus className="w-4 h-4" />
              </button>
            </div>
          </GlassCard>

          <div className="space-y-2">
            {tasks.map((task) => (
              <div key={task.id} className="cv-auto">
                <GlassCard
                  variant="interactive"
                  className={cn("p-3 flex items-center gap-3", task.completed && "opacity-50")}
                  onClick={() => toggleTask(task.id)}
                >
                  {task.completed ? (
                    <CheckCircle className="w-5 h-5 text-green-400 shrink-0" />
                  ) : (
                    <Circle className="w-5 h-5 text-white/20 hover:text-white/40 shrink-0" />
                  )}
                  <span className={cn("flex-1 text-sm", task.completed ? "text-white/30 line-through" : "text-white/70")}>
                    {task.title}
                  </span>
                  {task.priority === "high" && <AlertCircle className="w-3.5 h-3.5 text-red-400" />}
                  {task.priority === "medium" && <Clock className="w-3.5 h-3.5 text-yellow-400" />}
                </GlassCard>
              </div>
            ))}
          </div>
        </main>
      </div>
    </DashboardPageFrame>
  );
}
