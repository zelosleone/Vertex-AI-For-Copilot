import * as vscode from 'vscode';
import { Auth } from './auth.js';
import { VertexChatProvider } from './provider.js';

const REFRESH_INTERVAL_MS = 30 * 60 * 1000;

export function activate(context: vscode.ExtensionContext): void {
  const log = vscode.window.createOutputChannel('Vertex AI', { log: true });
  const auth = new Auth(context.secrets);
  const provider = new VertexChatProvider(context.globalState, auth, log);
  const timer = setInterval(() => void provider.refresh(), REFRESH_INTERVAL_MS);

  context.subscriptions.push(
    log,
    new vscode.Disposable(() => clearInterval(timer)),
    vscode.lm.registerLanguageModelChatProvider('vertex-ai', provider),
    auth.onDidChange(() => provider.keyChanged()),
    vscode.commands.registerCommand('vertexAi.setApiKey', () => auth.setKey()),
    vscode.commands.registerCommand('vertexAi.removeApiKey', () => auth.removeKey()),
    vscode.commands.registerCommand('vertexAi.manage', () => manage(auth, provider, log)),
  );
  void provider.refresh();
}

async function manage(auth: Auth, provider: VertexChatProvider, log: vscode.LogOutputChannel): Promise<void> {
  const hasKey = Boolean(await auth.getKey());
  const actions: Record<string, () => unknown> = hasKey
    ? { 'Refresh Models': () => provider.refresh(true), 'Change API Key': () => auth.setKey(), 'Remove API Key': () => auth.removeKey() }
    : { 'Set API Key': () => auth.setKey() };
  actions['Show Logs'] = () => log.show();
  const title = hasKey ? `Vertex AI: ${provider.modelCount} Gemini models` : 'Vertex AI: no API key';
  const choice = await vscode.window.showQuickPick(Object.keys(actions), { title });
  if (choice) await actions[choice]();
}
