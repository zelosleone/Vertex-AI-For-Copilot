import { randomUUID } from 'node:crypto';
import * as vscode from 'vscode';
import type { Auth } from './auth.js';
import { toDeclaration, toPrompt } from './convert.js';
import { fetchCatalog, servedModels, type Catalog, type VertexModel } from './models.js';
import { streamGenerate, type Part, type StreamEvent, type UsageMetadata } from './vertex.js';

const MODELS_KEY = 'vertexAi.models';
const CATALOG_KEY = 'vertexAi.catalog';
const CHARS_PER_TOKEN_KEY = 'vertexAi.charsPerToken';
// A signature is only needed until its agent turn ends, so the most recent ones are enough.
const MAX_SIGNATURES = 1000;
const NORMAL_STOPS = new Set(['STOP', 'MAX_TOKENS']);

type Options = vscode.ProvideLanguageModelChatResponseOptions & {
  readonly modelConfiguration?: { readonly reasoningEffort?: string };
  readonly configuration?: { readonly reasoningEffort?: string };
};

interface Turn {
  model: VertexModel;
  chars: number;
  progress: vscode.Progress<vscode.LanguageModelResponsePart>;
  usage?: UsageMetadata;
  stop?: string;
}

export class VertexChatProvider implements vscode.LanguageModelChatProvider<VertexModel> {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeLanguageModelChatInformation = this.changed.event;
  private readonly signatures = new Map<string, string>();
  private models: VertexModel[];
  private charsPerToken: number;

  constructor(
    private readonly state: vscode.Memento,
    private readonly auth: Auth,
    private readonly log: vscode.LogOutputChannel,
  ) {
    this.models = state.get<VertexModel[]>(MODELS_KEY, []);
    this.charsPerToken = state.get(CHARS_PER_TOKEN_KEY, 4);
  }

  get modelCount(): number {
    return this.models.length;
  }

  async provideLanguageModelChatInformation(options: vscode.PrepareLanguageModelChatModelOptions): Promise<VertexModel[]> {
    if (await this.auth.getKey()) return this.models;
    if (!options.silent) void this.auth.setKey();
    return [];
  }

  async provideLanguageModelChatResponse(
    model: VertexModel,
    messages: readonly vscode.LanguageModelChatRequestMessage[],
    options: Options,
    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
    token: vscode.CancellationToken,
  ): Promise<void> {
    const key = await this.auth.getKey();
    if (!key) throw new Error('No API key. Run "Vertex AI: Set API Key".');
    const request = buildRequest(model, messages, options, this.signatures);
    const turn: Turn = { model, chars: payloadChars(request), progress };
    const abort = new AbortController();
    const cancel = token.onCancellationRequested(() => abort.abort());
    try {
      for await (const event of streamGenerate(key, model.id, request, abort.signal)) this.onEvent(event, turn);
      this.finish(turn);
    } catch (error) {
      if (!token.isCancellationRequested) throw error;
    } finally {
      cancel.dispose();
    }
  }

  // Copilot calls this for every key and string of every tool schema, so round instead of ceil.
  async provideTokenCount(_model: VertexModel, text: string | vscode.LanguageModelChatRequestMessage): Promise<number> {
    const chars = typeof text === 'string' ? text.length : payloadChars(toPrompt([text], this.signatures));
    return Math.max(1, Math.round(chars / this.charsPerToken));
  }

  async refresh(notify = false): Promise<void> {
    const key = await this.auth.getKey();
    if (!key) return;
    try {
      const catalog = await fetchCatalog(this.state.get<Catalog>(CATALOG_KEY));
      void this.state.update(CATALOG_KEY, catalog);
      this.setModels(await servedModels(key, catalog.models));
      if (notify) void vscode.window.showInformationMessage(`Vertex AI: ${this.models.length} Gemini models ready.`);
    } catch (error) {
      this.log.warn(`Model refresh failed: ${(error as Error).message}`);
      if (notify) void vscode.window.showErrorMessage((error as Error).message);
    }
  }

  keyChanged(): void {
    this.changed.fire();
    void this.refresh(true);
  }

  // Unchanged catalogs keep the same objects, so open picker menus stay put.
  private setModels(models: VertexModel[]): void {
    if (JSON.stringify(models) === JSON.stringify(this.models)) return;
    this.models = models;
    void this.state.update(MODELS_KEY, models);
    this.changed.fire();
  }

