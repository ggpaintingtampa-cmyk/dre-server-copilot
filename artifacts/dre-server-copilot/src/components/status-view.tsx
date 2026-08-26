import React from 'react';
import { Activity, Server, Clock, Database, KeyRound, ShieldCheck, TerminalSquare } from 'lucide-react';
import { cn } from '@/lib/utils';
import { formatDistanceToNow } from 'date-fns';
import { getServerStatus, type ServerStatus } from '@/lib/dre-api';

export function StatusView({ sessionId, tokenConfigured }: { sessionId: string; tokenConfigured: boolean }) {
  const [status, setStatus] = React.useState<ServerStatus | null>(null);
  const [error, setError] = React.useState('');
  React.useEffect(() => {
    if (!tokenConfigured) { setStatus(null); return; }
    const refresh = () => void getServerStatus(sessionId)
      .then((result) => { setStatus(result); setError(''); })
      .catch((requestError: Error) => setError(requestError.message));
    refresh();
    const timer = window.setInterval(refresh, 5000);
    return () => window.clearInterval(timer);
  }, [sessionId, tokenConfigured]);
  const isHealthy = status?.api === 'online';

  return (
    <div className="flex h-full flex-col overflow-y-auto bg-background/80 p-3 space-y-4 pb-32 sm:p-4">
      <div className="flex items-center gap-3">
        <Server className="w-5 h-5 text-primary" />
        <h2 className="text-base font-bold tracking-tight">System Status</h2>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="matrix-panel col-span-2 flex items-center justify-between rounded-lg border border-border p-3 shadow-sm">
          <div className="flex items-center gap-3">
            <div className={cn(
               "flex h-9 w-9 items-center justify-center rounded-full",
              isHealthy ? "bg-teal-500/10 text-teal-400" : "bg-destructive/10 text-destructive"
            )}>
              <Activity className="w-5 h-5" />
            </div>
            <div>
              <p className="text-sm font-medium text-muted-foreground uppercase tracking-wider">Health</p>
               <p className="text-base font-bold">
                {isHealthy ? 'Online' : 'Degraded'}
              </p>
            </div>
          </div>
          <div className={cn(
            "px-3 py-1 rounded-full text-xs font-bold uppercase tracking-widest",
            isHealthy ? "bg-teal-500/20 text-teal-400" : "bg-destructive/20 text-destructive"
          )}>
            {status?.api || 'Locked'}
          </div>
        </div>

        <div className="matrix-panel flex flex-col gap-2 rounded-lg border border-border p-3 shadow-sm">
          <KeyRound className="w-5 h-5 text-muted-foreground" />
          <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">OpenAI</p>
          <p className="font-mono text-sm font-bold text-foreground">{status?.openai || 'Locked'}</p>
        </div>

        <div className="matrix-panel flex flex-col gap-2 rounded-lg border border-border p-3 shadow-sm">
          <Database className="w-5 h-5 text-muted-foreground" />
          <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">SQLite</p>
          <p className="font-mono text-sm font-bold text-foreground">{status?.database || 'Locked'}</p>
        </div>
      </div>

      <div className="space-y-3">
        <div className="flex items-center gap-2">
          <TerminalSquare className="w-4 h-4 text-primary" />
          <h3 className="text-sm font-bold tracking-tight uppercase">Last Execution</h3>
        </div>
        
         <div className="matrix-panel rounded-lg border border-border p-3 space-y-3 shadow-sm">
          {status?.recentCommand ? (
            <>
              <div>
                <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-1">Command</p>
                 <div className="rounded border border-border/50 bg-background/70 p-2 font-mono text-xs text-primary break-words [overflow-wrap:anywhere]">
                   {status.recentCommand.command}
                </div>
              </div>

              <div className="flex items-center justify-between">
                <div>
                  <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Status</p>
                   <p className="text-sm font-bold capitalize mt-0.5">{status.recentCommand.origin} · {status.recentCommand.status}</p>
                </div>
                <div className="text-right">
                  <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Updated</p>
                  <div className="flex items-center gap-1.5 mt-0.5 text-sm text-foreground">
                    <Clock className="w-3 h-3 text-muted-foreground" />
                     {formatDistanceToNow(new Date(status.recentCommand.completedAt || status.recentCommand.createdAt), { addSuffix: true })}
                  </div>
                </div>
              </div>
            </>
          ) : (
            <div className="text-center text-muted-foreground text-sm py-4">
               {error || (tokenConfigured ? 'No commands in this session.' : 'Enter the access token in Chat to view protected status.')}
            </div>
          )}
        </div>
      </div>
       {status && <div className="matrix-panel rounded-lg border border-border p-3 text-xs text-muted-foreground"><ShieldCheck className="mr-2 inline h-4 w-4 text-primary" />Shell mode: <span className="font-mono text-foreground">{status.shellMode}</span> · Uptime: {Math.floor(status.uptimeSeconds / 60)}m · Session: <span className="font-mono">{status.sessionId.slice(0, 8)}</span></div>}
    </div>
  );
}
