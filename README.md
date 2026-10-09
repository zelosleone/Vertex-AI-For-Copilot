# Vertex AI for Copilot

Use Gemini on Vertex AI in GitHub Copilot Chat. Usage is billed to your Google Cloud project, so Google Cloud credits (such as the Google Developer Program monthly credits) pay for it. AI Studio keys can't spend those credits; Vertex AI keys can.

1. In the Google Cloud console, enable the Vertex AI (Agent Platform) API and create an API key bound to a service account with the Vertex AI User role.
2. Run **Vertex AI: Set API Key** and paste it. No project ID or region needed.
3. Pick a Gemini model in the Copilot Chat model picker and set its thinking level right there.

Models come live from the [models.dev](https://models.dev) Vertex catalog, and each one is checked against your key with a free token count, so new Gemini models show up on their own and ones your project can't use stay hidden. Tool calling, images (including screenshots returned by tools), Copilot's context window indicator and Vertex's implicit prompt caching all work.

**Vertex AI: Manage** shows how many models are available and can refresh them, change or remove the key, or open the logs.

## Development

```sh
npm install
npm run compile
npm run lint      # includes a complexity cap of 8
npx -y knip       # unused files, exports and dependencies
npm run package   # builds the .vsix
```

Unofficial, not affiliated with Google. Vertex AI and Gemini are trademarks of Google LLC.
