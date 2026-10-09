import * as vscode from 'vscode';

const KEY_NAME = 'vertexAi.apiKey';

export class Auth {
  private asking?: Promise<void>;

  constructor(private readonly secrets: vscode.SecretStorage) {}

  getKey(): Thenable<string | undefined> {
    return this.secrets.get(KEY_NAME);
  }

  onDidChange(listener: () => void): vscode.Disposable {
    return this.secrets.onDidChange((event) => {
      if (event.key === KEY_NAME) listener();
    });
  }

  setKey(): Promise<void> {
    this.asking ??= this.askForKey().finally(() => {
      this.asking = undefined;
    });
    return this.asking;
  }

  async removeKey(): Promise<void> {
    await this.secrets.delete(KEY_NAME);
  }

  private async askForKey(): Promise<void> {
    const key = await vscode.window.showInputBox({
      title: 'Vertex AI API Key',
      prompt: 'A Google Cloud API key bound to a service account, restricted to the Vertex AI (Agent Platform) API.',
      password: true,
      ignoreFocusOut: true,
      validateInput: (value) => (value.trim() ? undefined : 'Paste the key.'),
    });
    if (key?.trim()) await this.secrets.store(KEY_NAME, key.trim());
  }
}
