"use client";

type InterruptHandler = () => void;

let handler: InterruptHandler | null = null;

export function registerInterruptHandler(next: InterruptHandler | null): void {
  handler = next;
}

export function triggerInterrupt(): void {
  if (handler) {
    handler();
  }
}
