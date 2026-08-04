/**
 * OS-level system collector. Runs on the Node server only; returns `null` in
 * browser contexts. Every read is guarded and never throws — a failed probe
 * degrades to `null` rather than crashing the pipeline.
 */

import os from "os";
import { isBrowser } from "../util/env";
import type { CpuInfo, DiskInfo, MemoryInfo, NetworkInfo, SystemInfo, SystemSnapshot } from "./types";

const CPU_SAMPLE_MIN_GAP_MS = 1_000;

interface CpuSample {
  busy: number;
  idle: number;
  at: number;
}

let previousCpu: CpuSample | null = null;

function readCpuTimes(): CpuSample {
  const cpus = os.cpus();
  let busy = 0;
  let idle = 0;
  for (const cpu of cpus) {
    idle += cpu.times.idle;
    busy += cpu.times.user + cpu.times.nice + cpu.times.sys + cpu.times.irq;
  }
  return { busy, idle, at: Date.now() };
}

function cpuLoadPercent(): number {
  const current = readCpuTimes();
  if (!previousCpu) {
    previousCpu = current;
    return 0;
  }
  const gapMs = current.at - previousCpu.at;
  if (gapMs < CPU_SAMPLE_MIN_GAP_MS) return 0;
  const totalDelta = current.busy + current.idle - (previousCpu.busy + previousCpu.idle);
  const idleDelta = current.idle - previousCpu.idle;
  previousCpu = current;
  if (totalDelta <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round(((totalDelta - idleDelta) / totalDelta) * 100)));
}

function cpuInfo(): CpuInfo {
  const cpus = os.cpus();
  return {
    loadPercent: cpuLoadPercent(),
    cores: cpus.length,
    model: cpus[0]?.model ?? null,
  };
}

function memoryInfo(): MemoryInfo {
  const totalBytes = os.totalmem();
  const freeBytes = os.freemem();
  const usedBytes = totalBytes - freeBytes;
  return {
    totalBytes,
    freeBytes,
    usedBytes,
    usedPercent: totalBytes > 0 ? Math.round((usedBytes / totalBytes) * 100) : 0,
  };
}

async function diskInfo(): Promise<DiskInfo> {
  try {
    const fs = await import("fs");
    const stat = await fs.promises.statfs(process.cwd());
    const totalBytes = stat.blocks * stat.bsize;
    const freeBytes = stat.bfree * stat.bsize;
    return {
      totalBytes,
      freeBytes,
      usedPercent: totalBytes > 0 ? Math.round(((totalBytes - freeBytes) / totalBytes) * 100) : null,
      mount: process.cwd(),
    };
  } catch {
    return { totalBytes: null, freeBytes: null, usedPercent: null, mount: process.cwd() };
  }
}

function networkInfo(): NetworkInfo {
  const interfaces = os.networkInterfaces();
  let count = 0;
  let ipv4: string | null = null;
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries ?? []) {
      if (entry.internal) continue;
      if (entry.family === "IPv4") {
        count++;
        if (!ipv4) ipv4 = entry.address;
      }
    }
  }
  return { hostname: os.hostname(), interfaces: count, ipv4 };
}

function systemInfo(): SystemInfo {
  return {
    platform: process.platform,
    arch: os.arch(),
    osRelease: os.release(),
    hostname: os.hostname(),
    uptimeS: Math.floor(os.uptime()),
    loadAvg: os.loadavg().map((n) => Math.round(n * 100) / 100),
  };
}

/** Collect a full OS snapshot. Never throws. */
export async function collectSystemSnapshot(): Promise<SystemSnapshot | null> {
  if (isBrowser()) return null;
  const [disk] = await Promise.all([diskInfo()]);
  return {
    collectedAt: Date.now(),
    cpu: cpuInfo(),
    memory: memoryInfo(),
    disk,
    network: networkInfo(),
    system: systemInfo(),
  };
}
