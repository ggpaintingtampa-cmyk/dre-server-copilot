import React from 'react';
import { cn } from '@/lib/utils';
import { useAgentChat } from '@/hooks/use-agent-chat';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Send, Bot, User, KeyRound, RotateCcw, ArrowDown, Copy, Check } from 'lucide-react';
import { beginNewSession, getHistory, setAgentToken, type ChatMessage } from '@/lib/dre-api';

function AssistantText({ children }: { children: string }) {
  return <div className="whitespace-pre-wrap break-words">{children}</div>;
}

export function ChatView({
  sessionId,
  tokenConfigured,
  onTokenSaved,
  onSessionChanged,
}: {
  sessionId: string;
  tokenConfigured: boolean;
  onTokenSaved: () => void;
  onSessionChanged: (sessionId: string) => void;
}) {
  const [history, setHistory] = React.useState<ChatMessage[]>([]);
  const [historyError, setHistoryError] = React.useState('');
  const { streamingMessage, isStreaming, streamError, sendMessage, resetTransientState } = useAgentChat();
  const [input, setInput] = React.useState('');
  const [tokenInput, setTokenInput] = React.useState('');
  const [allowServerTools, setAllowServerTools] = React.useState(false);
  const [copiedMessageId, setCopiedMessageId] = React.useState<string | null>(null);
  const [copyError, setCopyError] = React.useState('');
  const scrollRef = React.useRef<HTMLDivElement>(null);
  const bottomAnchorRef = React.useRef<HTMLDivElement>(null);
  const composerRef = React.useRef<HTMLTextAreaElement>(null);
  const stickToBottomRef = React.useRef(true);
  const historyRequestGenerationRef = React.useRef(0);
  const previousTokenConfiguredRef = React.useRef(tokenConfigured);
  const [showScrollButton, setShowScrollButton] = React.useState(false);

  const refreshHistory = React.useCallback(() => {
    const generation = historyRequestGenerationRef.current + 1;
    historyRequestGenerationRef.current = generation;
    if (!tokenConfigured) {
      setHistory([]);
      return;
    }
    void getHistory(sessionId)
      .then((messages) => {
        if (historyRequestGenerationRef.current !== generation) return;
        setHistory(messages);
        setHistoryError('');
      })
      .catch((error: Error) => {
        if (historyRequestGenerationRef.current === generation) {
          setHistoryError(error.message);
        }
      });
  }, [sessionId, tokenConfigured]);

  React.useEffect(() => {
    refreshHistory();
    const timer = window.setInterval(refreshHistory, 5000);
    return () => window.clearInterval(timer);
  }, [refreshHistory]);

  React.useLayoutEffect(() => {
    if (stickToBottomRef.current) {
      bottomAnchorRef.current?.scrollIntoView({ block: 'end' });
    }
  }, [history, streamingMessage]);

  React.useEffect(() => {
    const wasConfigured = previousTokenConfiguredRef.current;
    previousTokenConfiguredRef.current = tokenConfigured;
    if (tokenConfigured && !wasConfigured) {
      window.requestAnimationFrame(() => composerRef.current?.focus());
    }
  }, [tokenConfigured]);

  React.useLayoutEffect(() => {
    const composer = composerRef.current;
    if (!composer) return;
    composer.style.height = 'auto';
    const maxHeight = Math.max(96, Math.floor(window.innerHeight * 0.3));
    composer.style.height = `${Math.min(composer.scrollHeight, maxHeight)}px`;
    composer.style.overflowY = composer.scrollHeight > maxHeight ? 'auto' : 'hidden';
  }, [input]);

  const handleScroll = () => {
    const element = scrollRef.current;
    if (!element) return;
    const distanceFromBottom = element.scrollHeight - element.scrollTop - element.clientHeight;
    const atBottom = distanceFromBottom < 64;
    stickToBottomRef.current = atBottom;
    setShowScrollButton(!atBottom);
  };

  const scrollToBottom = () => {
    const element = scrollRef.current;
    if (!element) return;
    stickToBottomRef.current = true;
    element.scrollTo({ top: element.scrollHeight, behavior: 'smooth' });
    setShowScrollButton(false);
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim() || isStreaming) return;
    void sendMessage(sessionId, input, allowServerTools, refreshHistory);
    setInput('');
    stickToBottomRef.current = true;
  };

  const handleComposerKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      event.currentTarget.form?.requestSubmit();
    }
  };

  const saveToken = (event: React.FormEvent) => {
    event.preventDefault();
    setAgentToken(tokenInput);
    setTokenInput('');
    onTokenSaved();
  };

  const startNewChat = () => {
    historyRequestGenerationRef.current += 1;
    setHistory([]);
    setHistoryError('');
    setInput('');
    resetTransientState();
    onSessionChanged(beginNewSession());
  };

  const copyAnswer = async (message: ChatMessage) => {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(message.content);
      } else {
        const fallback = document.createElement('textarea');
        fallback.value = message.content;
        fallback.style.position = 'fixed';
        fallback.style.opacity = '0';
        document.body.appendChild(fallback);
        fallback.select();
        const copied = document.execCommand('copy');
        document.body.removeChild(fallback);
        if (!copied) throw new Error('Copy was unavailable.');
      }
      setCopyError('');
      setCopiedMessageId(message.id);
      window.setTimeout(() => setCopiedMessageId((current) => current === message.id ? null : current), 1600);
    } catch {
      setCopyError('Copy failed. You can still select the response text.');
    }
  };

  const persistedStreamingMessage = streamingMessage
    ? history.some((message) => message.role === 'assistant' && message.content === streamingMessage)
    : false;
  const showStreamingMessage = Boolean(streamingMessage) && !persistedStreamingMessage;

  return (
    <div className="flex h-full min-h-0 flex-col bg-background/80 relative">
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-3 sm:p-4 space-y-4" ref={scrollRef} onScroll={handleScroll}>
        {!tokenConfigured ? (
          <div className="matrix-panel mx-auto mt-6 max-w-sm rounded-lg border border-border p-4 text-center">
            <KeyRound className="mx-auto mb-3 h-6 w-6 text-primary" />
            <p className="text-sm font-semibold">Enter the DRE access token</p>
            <p className="mt-1 text-xs text-muted-foreground">Stored only for this browser session.</p>
            <form className="mt-3 flex items-stretch gap-2" onSubmit={saveToken}>
              <input className="sr-only" name="username" autoComplete="username" tabIndex={-1} aria-hidden="true" />
              <Input className="min-w-0 flex-1 text-base" name="dre-agent-token" value={tokenInput} onChange={(event) => setTokenInput(event.target.value)} placeholder="DRE_AGENT_TOKEN" type="password" autoComplete="current-password" autoCapitalize="none" autoCorrect="off" spellCheck={false} aria-label="DRE access token" />
              <Button type="submit" size="sm" className="min-h-9 shrink-0" disabled={!tokenInput.trim()}>Save</Button>
            </form>
          </div>
        ) : historyError ? (
          <div className="matrix-panel mx-auto mt-6 max-w-sm rounded-lg border border-destructive/40 bg-destructive/10 p-4 text-center text-sm text-destructive">{historyError}</div>
        ) : history.length === 0 && !streamingMessage ? (
          <div className="flex flex-col items-center justify-center h-full text-muted-foreground opacity-50">
            <Bot className="w-12 h-12 mb-4" />
            <p className="text-sm">Agent ready for instructions.</p>
          </div>
        ) : null}

        {history.map((msg) => (
          <div
            key={msg.id}
            className={cn(
              "flex w-full gap-3",
              msg.role === 'user' ? "justify-end" : "justify-start"
            )}
          >
            {msg.role !== 'user' && (
              <div className="w-8 h-8 rounded-full bg-secondary border border-border flex items-center justify-center shrink-0">
                <Bot className="w-4 h-4 text-primary" />
              </div>
            )}
            
            <div className={cn(
              "min-w-0 max-w-[90%] select-text rounded-lg px-3 py-2.5 text-sm leading-relaxed sm:px-4",
              msg.role === 'user' 
                ? "bg-primary text-primary-foreground rounded-br-none" 
                : "matrix-panel border border-border text-card-foreground rounded-bl-none max-w-full overflow-visible break-words [overflow-wrap:anywhere]"
            )}>
              {msg.role === 'user' ? (
                <div className="whitespace-pre-wrap break-words">{msg.content}</div>
              ) : (
                <div className="flex min-w-0 items-start gap-2">
                  <AssistantText>{msg.content}</AssistantText>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7 shrink-0 text-muted-foreground hover:text-primary"
                    onClick={() => void copyAnswer(msg)}
                    aria-label={copiedMessageId === msg.id ? 'Response copied' : 'Copy response'}
                    title={copiedMessageId === msg.id ? 'Copied' : 'Copy response'}
                  >
                    {copiedMessageId === msg.id ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                  </Button>
                </div>
              )}
            </div>

            {msg.role === 'user' && (
              <div className="w-8 h-8 rounded-full bg-primary/20 border border-primary/30 flex items-center justify-center shrink-0">
                <User className="w-4 h-4 text-primary" />
              </div>
            )}
          </div>
        ))}

        {showStreamingMessage && (
          <div className="flex w-full gap-3 justify-start animate-in fade-in slide-in-from-bottom-2">
            <div className="w-8 h-8 rounded-full bg-secondary border border-border flex items-center justify-center shrink-0">
              <Bot className="w-4 h-4 text-primary animate-pulse" />
            </div>
            <div className="matrix-panel min-w-0 max-w-[90%] select-text rounded-lg px-3 py-2.5 text-sm leading-relaxed text-card-foreground border border-border rounded-bl-none break-words [overflow-wrap:anywhere]">
              <AssistantText>{streamingMessage}</AssistantText>
              <span className="inline-block w-1.5 h-4 ml-1 bg-primary animate-pulse align-middle"></span>
            </div>
          </div>
        )}
        <div ref={bottomAnchorRef} aria-hidden="true" className="h-px" />
      </div>

      {showScrollButton && (
        <Button type="button" variant="outline" size="sm" className="absolute bottom-36 right-4 z-20 h-8 rounded-full bg-card/95 px-3 text-[10px] uppercase shadow-lg" onClick={scrollToBottom}>
          <ArrowDown className="mr-1.5 h-3 w-3" /> Latest
        </Button>
      )}

      <div className="flex-none bg-gradient-to-t from-background via-background/95 to-transparent p-3 pt-5 sm:p-4 sm:pt-5 pb-safe">
        {!tokenConfigured && (
          <p id="composer-lock-message" className="mb-2 px-1 text-xs text-muted-foreground">
            Save the DRE access token above to unlock messaging.
          </p>
        )}
        <form 
          onSubmit={handleSubmit}
          className="matrix-panel matrix-focus flex items-end gap-2 rounded-lg border border-border p-2 shadow-lg relative z-10"
        >
          <Textarea
            ref={composerRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleComposerKeyDown}
            placeholder={tokenConfigured ? "Instruct the agent… (Shift+Enter for a new line)" : "Save the access token above to begin"}
            className="min-h-20 max-h-[30vh] flex-1 resize-none overflow-y-auto border-0 bg-transparent px-2 py-1.5 text-base leading-relaxed shadow-none focus-visible:ring-0"
            disabled={isStreaming || !tokenConfigured}
            aria-describedby={tokenConfigured ? undefined : 'composer-lock-message'}
            aria-label="Message the DRE agent"
          />
          <Button 
            type="submit" 
            size="icon" 
            disabled={!input.trim() || isStreaming || !tokenConfigured}
            className="h-10 w-10 shrink-0 rounded-lg"
          >
            <Send className="w-4 h-4" />
          </Button>
        </form>
        {streamError && <div className="mt-2 rounded-md border border-destructive/30 bg-destructive/10 px-2.5 py-1.5 text-xs text-destructive">{streamError}</div>}
        <div className="mt-2 flex items-center justify-between gap-2 px-1">
          <label className="flex min-h-7 items-center gap-2 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
          <input
            type="checkbox"
             checked={allowServerTools}
             onChange={(event) => setAllowServerTools(event.target.checked)}
            disabled={isStreaming}
            className="h-3.5 w-3.5 accent-primary"
          />
            Allow server tools
          </label>
          <Button type="button" variant="ghost" size="sm" className="h-6 px-2 text-[10px] uppercase" onClick={startNewChat} disabled={!tokenConfigured}>
            <RotateCcw className="mr-1 h-3 w-3" /> New chat
          </Button>
        </div>
        {copyError && <div className="mt-2 px-1 text-xs text-destructive">{copyError}</div>}
      </div>
    </div>
  );
}
