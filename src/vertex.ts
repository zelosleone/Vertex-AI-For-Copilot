// The project-less endpoint bills the key's own project and picks the region per model.
const API_URL = 'https://aiplatform.googleapis.com/v1/publishers/google/models';
const PROBE = JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'hi' }] }] });

export interface InlineData {
  mimeType: string;
  data: string;
}

export interface Part {
  text?: string;
  thought?: boolean;
  thoughtSignature?: string;
  inlineData?: InlineData;
  functionCall?: { id?: string; name: string; args?: object };
  functionResponse?: { id: string; name: string; response: object; parts?: { inlineData: InlineData }[] };
}

export interface Content {
  role: 'user' | 'model';
  parts: Part[];
}

export interface UsageMetadata {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  thoughtsTokenCount?: number;
  cachedContentTokenCount?: number;
}

interface Chunk {
  candidates?: { content?: { parts?: Part[] }; finishReason?: string }[];
  promptFeedback?: { blockReason?: string };
  usageMetadata?: UsageMetadata;
}

export interface StreamEvent {
  parts: Part[];
  usage?: UsageMetadata;
  stop?: string;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    body = '',
  ) {
    super(`Vertex AI request failed (HTTP ${status}). ${errorMessage(body)}`.trim());
  }
}

function errorMessage(body: string): string {
  try {
    const parsed = JSON.parse(body) as { error?: { message?: string } } | { error?: { message?: string } }[];
    return (Array.isArray(parsed) ? parsed[0] : parsed)?.error?.message ?? body.slice(0, 300);
  } catch {
    return body.slice(0, 300);
  }
}

function headers(key: string): Record<string, string> {
  return { 'x-goog-api-key': key, 'Content-Type': 'application/json' };
}

// countTokens is free and answers 404 for models the key's project can't use.
export async function isServed(key: string, model: string): Promise<boolean> {
  const res = await fetch(`${API_URL}/${model}:countTokens`, {
    method: 'POST',
    headers: headers(key),
    body: PROBE,
    signal: AbortSignal.timeout(15_000),
  });
  if (res.status === 401 || res.status === 403) throw new HttpError(res.status, await res.text());
  return res.status !== 404;
}

export async function* streamGenerate(key: string, model: string, request: object, signal: AbortSignal): AsyncGenerator<StreamEvent> {
  const res = await fetch(`${API_URL}/${model}:streamGenerateContent?alt=sse`, {
    method: 'POST',
    headers: headers(key),
    body: JSON.stringify(request),
    signal,
  });
  if (!res.ok || !res.body) throw new HttpError(res.status, await res.text());
  let buffer = '';
  for await (const text of res.body.pipeThrough(new TextDecoderStream())) {
    const lines = (buffer + text).split('\n');
    buffer = lines.pop() ?? '';
    yield* parseEvents(lines);
  }
  yield* parseEvents([buffer]);
}

function* parseEvents(lines: string[]): Generator<StreamEvent> {
  for (const line of lines) {
    const data = line.startsWith('data:') ? line.slice(5).trim() : '';
    if (data) yield toEvent(JSON.parse(data) as Chunk);
  }
}

// A blocked prompt has no candidate, only feedback saying why.
function toEvent(chunk: Chunk): StreamEvent {
  const candidate = chunk.candidates?.[0];
  const stop = candidate?.finishReason ?? chunk.promptFeedback?.blockReason;
  return { parts: candidate?.content?.parts ?? [], usage: chunk.usageMetadata, stop };
}
