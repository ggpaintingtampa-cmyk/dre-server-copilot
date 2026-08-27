import { useState, useCallback, useEffect, useRef } from 'react';
import { readableMessage, sendChat } from '@/lib/dre-api';

export function useAgentChat() {
  const [streamingMessage, setStreamingMessage] = useState<string>('');
  const [isStreaming, setIsStreaming] = useState(false);
  const [streamError, setStreamError] = useState<string | null>(null);
  const requestGenerationRef = useRef(0);
  const activeControllerRef = useRef<AbortController | null>(null);

  const resetTransientState = useCallback(() => {
    requestGenerationRef.current += 1;
    activeControllerRef.current?.abort();
    activeControllerRef.current = null;
    setStreamingMessage('');
    setStreamError(null);
    setIsStreaming(false);
  }, []);

  useEffect(() => resetTransientState, [resetTransientState]);

  const sendMessage = useCallback(async (
    sessionId: string,
    content: string,
    executeCommands: boolean = false,
    onActivity?: () => void,
  ) => {
    const generation = requestGenerationRef.current + 1;
    requestGenerationRef.current = generation;
    activeControllerRef.current?.abort();
    const controller = new AbortController();
    activeControllerRef.current = controller;
    setIsStreaming(true);
    setStreamingMessage('');
    setStreamError(null);

    const isCurrentRequest = () => requestGenerationRef.current === generation;
    try {
      await sendChat(sessionId, content, executeCommands, (data) => {
        if (!isCurrentRequest()) return;
        if (typeof data.content === 'string') setStreamingMessage((previous) => previous + data.content);
        if (data.error !== undefined) setStreamError(readableMessage(data.error));
        if (data.type === 'tool') onActivity?.();
      }, controller.signal);
    } catch (err) {
      if (isCurrentRequest() && !controller.signal.aborted) {
        setStreamError(readableMessage(err instanceof Error ? err.message : err, 'Connection interrupted'));
      }
    } finally {
      if (isCurrentRequest()) {
        activeControllerRef.current = null;
        setIsStreaming(false);
        onActivity?.();
      }
    }
  }, []);

  return { streamingMessage, isStreaming, streamError, sendMessage, resetTransientState };
}
