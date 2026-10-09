import type * as vscode from 'vscode';
import { isServed } from './vertex.js';

// API keys can't list Vertex models, so candidates come from models.dev, the catalog opencode uses.
const CATALOG_URL = 'https://models.dev/api.json';

interface LevelSchema {
  properties: { reasoningEffort: { enum: string[]; default: string } & Record<string, unknown> };
}

interface CatalogModel {
  id: string;
  name?: string;
  status?: string;
  tool_call?: boolean;
  provider?: object;
  reasoning_options?: { type?: string; values?: unknown[] }[];
  modalities?: { input?: string[]; output?: string[] };
  limit?: { context?: number; output?: number };
}

type GeminiModel = CatalogModel & { limit: { context: number; output: number } };

type Providers = Record<string, { models?: Record<string, CatalogModel> }>;

export interface Catalog {
  etag?: string;
  models: GeminiModel[];
}

export type VertexModel = vscode.LanguageModelChatInformation & {
  readonly isBYOK: true;
  readonly maxContextWindowTokens: number;
  readonly configurationSchema?: LevelSchema;
};

// Revalidates with the ETag, so an unchanged catalog costs a 304 instead of 5 MB.
export async function fetchCatalog(cached?: Catalog): Promise<Catalog> {
  const headers: Record<string, string> = cached?.etag ? { 'If-None-Match': cached.etag } : {};
  const res = await fetch(CATALOG_URL, { headers, signal: AbortSignal.timeout(30_000) });
  if (res.status === 304 && cached) return cached;
  if (!res.ok) throw new Error(`models.dev request failed (HTTP ${res.status})`);
  return { etag: res.headers.get('etag') ?? undefined, models: geminiModels((await res.json()) as Providers) };
}

export async function servedModels(key: string, models: GeminiModel[]): Promise<VertexModel[]> {
  const served = await Promise.all(models.map((model) => isServed(key, model.id)));
  return models
    .filter((_, index) => served[index])
    .map(toVertexModel)
    .sort((a, b) => a.name.localeCompare(b.name, 'en', { numeric: true }));
}

function geminiModels(providers: Providers): GeminiModel[] {
  return Object.values(providers['google-vertex']?.models ?? {}).filter(isGeminiChat);
}

// Partner models (Claude, Llama, ...) carry their own `provider` API; Gemini uses generateContent.
function isGeminiChat(model: CatalogModel): model is GeminiModel {
  return !model.provider && model.tool_call === true && model.status !== 'deprecated' && answersInText(model) && hasLimits(model);
}

function answersInText(model: CatalogModel): boolean {
  return model.modalities?.output?.join() === 'text';
}

function hasLimits(model: CatalogModel): boolean {
  return Boolean(model.limit?.context && model.limit.output);
}

function toVertexModel(model: GeminiModel): VertexModel {
  return {
    id: model.id,
    name: model.name ?? model.id,
    family: model.id,
    version: model.id,
    ...tokenLimits(model.limit.context, model.limit.output),
    capabilities: { toolCalling: true, imageInput: model.modalities?.input?.includes('image') === true },
    isBYOK: true,
    configurationSchema: levelSchema(model),
  };
}

// Copilot's own BYOK convention: the prompt budget is the window minus the output reservation.
function tokenLimits(context: number, output: number) {
  const maxOutputTokens = Math.min(output, context);
  return { maxContextWindowTokens: context, maxOutputTokens, maxInputTokens: Math.max(0, context - maxOutputTokens) };
}

// Thinking level as an in-picker option; 'auto' sends nothing and keeps Google's default.
function levelSchema(model: CatalogModel): LevelSchema | undefined {
  const values = model.reasoning_options?.find((option) => option.type === 'effort')?.values ?? [];
  const levels = values.filter((value): value is string => typeof value === 'string');
  if (levels.length === 0) return undefined;
  return {
    properties: {
      reasoningEffort: {
        type: 'string',
        title: 'Thinking Level',
        enum: ['auto', ...levels],
        enumItemLabels: ['Auto', ...levels.map((level) => level.charAt(0).toUpperCase() + level.slice(1))],
        default: 'auto',
        group: 'navigation',
      },
    },
  };
}
