"use client";

import { useEffect, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import { Mic, Sparkles, ArrowRight } from "lucide-react";
import { cn } from "@/lib/utils";

const HeroScene = dynamic(
  () =>
    import("@/components/landing/glowing-orb").then((m) => m.HeroScene),
  { ssr: false, loading: () => <div className="fixed inset-0 z-0" /> }
);

const taglines = [
  "See. Hear. Understand. Act.",
  "Your intelligent companion.",
  "Beyond conversation.",
  "The future of assistance.",
];

export default function LandingPage() {
  const router = useRouter();
  const [mounted, setMounted] = useState(false);
  const [taglineIndex, setTaglineIndex] = useState(0);
  const [showUI, setShowUI] = useState(false);

  useEffect(() => {
    setMounted(true);
    const timeout = setTimeout(() => setShowUI(true), 1500);
    const taglineInterval = setInterval(() => {
      setTaglineIndex((i) => (i + 1) % taglines.length);
    }, 3000);
    return () => {
      clearTimeout(timeout);
      clearInterval(taglineInterval);
    };
  }, []);

  if (!mounted) return null;

  return (
    <main className="relative min-h-screen bg-black overflow-hidden">
      <HeroScene />

      <AnimatePresence>
        {showUI && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 1.5 }}
            className="relative z-10 flex flex-col items-center justify-center min-h-screen px-4"
          >
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.5, duration: 0.8 }}
              className="text-center mb-8"
            >
              <motion.div
                className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full glass mb-6"
                initial={{ opacity: 0, scale: 0.9 }}
                animate={{ opacity: 1, scale: 1 }}
                transition={{ delay: 0.8 }}
              >
                <Sparkles className="w-3 h-3 text-blue-400" />
                <span className="text-xs text-blue-300/80 tracking-widest uppercase">
                  AI Operating System
                </span>
              </motion.div>

              <h1 className="text-6xl sm:text-7xl md:text-8xl lg:text-9xl font-bold tracking-tight mb-4">
                <span className="text-gradient text-glow">JARVIS</span>
              </h1>

              <div className="h-8 overflow-hidden">
                <AnimatePresence mode="wait">
                  <motion.p
                    key={taglineIndex}
                    initial={{ opacity: 0, y: 20 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -20 }}
                    transition={{ duration: 0.4 }}
                    className="text-lg sm:text-xl text-white/50 font-light"
                  >
                    {taglines[taglineIndex]}
                  </motion.p>
                </AnimatePresence>
              </div>
            </motion.div>

            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 1.2, duration: 0.8 }}
              className="flex flex-col sm:flex-row items-center gap-4"
            >
              <button
                onClick={() => router.push("/dashboard")}
                className="btn-sheen group relative px-8 py-3.5 rounded-full bg-gradient-to-r from-blue-600 to-blue-500 text-white font-medium text-sm tracking-wide overflow-hidden transition-all duration-300 hover:shadow-[0_0_40px_rgba(56,189,248,0.5)]"
              >
                <span className="relative z-10 flex items-center gap-2">
                  Launch JARVIS
                  <ArrowRight className="w-4 h-4 transition-transform group-hover:translate-x-1" />
                </span>
                <div className="absolute inset-0 bg-gradient-to-r from-blue-500 to-cyan-500 opacity-0 group-hover:opacity-100 transition-opacity duration-300" />
              </button>

              <button className="group flex items-center gap-3 px-6 py-3 rounded-full glass glass-hover transition-all duration-300">
                <div className="w-8 h-8 rounded-full bg-blue-500/20 flex items-center justify-center group-hover:bg-blue-500/30 transition-colors">
                  <Mic className="w-4 h-4 text-blue-400" />
                </div>
                <div className="text-left">
                  <p className="text-xs text-white/40">Say</p>
                  <p className="text-sm text-white/80 font-medium">
                    &ldquo;Hey Jarvis&rdquo;
                  </p>
                </div>
              </button>
            </motion.div>

            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ delay: 2, duration: 1 }}
              className="absolute bottom-8 flex gap-2"
            >
              {[0, 1, 2, 3].map((i) => (
                <motion.div
                  key={i}
                  className="w-1.5 h-1.5 rounded-full bg-blue-400/30"
                  animate={{ opacity: [0.3, 1, 0.3] }}
                  transition={{
                    duration: 2,
                    repeat: Infinity,
                    delay: i * 0.3,
                  }}
                />
              ))}
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      <div className="fixed inset-0 pointer-events-none noise-bg z-20" />
    </main>
  );
}
