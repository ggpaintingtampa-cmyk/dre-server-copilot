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

function compactText(value: string, maxLength = 260) {
  const text = value
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

export function readableMessage(value: unknown, fallback = 'The DRE server returned an unexpected response.') {
  if (typeof value === 'string') return compactText(value) || fallback;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (!value || typeof value !== 'object') return fallback;

  const record = value as Record<string, unknown>;
  for (const key of ['detail', 'error', 'message']) {
    if (record[key] !== undefined) {
      return readableMessage(record[key], fallback);
    }
  }

  try {
    return compactText(JSON.stringify(record)) || fallback;
  } catch {
    return fallback;
  }
}

function hasJsonContentType(response: Response) {
  return response.headers.get('content-type')?.toLowerCase().includes('application/json') ?? false;
}

async function readResponseBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text.trim()) return null;
  if (!hasJsonContentType(response)) return text;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function httpError(path: string, response: Response, payload: unknown) {
  const status = `${response.status}${response.statusText ? ` ${response.statusText}` : ''}`;
  const detail = readableMessage(payload, '');
  return `Request to ${path} failed (${status})${detail ? `: ${detail}` : ''}`;
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    ...options,
    headers: authHeaders(options.headers),
  });
  const payload = await readResponseBody(response);
  if (!response.ok) {
    throw new Error(httpError(path, response, payload));
  }
  if (!hasJsonContentType(response)) {
    const received = response.headers.get('content-type') || 'an unknown content type';
    throw new Error(
      `Unexpected response from ${path} (${response.status}): expected JSON but received ${received}.`,
    );
  }
  if (payload === null || typeof payload === 'string') {
    throw new Error(`Malformed JSON response from ${path} (${response.status}).`);
  }
  return payload as T;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function malformedResponse(path: string, expected: string): Error {
  return new Error(`Malformed JSON response from ${path}: expected ${expected}.`);
}

function isChatMessage(value: unknown): value is ChatMessage {
  return isRecord(value)
    && typeof value.id === 'string'
    && (value.role === 'user' || value.role === 'assistant' || value.role === 'system')
    && typeof value.content === 'string'
    && typeof value.createdAt === 'string';
}

function isShellEvent(value: unknown): value is ShellEvent {
  return isRecord(value)
    && typeof value.id === 'string'
    && typeof value.sessionId === 'string'
    && (value.origin === 'user' || value.origin === 'ai' || value.origin === 'system')
    && typeof value.command === 'string'
    && (value.status === 'running' || value.status === 'completed' || value.status === 'blocked' || value.status === 'error')
    && typeof value.output === 'string'
    && (typeof value.exitCode === 'number' || value.exitCode === null)
    && typeof value.createdAt === 'string'
    && (typeof value.completedAt === 'string' || value.completedAt === null);
}

function isServerStatus(value: unknown): value is ServerStatus {
  return isRecord(value)
    && typeof value.api === 'string'
    && (value.openai === 'configured' || value.openai === 'missing')
    && (value.shellMode === 'guarded' || value.shellMode === 'unrestricted')
    && (value.database === 'available' || value.database === 'error')
    && typeof value.sessionId === 'string'
    && typeof value.uptimeSeconds === 'number'
    && (value.recentCommand === null || isShellEvent(value.recentCommand));
}

export async function getHistory(sessionId: string): Promise<ChatMessage[]> {
  const path = `/api/agent/history?sessionId=${encodeURIComponent(sessionId)}`;
  const payload = await request<unknown>(path);
  if (!Array.isArray(payload) || !payload.every(isChatMessage)) throw malformedResponse(path, 'a chat message array');
  return payload;
}

export async function getShellHistory(sessionId: string): Promise<ShellEvent[]> {
  const path = `/api/terminal/history?sessionId=${encodeURIComponent(sessionId)}`;
  const payload = await request<unknown>(path);
  if (!Array.isArray(payload) || !payload.every(isShellEvent)) throw malformedResponse(path, 'a shell event array');
  return payload;
}

export async function getServerStatus(sessionId: string): Promise<ServerStatus> {
  const path = `/api/status?sessionId=${encodeURIComponent(sessionId)}`;
  const payload = await request<unknown>(path);
  if (!isServerStatus(payload)) throw malformedResponse(path, 'a server status object');
  return payload;
}

export async function executeCommand(sessionId: string, command: string): Promise<ShellEvent> {
  const path = '/api/terminal/execute';
  const payload = await request<unknown>(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId, command }),
  });
  if (!isShellEvent(payload)) throw malformedResponse(path, 'a shell event object');
  return payload;
}

type StreamEvent = { type?: string; content?: unknown; error?: unknown; event?: ShellEvent; messageId?: unknown };

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
    const cancelReader = () => void reader.cancel();
    signal?.addEventListener('abort', cancelReader, { once: true });
    try {
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
    } finally {
      signal?.removeEventListener('abort', cancelReader);
      reader.releaseLock();
    }
  })();
}

export async function sendChat(
  sessionId: string,
  content: string,
  executeCommands: boolean,
  onEvent: (event: StreamEvent) => void,
  signal?: AbortSignal,
) {
  const response = await fetch('/api/agent/chat', {
    method: 'POST',
    headers: authHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ sessionId, content, executeCommands }),
    signal,
  });
  if (!response.ok) {
    throw new Error(httpError('/api/agent/chat', response, await readResponseBody(response)));
  }
  if (!response.headers.get('content-type')?.toLowerCase().includes('text/event-stream')) {
    const payload = await readResponseBody(response);
    throw new Error(
      `Unexpected response from /api/agent/chat (${response.status}): expected a streaming response. ${readableMessage(payload, '')}`,
    );
  }
  return consumeSse(response, onEvent, signal);
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