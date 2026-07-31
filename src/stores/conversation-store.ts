import { create } from "zustand";
import type { AIState, AIMessage, Conversation } from "@/types";

interface ConversationStore {
  state: AIState;
  conversations: Conversation[];
  activeConversationId: string | null;
  messages: AIMessage[];
  transcription: string;
  setState: (state: AIState) => void;
  addMessage: (message: AIMessage) => void;
  setMessages: (messages: AIMessage[]) => void;
  setTranscription: (text: string) => void;
  createConversation: () => void;
  switchConversation: (id: string) => void;
}

export const useConversationStore = create<ConversationStore>((set, get) => ({
  state: "idle",
  conversations: [],
  activeConversationId: null,
  messages: [],
  transcription: "",
  setState: (state) => set({ state }),
  addMessage: (message) =>
    set((s) => {
      const activeId = s.activeConversationId;
      if (!activeId) return { messages: [...s.messages, message] };
      const now = Date.now();
      return {
        messages: [...s.messages, message],
        conversations: s.conversations.map((c) =>
          c.id === activeId
            ? {
                ...c,
                messages: [...c.messages, message],
                updatedAt: now,
              }
            : c
        ),
      };
    }),
  setMessages: (messages) => set({ messages }),
  setTranscription: (transcription) => set({ transcription }),
  createConversation: () => {
    const id = crypto.randomUUID();
    const conv: Conversation = {
      id,
      title: "New Conversation",
      messages: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    set((s) => ({
      conversations: [...s.conversations, conv],
      activeConversationId: id,
      messages: [],
    }));
  },
  switchConversation: (id) => {
    const conv = get().conversations.find((c) => c.id === id);
    if (conv) {
      set({
        activeConversationId: id,
        messages: conv.messages,
      });
    }
  },
}));
