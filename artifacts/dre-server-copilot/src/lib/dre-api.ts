export type ChatRole = 'user' | 'assistant' | 'system';
export type ChatMessage = { id: string; role: ChatRole; content: string; createdAt: string };
export type ShellOrigin = 'user' | 'ai' | 'system';
export type ShellStatus = 'running' | 'completed' | 'blocked' | 'error';
export type ShellEvent = {
  id: string;
  sessionId: string;
  origin: ShellOrigin;
  command: string;
  status: ShellStatus;
  output: string;
  exitCode: number | null;
  createdAt: string;
  completedAt: string | null;
};
export type ServerStatus = {
  api: string;
  openai: 'configured' | 'missing';
  shellMode: 'guarded' | 'unrestricted';
  database: 'available' | 'error';
  sessionId: string;
  uptimeSeconds: number;
  recentCommand: ShellEvent | null;
};

const TOKEN_KEY = 'dre-agent-token';
const SESSION_KEY = 'dre-session-id';

export function getAgentToken() {
  return sessionStorage.getItem(TOKEN_KEY) ?? '';
}

export function setAgentToken(token: string) {
  if (token.trim()) sessionStorage.setItem(TOKEN_KEY, token.trim());
  else sessionStorage.removeItem(TOKEN_KEY);
}

export function getSessionId() {
  let sessionId = sessionStorage.getItem(SESSION_KEY);
  if (!sessionId) {
    sessionId = crypto.randomUUID();
    sessionStorage.setItem(SESSION_KEY, sessionId);
  }
  return sessionId;
}

export function beginNewSession() {
  const sessionId = crypto.randomUUID();
  sessionStorage.setItem(SESSION_KEY, sessionId);
  return sessionId;
}

function authHeaders(extra?: HeadersInit) {
  const headers = new Headers(extra);
  const token = getAgentToken();
  if (token) headers.set('Authorization', `Bearer ${token}`);
  return headers;
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    ...options,
    headers: authHeaders(options.headers),
  });
  if (!response.ok) {
    const detail = await response.json().catch(() => null);
    throw new Error(detail?.detail ?? 'The DRE server request failed.');
  }
  return response.json() as Promise<T>;
}

export const getHistory = (sessionId: string) =>
  request<ChatMessage[]>(`/api/agent/history?sessionId=${encodeURIComponent(sessionId)}`);

export const getShellHistory = (sessionId: string) =>
  request<ShellEvent[]>(`/api/terminal/history?sessionId=${encodeURIComponent(sessionId)}`);

export const getServerStatus = (sessionId: string) =>
  request<ServerStatus>(`/api/status?sessionId=${encodeURIComponent(sessionId)}`);

export const executeCommand = (sessionId: string, command: string) =>
  request<ShellEvent>('/api/terminal/execute', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId, command }),
  });

type StreamEvent = { type?: string; content?: string; error?: string; event?: ShellEvent };

function consumeSse(
  response: Response,
  onEvent: (event: StreamEvent) => void,
  signal?: AbortSignal,
) {
  if (!response.body) throw new Error('The server did not provide a stream.');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  return (async () => {
    while (!signal?.aborted) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const blocks = buffer.split('\n\n');
      buffer = blocks.pop() ?? '';
      for (const block of blocks) {
        const line = block.split('\n').find((entry) => entry.startsWith('data: '));
        if (!line) continue;
        try {
          onEvent(JSON.parse(line.slice(6)) as StreamEvent);
        } catch {
          // Ignore malformed intermediary keepalive frames.
        }
      }
    }
  })();
}

export async function sendChat(
  sessionId: string,
  content: string,
  executeCommands: boolean,
  onEvent: (event: StreamEvent) => void,
) {
  const response = await fetch('/api/agent/chat', {
    method: 'POST',
    headers: authHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ sessionId, content, executeCommands }),
  });
  if (!response.ok) {
    const detail = await response.json().catch(() => null);
    throw new Error(detail?.detail ?? 'The DRE agent could not start.');
  }
  return consumeSse(response, onEvent);
}

export function subscribeToEvents(sessionId: string, onEvent: (event: StreamEvent) => void) {
  const controller = new AbortController();
  void fetch(`/api/events?sessionId=${encodeURIComponent(sessionId)}`, {
    headers: authHeaders(),
    signal: controller.signal,
  })
    .then((response) => {
      if (!response.ok) throw new Error('Activity stream unavailable.');
      return consumeSse(response, onEvent, controller.signal);
    })
    .catch(() => undefined);
  return () => controller.abort();
}