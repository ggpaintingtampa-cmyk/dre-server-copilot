import React from 'react';
import { cn } from '@/lib/utils';
import { useAgentChat } from '@/hooks/use-agent-chat';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Send, Bot, User, KeyRound, RotateCcw, ArrowDown } from 'lucide-react';
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
  const { streamingMessage, isStreaming, streamError, sendMessage } = useAgentChat();
  const [input, setInput] = React.useState('');
  const [tokenInput, setTokenInput] = React.useState('');
  const [allowServerChecks, setAllowServerChecks] = React.useState(false);
  const scrollRef = React.useRef<HTMLDivElement>(null);
  const stickToBottomRef = React.useRef(true);
  const [showScrollButton, setShowScrollButton] = React.useState(false);

  const refreshHistory = React.useCallback(() => {
    if (!tokenConfigured) {
      setHistory([]);
      return;
    }
    void getHistory(sessionId)
      .then((messages) => {
        setHistory(messages);
        setHistoryError('');
      })
      .catch((error: Error) => setHistoryError(error.message));
  }, [sessionId, tokenConfigured]);

  React.useEffect(() => {
    refreshHistory();
    const timer = window.setInterval(refreshHistory, 5000);
    return () => window.clearInterval(timer);
  }, [refreshHistory]);

  React.useEffect(() => {
    if (scrollRef.current && stickToBottomRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [history, streamingMessage]);

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
    sendMessage(sessionId, input, allowServerChecks, refreshHistory);
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
    setHistory([]);
    setHistoryError('');
    onSessionChanged(beginNewSession());
  };

  return (
    <div className="flex h-full min-h-0 flex-col bg-background/80 relative">
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-3 sm:p-4 space-y-4 pb-44" ref={scrollRef} onScroll={handleScroll}>
        {!tokenConfigured ? (
          <div className="matrix-panel mx-auto mt-6 max-w-sm rounded-lg border border-border p-4 text-center">
            <KeyRound className="mx-auto mb-3 h-6 w-6 text-primary" />
            <p className="text-sm font-semibold">Enter the DRE access token</p>
            <p className="mt-1 text-xs text-muted-foreground">Stored only for this browser session.</p>
            <form className="mt-3 flex items-stretch gap-2" onSubmit={saveToken}>
              <input className="sr-only" name="username" autoComplete="username" tabIndex={-1} aria-hidden="true" />
              <Input className="min-w-0 flex-1" name="dre-agent-token" value={tokenInput} onChange={(event) => setTokenInput(event.target.value)} placeholder="DRE_AGENT_TOKEN" type="password" autoComplete="current-password" aria-label="DRE access token" />
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
                <AssistantText>{msg.content}</AssistantText>
              )}
            </div>

            {msg.role === 'user' && (
              <div className="w-8 h-8 rounded-full bg-primary/20 border border-primary/30 flex items-center justify-center shrink-0">
                <User className="w-4 h-4 text-primary" />
              </div>
            )}
          </div>
        ))}

        {streamingMessage && (
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
      </div>

      {showScrollButton && (
        <Button type="button" variant="outline" size="sm" className="absolute bottom-36 right-4 z-20 h-8 rounded-full bg-card/95 px-3 text-[10px] uppercase shadow-lg" onClick={scrollToBottom}>
          <ArrowDown className="mr-1.5 h-3 w-3" /> Latest
        </Button>
      )}

      <div className="absolute bottom-0 left-0 right-0 p-3 sm:p-4 bg-gradient-to-t from-background via-background/95 to-transparent pb-safe">
        <form 
          onSubmit={handleSubmit}
          className="matrix-panel matrix-focus flex items-end gap-2 rounded-lg border border-border p-2 shadow-lg relative z-10"
        >
          <Textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleComposerKeyDown}
            placeholder="Instruct the agent… (Shift+Enter for a new line)"
            className="min-h-20 max-h-[30vh] flex-1 resize-none overflow-y-auto border-0 bg-transparent px-2 py-1.5 text-base leading-relaxed shadow-none focus-visible:ring-0"
            disabled={isStreaming || !tokenConfigured}
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
            checked={allowServerChecks}
            onChange={(event) => setAllowServerChecks(event.target.checked)}
            disabled={isStreaming}
            className="h-3.5 w-3.5 accent-primary"
          />
           Guarded checks
          </label>
          <Button type="button" variant="ghost" size="sm" className="h-6 px-2 text-[10px] uppercase" onClick={startNewChat} disabled={!tokenConfigured}>
            <RotateCcw className="mr-1 h-3 w-3" /> New chat
          </Button>
        </div>
      </div>
    </div>
  );
}
