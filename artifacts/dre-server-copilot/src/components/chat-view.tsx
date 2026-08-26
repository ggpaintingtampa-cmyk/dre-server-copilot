import React from 'react';
import { cn } from '@/lib/utils';
import { useAgentChat } from '@/hooks/use-agent-chat';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Send, Bot, User, KeyRound, RotateCcw } from 'lucide-react';
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
  const { streamingMessage, isStreaming, sendMessage } = useAgentChat();
  const [input, setInput] = React.useState('');
  const [tokenInput, setTokenInput] = React.useState('');
  const [allowServerChecks, setAllowServerChecks] = React.useState(false);
  const scrollRef = React.useRef<HTMLDivElement>(null);

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
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [history, streamingMessage]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim() || isStreaming) return;
    sendMessage(sessionId, input, allowServerChecks, refreshHistory);
    setInput('');
  };

  const saveToken = (event: React.FormEvent) => {
    event.preventDefault();
    setAgentToken(tokenInput);
    setTokenInput('');
    onTokenSaved();
  };

  const startNewChat = () => {
    onSessionChanged(beginNewSession());
  };

  return (
    <div className="flex flex-col h-full bg-background relative">
      <div className="flex-1 overflow-y-auto p-4 space-y-4 pb-32" ref={scrollRef}>
        {!tokenConfigured ? (
          <div className="mx-auto mt-8 max-w-sm rounded-xl border border-border bg-card p-4 text-center">
            <KeyRound className="mx-auto mb-3 h-6 w-6 text-primary" />
            <p className="text-sm font-semibold">Enter the DRE access token</p>
            <p className="mt-1 text-xs text-muted-foreground">Stored only for this browser session.</p>
            <form className="mt-3 flex gap-2" onSubmit={saveToken}>
              <input className="sr-only" name="username" autoComplete="username" tabIndex={-1} aria-hidden="true" />
              <Input name="dre-agent-token" value={tokenInput} onChange={(event) => setTokenInput(event.target.value)} placeholder="DRE_AGENT_TOKEN" type="password" autoComplete="current-password" />
              <Button type="submit" size="sm" disabled={!tokenInput.trim()}>Save</Button>
            </form>
          </div>
        ) : historyError ? (
          <div className="text-center text-destructive text-sm py-10">{historyError}</div>
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
              "max-w-[85%] rounded-lg px-4 py-2 text-sm",
              msg.role === 'user' 
                ? "bg-primary text-primary-foreground rounded-br-none" 
                : "bg-card border border-border text-card-foreground rounded-bl-none prose prose-sm dark:prose-invert prose-p:my-1 prose-pre:my-0 prose-pre:bg-muted prose-pre:text-muted-foreground max-w-full overflow-hidden break-words"
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
            <div className="max-w-[85%] rounded-lg px-4 py-2 text-sm bg-card border border-border text-card-foreground rounded-bl-none prose prose-sm dark:prose-invert max-w-full break-words">
              <AssistantText>{streamingMessage}</AssistantText>
              <span className="inline-block w-1.5 h-4 ml-1 bg-primary animate-pulse align-middle"></span>
            </div>
          </div>
        )}
      </div>

      <div className="absolute bottom-0 left-0 right-0 p-4 bg-gradient-to-t from-background via-background to-transparent pb-safe">
        <form 
          onSubmit={handleSubmit}
          className="flex items-end gap-2 bg-card border border-border p-2 rounded-xl shadow-lg relative z-10"
        >
          <Input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Instruct the agent..."
            className="border-0 focus-visible:ring-0 shadow-none bg-transparent"
            disabled={isStreaming || !tokenConfigured}
          />
          <Button 
            type="submit" 
            size="icon" 
            disabled={!input.trim() || isStreaming || !tokenConfigured}
            className="shrink-0 rounded-lg h-9 w-9"
          >
            <Send className="w-4 h-4" />
          </Button>
        </form>
        <div className="mt-2 flex items-center justify-between gap-2 px-2">
          <label className="flex items-center gap-2 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
          <input
            type="checkbox"
            checked={allowServerChecks}
            onChange={(event) => setAllowServerChecks(event.target.checked)}
            disabled={isStreaming}
            className="h-3.5 w-3.5 accent-primary"
          />
          Allow guarded server checks for this chat
          </label>
          <Button type="button" variant="ghost" size="sm" className="h-6 px-2 text-[10px] uppercase" onClick={startNewChat} disabled={!tokenConfigured}>
            <RotateCcw className="mr-1 h-3 w-3" /> New chat
          </Button>
        </div>
      </div>
    </div>
  );
}
