import React, { useState } from 'react';
import { MessageSquare, Terminal, Activity } from 'lucide-react';
import { ChatView } from '@/components/chat-view';
import { TerminalView } from '@/components/terminal-view';
import { StatusView } from '@/components/status-view';
import { cn } from '@/lib/utils';
import { getAgentToken, getSessionId } from '@/lib/dre-api';

type ViewType = 'chat' | 'terminal' | 'status';

export function Home() {
  const [activeView, setActiveView] = useState<ViewType>('chat');
  const [sessionId, setSessionId] = useState(getSessionId);
  const [tokenConfigured, setTokenConfigured] = useState(Boolean(getAgentToken()));
  const refreshToken = () => setTokenConfigured(Boolean(getAgentToken()));

  return (
    <div className="flex flex-col h-[100dvh] w-full max-w-lg mx-auto bg-background/95 border-x border-border/50 shadow-2xl relative overflow-hidden text-foreground">
      {/* Header */}
      <header className="flex-none h-14 border-b border-border bg-card/90 backdrop-blur flex items-center justify-between px-4 z-20">
        <div className="flex items-center gap-2">
           <div className="w-6 h-6 rounded bg-primary flex items-center justify-center shadow-[0_0_12px_hsl(var(--primary)/0.2)]">
            <Terminal className="w-3.5 h-3.5 text-primary-foreground" />
          </div>
          <h1 className="font-bold tracking-tight text-sm uppercase">DRE Copilot</h1>
        </div>
        <div className="flex items-center gap-1.5">
          <span className="relative flex h-2.5 w-2.5">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-primary opacity-40"></span>
            <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-primary"></span>
          </span>
          <span className="text-[10px] font-bold uppercase tracking-widest text-primary">Live</span>
        </div>
      </header>

      {/* Main Content Area */}
      <main className="min-h-0 flex-1 relative overflow-hidden">
        <div className={cn("absolute inset-0 transition-opacity duration-200", activeView === 'chat' ? 'opacity-100 z-10' : 'opacity-0 z-0 pointer-events-none')}>
          <ChatView sessionId={sessionId} tokenConfigured={tokenConfigured} onTokenSaved={refreshToken} onSessionChanged={setSessionId} />
        </div>
        <div className={cn("absolute inset-0 transition-opacity duration-200", activeView === 'terminal' ? 'opacity-100 z-10' : 'opacity-0 z-0 pointer-events-none')}>
          <TerminalView sessionId={sessionId} tokenConfigured={tokenConfigured} />
        </div>
        <div className={cn("absolute inset-0 transition-opacity duration-200", activeView === 'status' ? 'opacity-100 z-10' : 'opacity-0 z-0 pointer-events-none')}>
          <StatusView sessionId={sessionId} tokenConfigured={tokenConfigured} />
        </div>
      </main>

      {/* Bottom Navigation */}
      <nav className="flex-none h-[4.25rem] border-t border-border bg-card/95 pb-safe z-30">
        <div className="flex h-full">
          <NavButton 
            active={activeView === 'chat'} 
            onClick={() => setActiveView('chat')}
            icon={<MessageSquare className="w-5 h-5" />}
            label="Chat"
          />
          <NavButton 
            active={activeView === 'terminal'} 
            onClick={() => setActiveView('terminal')}
            icon={<Terminal className="w-5 h-5" />}
            label="Terminal"
          />
          <NavButton 
            active={activeView === 'status'} 
            onClick={() => setActiveView('status')}
            icon={<Activity className="w-5 h-5" />}
            label="Status"
          />
        </div>
      </nav>
    </div>
  );
}

function NavButton({ 
  active, 
  onClick, 
  icon, 
  label 
}: { 
  active: boolean; 
  onClick: () => void; 
  icon: React.ReactNode; 
  label: string; 
}) {
  return (
    <button
      onClick={onClick}
         className={cn(
         "min-h-11 flex-1 flex flex-col items-center justify-center gap-1 relative transition-colors duration-200 focus-visible:outline-none focus-visible:bg-accent",
        active ? "text-primary" : "text-muted-foreground hover:text-foreground"
      )}
    >
      {active && (
         <div className="absolute top-0 left-1/2 -translate-x-1/2 w-10 h-0.5 bg-primary rounded-b-full shadow-[0_0_8px_hsl(var(--primary)/0.8)]" />
      )}
      {icon}
      <span className="text-[10px] font-bold uppercase tracking-wider">{label}</span>
    </button>
  );
}
