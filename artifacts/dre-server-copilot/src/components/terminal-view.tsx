import React, { useState, useRef, useEffect, useCallback } from 'react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Play, Copy, CheckCircle2, Terminal as TerminalIcon, Bot, UserRound, MonitorCog } from 'lucide-react';
import { cn } from '@/lib/utils';
import { executeCommand, getShellHistory, subscribeToEvents, type ShellEvent } from '@/lib/dre-api';

export function TerminalView({ sessionId, tokenConfigured }: { sessionId: string; tokenConfigured: boolean }) {
  const [events, setEvents] = useState<ShellEvent[]>([]);
  const [error, setError] = useState('');
  const [isExecuting, setIsExecuting] = useState(false);
  const [command, setCommand] = useState('');
  const [copied, setCopied] = useState(false);
  const [followingLatest, setFollowingLatest] = useState(true);
  const scrollRef = useRef<HTMLDivElement>(null);

  const refresh = useCallback(() => {
    if (!tokenConfigured) return;
    void getShellHistory(sessionId)
      .then((history) => {
        setEvents((current) => shellHistoryMatches(current, history) ? current : history);
        setError('');
      })
      .catch((requestError: Error) => setError(requestError.message));
  }, [sessionId, tokenConfigured]);

  useEffect(() => {
    refresh();
    const unsubscribe = tokenConfigured ? subscribeToEvents(sessionId, refresh) : undefined;
    const timer = window.setInterval(refresh, 4000);
    return () => { unsubscribe?.(); window.clearInterval(timer); };
  }, [refresh, sessionId, tokenConfigured]);

  useEffect(() => {
    if (!followingLatest || !scrollRef.current) return;
    const frame = window.requestAnimationFrame(() => {
      if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    });
    return () => window.cancelAnimationFrame(frame);
  }, [events, followingLatest]);

  const updateScrollPosition = () => {
    const container = scrollRef.current;
    if (!container) return;
    setFollowingLatest(container.scrollHeight - container.scrollTop - container.clientHeight < 32);
  };

  const showLatest = () => {
    const container = scrollRef.current;
    if (!container) return;
    container.scrollTop = container.scrollHeight;
    setFollowingLatest(true);
  };

  const handleCopy = () => {
    if (events.length) {
      navigator.clipboard.writeText(events.map((event) => `[${event.origin.toUpperCase()}] $ ${event.command}\n${event.output}`).join('\n\n'));
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  const handleExecute = (e: React.FormEvent) => {
    e.preventDefault();
    if (!command.trim() || isExecuting || !tokenConfigured) return;
    setIsExecuting(true);
    void executeCommand(sessionId, command.trim())
      .then(() => { setCommand(''); refresh(); })
      .catch((requestError: Error) => setError(requestError.message))
      .finally(() => setIsExecuting(false));
  };

  return (
    <div className="flex h-full min-h-0 flex-col bg-background/80 relative">
      <div className="min-h-0 flex-1 overflow-hidden p-3 pb-44 sm:p-4 flex flex-col">
        <div className="mb-2 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <TerminalIcon className="w-4 h-4 text-muted-foreground" />
            <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
              Activity Feed
            </span>
          </div>
          <div className="flex items-center gap-2">
            {!followingLatest && events.length > 0 && (
              <Button variant="ghost" size="sm" className="h-6 px-2 text-[10px] uppercase" onClick={showLatest}>
                Latest
              </Button>
            )}
            <Button
              variant="ghost"
              size="icon"
              className="h-6 w-6"
              onClick={handleCopy}
              disabled={!events.length}
              title="Copy activity"
            >
              {copied ? <CheckCircle2 className="w-3 h-3 text-teal-400" /> : <Copy className="w-3 h-3" />}
            </Button>
          </div>
        </div>

        <div 
          ref={scrollRef}
          onScroll={updateScrollPosition}
          className="matrix-panel min-h-0 flex-1 w-full rounded-lg border border-border p-3 overflow-y-auto overscroll-contain font-mono text-[13px] leading-relaxed text-foreground whitespace-pre-wrap break-words [overflow-wrap:anywhere] shadow-inner"
        >
          {!tokenConfigured ? <span className="text-muted-foreground/50 italic">Enter the access token in Chat to view activity.</span> :
            error ? <span className="text-destructive">{error}</span> :
            events.length === 0 ? <span className="text-muted-foreground/50 italic">No activity in this chat session.</span> :
            events.map((event) => <ActivityEntry key={event.id} event={event} />)}
        </div>
      </div>

      <div className="absolute bottom-0 left-0 right-0 p-3 sm:p-4 bg-gradient-to-t from-background via-background/95 to-transparent pb-safe">
        <form 
          onSubmit={handleExecute}
          className="matrix-panel matrix-focus flex flex-col gap-2 rounded-lg border border-border p-3 shadow-lg relative z-10"
        >
          <div className="flex items-center gap-2 px-1">
            <span className="text-primary font-mono text-sm font-bold">$</span>
            <Textarea
              value={command}
              onChange={(e) => setCommand(e.target.value)}
              placeholder="Explicit diagnostic command…"
              className="min-h-11 max-h-24 flex-1 resize-none overflow-y-auto border-0 bg-transparent px-1 py-1 text-base font-mono leading-relaxed shadow-none focus-visible:ring-0"
              disabled={isExecuting || !tokenConfigured}
              aria-label="Terminal command"
            />
          </div>
          <div className="flex items-center justify-between mt-1 pt-2 border-t border-border/50">
              <span className="text-[10px] text-muted-foreground font-medium uppercase tracking-wider">
               Explicit approval
            </span>
            <Button 
              type="submit" 
              size="sm"
              disabled={!command.trim() || isExecuting || !tokenConfigured}
              isLoading={isExecuting}
              className="h-7 text-xs font-bold tracking-wide uppercase px-4"
            >
              <Play className="w-3 h-3 mr-1" />
              Execute
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}

function shellHistoryMatches(current: ShellEvent[], next: ShellEvent[]) {
  return current.length === next.length && current.every((event, index) => {
    const candidate = next[index];
    return event.id === candidate.id &&
      event.status === candidate.status &&
      event.output === candidate.output &&
      event.completedAt === candidate.completedAt;
  });
}

function ActivityEntry({ event }: { event: ShellEvent }) {
  const Icon = event.origin === 'ai' ? Bot : event.origin === 'user' ? UserRound : MonitorCog;
  const color = event.origin === 'ai' ? 'text-violet-300' : event.origin === 'user' ? 'text-primary' : 'text-sky-300';
  return (
    <article className="mb-3 rounded-lg border border-border/70 bg-card/60 p-3">
      <div className="mb-2 flex items-center justify-between text-[10px] font-bold uppercase tracking-wider">
        <span className={cn("flex items-center gap-1.5", color)}><Icon className="h-3 w-3" /> {event.origin}</span>
        <span className="text-muted-foreground">{new Date(event.createdAt).toLocaleTimeString()}</span>
      </div>
      <div className="text-primary">$ {event.command}</div>
      <div className={cn("mt-2 text-[10px] font-semibold uppercase", event.status === 'completed' ? 'text-teal-400' : event.status === 'blocked' || event.status === 'error' ? 'text-destructive' : 'text-amber-400')}>
        {event.status}{event.exitCode !== null ? ` · exit ${event.exitCode}` : ''}
      </div>
      {event.output && <pre className="mt-2 whitespace-pre-wrap break-words text-zinc-300">{event.output}</pre>}
    </article>
  );
}
