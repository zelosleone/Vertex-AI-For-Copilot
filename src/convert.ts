import * as vscode from 'vscode';
import type { Content, InlineData, Part } from './vertex.js';

// Copilot sends its system prompt with the proposed System role, which the stable typings lack.
const SYSTEM_ROLE = 3 as vscode.LanguageModelChatMessageRole;
// Gemini 3 rejects a replayed tool call without its signature (HTTP 400). Google documents this
// value for calls it never signed, such as another model's or ones from before a restart.
const UNSIGNED = 'skip_thought_signature_validator';

type Signatures = ReadonlyMap<string, string>;

export interface Prompt {
  contents: Content[];
  systemInstruction?: { parts: Part[] };
}

export function toPrompt(messages: readonly vscode.LanguageModelChatRequestMessage[], signatures: Signatures): Prompt {
  const names = new Map<string, string>();
  const system: string[] = [];
  const contents: Content[] = [];
  for (const message of messages) {
    if (message.role === SYSTEM_ROLE) system.push(textOf(message.content));
    else append(contents, roleOf(message.role), toParts(message.content, names, signatures));
  }
  contents.forEach(signFirstCall);
  const instruction = system.filter(Boolean).join('\n\n');
  return instruction ? { systemInstruction: { parts: [{ text: instruction }] }, contents } : { contents };
}

export function toDeclaration(tool: vscode.LanguageModelChatTool): object {
  const schema = tool.inputSchema ? { parametersJsonSchema: tool.inputSchema } : {};
  return { name: tool.name, description: tool.description, ...schema };
}

function roleOf(role: vscode.LanguageModelChatMessageRole): Content['role'] {
  return role === vscode.LanguageModelChatMessageRole.User ? 'user' : 'model';
}

// One content per turn: Gemini wants every result of parallel calls in a single user content.
function append(contents: Content[], role: Content['role'], parts: Part[]): void {
  const last = contents.at(-1);
  if (parts.length === 0) return;
  if (last?.role === role) last.parts.push(...parts);
  else contents.push({ role, parts });
}

function toParts(content: readonly unknown[], names: Map<string, string>, signatures: Signatures): Part[] {
  const parts = content.flatMap((part) => toPart(part, names, signatures));
  // Results go first, right after the model turn that asked for them.
  return [...parts.filter((part) => part.functionResponse), ...parts.filter((part) => !part.functionResponse)];
}

function toPart(part: unknown, names: Map<string, string>, signatures: Signatures): Part[] {
  if (part instanceof vscode.LanguageModelTextPart) return part.value ? [{ text: part.value }] : [];
  if (part instanceof vscode.LanguageModelToolCallPart) return [toCall(part, names, signatures)];
  if (part instanceof vscode.LanguageModelToolResultPart) return [toResult(part, names)];
  return isMedia(part) ? [{ inlineData: toInlineData(part) }] : [];
}

function toCall(part: vscode.LanguageModelToolCallPart, names: Map<string, string>, signatures: Signatures): Part {
  names.set(part.callId, part.name);
  const signature = signatures.get(part.callId);
  const call = { functionCall: { id: part.callId, name: part.name, args: part.input } };
  return signature ? { ...call, thoughtSignature: signature } : call;
}

// Gemini 3 reads images returned by tools, such as screenshots, from the response's own parts.
function toResult(part: vscode.LanguageModelToolResultPart, names: ReadonlyMap<string, string>): Part {
  const media = part.content.filter(isMedia).map((item) => ({ inlineData: toInlineData(item) }));
  const rest = part.content.filter((item) => !isMedia(item));
  const response = { output: textOf(rest) || JSON.stringify(rest) };
  const name = names.get(part.callId) ?? 'tool';
  return { functionResponse: { id: part.callId, name, response, ...(media.length > 0 ? { parts: media } : {}) } };
}

// Gemini signs only the first of parallel calls, and that is the one it checks.
function signFirstCall(content: Content): void {
  const first = content.parts.find((part) => part.functionCall);
  if (first && !first.thoughtSignature) first.thoughtSignature = UNSIGNED;
}

function textOf(content: readonly unknown[]): string {
  return content
    .filter((item) => item instanceof vscode.LanguageModelTextPart)
    .map((item) => item.value)
    .join('\n');
}

function isMedia(part: unknown): part is vscode.LanguageModelDataPart {
  return part instanceof vscode.LanguageModelDataPart && /^(image\/|application\/pdf$)/.test(part.mimeType);
}

function toInlineData(part: vscode.LanguageModelDataPart): InlineData {
  return { mimeType: part.mimeType, data: Buffer.from(part.data).toString('base64') };
}
