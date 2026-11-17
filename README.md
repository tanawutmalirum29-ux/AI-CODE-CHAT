# AI Code Chat

ZIP-only AI coding workspace. The application workflow is: upload a project ZIP, let the AI inspect and edit files in a private workspace, then download the updated ZIP.

The application itself must not connect to GitHub. Do not add GitHub OAuth, access tokens, repository browsing, branch, pull-request, commit, or Git-provider API features. GitHub is only the source repository used by AWS Amplify Hosting to build and host this app.

## AWS Amplify Hosting

The root `amplify.yml` is configured for an Express Compute build with Node.js 22. Once the application source files are present at the repository root, connect this repository to Amplify Hosting and deploy the `main` branch.

Before deploying, configure these Amplify environment variables:

- `NODE_ENV=production`
- `SESSION_SECRET` — stable random value of at least 32 characters.
- `DATA_KEY` — a different stable random value used for encrypted data.
- `DATABASE_URL` — PostgreSQL connection string with TLS settings required by the provider.
- `LOCAL_WORKSPACE_DIR=/tmp/ai-code-chat-workspaces`
- `LOCAL_RUN_ENABLED=0`

Production requires PostgreSQL for persistent, shared state. Do not rely on the instance filesystem for chat history, sessions, ZIPs, or workspace data. Keep `SESSION_SECRET` and `DATA_KEY` stable across deployments and instances.

## Local commands

Node.js 22 or newer is required.

```bash
npm install
npm run check
npm test
npm start
```

The application accepts project ZIP uploads only. It edits files in the private workspace and allows the user to download the updated ZIP. Provider/API keys are configured in the app, encrypted at rest, and are never returned to the browser.

## Source layout required by Amplify

The application source must be extracted to the repository root so that `package.json`, `server.js`, `public/index.html`, `deploy-manifest.json`, and the `scripts/` and `test/` directories exist at the root. The build pipeline runs syntax checks, unit tests, and creates `.amplify-hosting/`.