  private onEvent({ parts, usage, stop }: StreamEvent, turn: Turn): void {
    for (const part of parts) {
      const response = this.toResponsePart(part);
      if (response) turn.progress.report(response);
    }
    turn.usage = usage ?? turn.usage;
    turn.stop = stop ?? turn.stop;
  }

  private toResponsePart({ functionCall, thoughtSignature, text, thought }: Part): vscode.LanguageModelResponsePart | undefined {
    if (functionCall) return this.toToolCall(functionCall, thoughtSignature);
    return text && !thought ? new vscode.LanguageModelTextPart(text) : undefined;
  }

  // Fresh ids keep calls unique across turns; the signature is sent back with the call next turn.
  private toToolCall(call: NonNullable<Part['functionCall']>, signature?: string): vscode.LanguageModelToolCallPart {
    const id = `call_${randomUUID().replaceAll('-', '')}`;
    if (signature) this.remember(id, signature);
    return new vscode.LanguageModelToolCallPart(id, call.name, call.args ?? {});
  }

  private remember(id: string, signature: string): void {
    this.signatures.set(id, signature);
    const oldest = this.signatures.keys().next().value;
    if (this.signatures.size > MAX_SIGNATURES && oldest !== undefined) this.signatures.delete(oldest);
  }

  private finish(turn: Turn): void {
    if (turn.usage?.promptTokenCount) this.recordUsage(turn.usage, turn);
    if (turn.stop && !NORMAL_STOPS.has(turn.stop)) throw new Error(`Vertex AI stopped the answer (${turn.stop}).`);
  }

  private recordUsage(meta: UsageMetadata, turn: Turn): void {
    const prompt = meta.promptTokenCount ?? 0;
    const completion = (meta.candidatesTokenCount ?? 0) + (meta.thoughtsTokenCount ?? 0);
    const cached = meta.cachedContentTokenCount ?? 0;
    const usage = {
      prompt_tokens: prompt,
      completion_tokens: completion,
      total_tokens: prompt + completion,
      prompt_tokens_details: { cached_tokens: cached },
    };
    // Copilot reads this data part to drive its context window indicator.
    turn.progress.report(vscode.LanguageModelDataPart.json(usage, 'usage'));
    const ratio = Math.min(12, Math.max(1, turn.chars / Math.max(1, prompt)));
    this.charsPerToken = this.charsPerToken * 0.7 + ratio * 0.3;
    void this.state.update(CHARS_PER_TOKEN_KEY, this.charsPerToken);
    this.log.info(`${turn.model.id}: ${prompt} prompt (${cached} cached), ${completion} completion`);
  }
}

function buildRequest(
  model: VertexModel,
  messages: readonly vscode.LanguageModelChatRequestMessage[],
  options: Options,
  signatures: ReadonlyMap<string, string>,
) {
  const declarations = (options.tools ?? []).map(toDeclaration);
  const level = thinkingLevel(model, options);
  return {
    ...toPrompt(messages, signatures),
    ...(declarations.length > 0 ? { tools: [{ functionDeclarations: declarations }], toolConfig: toolConfig(options) } : {}),
    ...(level ? { generationConfig: { thinkingConfig: { thinkingLevel: level } } } : {}),
  };
}

function toolConfig(options: Options) {
  const required = options.toolMode === vscode.LanguageModelChatToolMode.Required;
  return { functionCallingConfig: { mode: required ? 'ANY' : 'AUTO' } };
}

// The picked level if the model still offers it, else its default; 'auto' sends nothing.
function thinkingLevel(model: VertexModel, options: Options): string | undefined {
  const schema = model.configurationSchema?.properties.reasoningEffort;
  if (!schema) return undefined;
  const picked = pickedLevel(options);
  const value = picked !== undefined && schema.enum.includes(picked) ? picked : schema.default;
  return value === 'auto' ? undefined : value;
}

// VS Code 1.120+ passes picker values as modelConfiguration, older versions as configuration.
function pickedLevel(options: Options): string | undefined {
  return options.modelConfiguration?.reasoningEffort ?? options.configuration?.reasoningEffort;
}

// What Gemini bills as text: media counts as image tokens, and signatures are opaque.
function payloadChars(value: unknown): number {
  const skip = new Set(['inlineData', 'thoughtSignature']);
  return JSON.stringify(value, (key, item: unknown) => (skip.has(key) ? undefined : item)).length;
}
