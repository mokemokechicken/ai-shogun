import { useCallback, useRef, useState } from "react";
import type { ShogunMessage, ThreadInfo } from "@ai-shogun/shared";
import { listMessages, selectThread } from "../api";

type SelectionOptions = {
  onError?: (message: string) => void;
};

export const useThreadSelection = ({ onError }: SelectionOptions = {}) => {
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ShogunMessage[]>([]);
  const selectedThreadRef = useRef<string | null>(null);
  const selectionTokenRef = useRef(0);
  const pendingSelectionRef = useRef<string | null>(null);

  const clearSelection = useCallback(() => {
    selectionTokenRef.current += 1;
    pendingSelectionRef.current = null;
    setSelectedThreadId(null);
    selectedThreadRef.current = null;
    setMessages([]);
  }, []);

  const selectThreadById = useCallback(
    async (threadId: string) => {
      const token = selectionTokenRef.current + 1;
      selectionTokenRef.current = token;
      pendingSelectionRef.current = threadId;
      try {
        await selectThread(threadId);
        if (selectionTokenRef.current !== token) {
          return false;
        }
        const threadMessages = await listMessages(threadId);
        if (selectionTokenRef.current !== token) {
          return false;
        }
        setSelectedThreadId(threadId);
        selectedThreadRef.current = threadId;
        setMessages(threadMessages);
        pendingSelectionRef.current = null;
        return true;
      } catch (err) {
        if (selectionTokenRef.current === token) {
          pendingSelectionRef.current = null;
          onError?.(err instanceof Error ? err.message : "スレッド選択に失敗しました");
        }
        return false;
      }
    },
    [onError]
  );

  const ensureValidSelection = useCallback(
    async (threads: ThreadInfo[]) => {
      const currentId = pendingSelectionRef.current ?? selectedThreadRef.current;
      if (currentId && threads.some((thread) => thread.id === currentId)) return;
      clearSelection();
      if (threads.length > 0) {
        await selectThreadById(threads[0].id);
      }
    },
    [clearSelection, selectThreadById]
  );

  const refreshMessages = useCallback(async (threadId: string) => {
    const token = selectionTokenRef.current;
    const threadMessages = await listMessages(threadId);
    if (
      selectionTokenRef.current !== token ||
      selectedThreadRef.current !== threadId ||
      pendingSelectionRef.current
    ) {
      return false;
    }
    setMessages(threadMessages);
    return true;
  }, []);

  const syncSelectionOnReconnect = useCallback(
    async (threads: ThreadInfo[]) => {
      const currentId = pendingSelectionRef.current ?? selectedThreadRef.current;
      if (currentId && threads.some((thread) => thread.id === currentId) && !pendingSelectionRef.current) {
        const token = selectionTokenRef.current;
        const threadMessages = await listMessages(currentId);
        if (selectionTokenRef.current !== token || pendingSelectionRef.current) {
          return false;
        }
        setMessages(threadMessages);
        return true;
      }
      await ensureValidSelection(threads);
      return true;
    },
    [ensureValidSelection]
  );

  return {
    selectedThreadId,
    messages,
    setMessages,
    selectedThreadRef,
    pendingSelectionRef,
    selectThread: selectThreadById,
    ensureValidSelection,
    refreshMessages,
    syncSelectionOnReconnect
  };
};
