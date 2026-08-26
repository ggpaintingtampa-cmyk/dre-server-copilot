import { useState, useCallback } from 'react';
import { sendChat } from '@/lib/dre-api';

export function useAgentChat() {
  const [streamingMessage, setStreamingMessage] = useState<string>('');
  const [isStreaming, setIsStreaming] = useState(false);
  const [streamError, setStreamError] = useState<string | null>(null);

  const sendMessage = useCallback(async (
    sessionId: string,
    content: string,
    executeCommands: boolean = false,
    onActivity?: () => void,
  ) => {
    setIsStreaming(true);
    setStreamingMessage('');
    setStreamError(null);
    
    // We add a temporary user message so it feels responsive instantly
    // We'll just rely on the stream and history invalidation for the rest.
    
    try {
      await sendChat(sessionId, content, executeCommands, (data) => {
        if (data.content) setStreamingMessage((previous) => previous + data.content);
        if (data.error) setStreamError(data.error);
        if (data.type === 'tool') onActivity?.();
      });
    } catch (err) {
      setStreamError(err instanceof Error ? err.message : 'Connection interrupted');
    } finally {
      setIsStreaming(false);
      onActivity?.();
    }
  }, []);
  
  return { streamingMessage, isStreaming, streamError, sendMessage };
}
