# AI Code Chat

ZIP-only AI coding workspace. The application source is stored in `source/ai-code-chat-source.zip` and extracted automatically by AWS Amplify during its build.

The application itself does **not** connect to GitHub. It has no GitHub OAuth, access-token, repository browser, branch, pull-request, commit, or Git-provider API integration. The GitHub repository is used only as the source location that AWS Amplify checks out for hosting builds.

## Deploy with AWS Amplify Hosting

1. Connect this repository to AWS Amplify Hosting and select the `main` branch.
2. Amplify reads the root `amplify.yml`, extracts the application source, installs its dependencies, runs syntax checks and unit tests, and builds the Express Compute deployment bundle.
3. Configure these environment variables in Amplify:
   - `NODE_ENV=production`
   - `SESSION_SECRET` — stable random value, at least 32 characters.
   - `DATA_KEY` — a different stable random value for encrypted data.
   - `DATABASE_URL` — PostgreSQL connection string with the provider's required TLS settings.
   - `LOCAL_WORKSPACE_DIR=/tmp/ai-code-chat-workspaces`
   - `LOCAL_RUN_ENABLED=0`
4. Deploy. The build artifact is `app/.amplify-hosting/`.

Production requires PostgreSQL for persistent, shared state. Do not rely on the instance filesystem for chat history, project ZIPs, sessions, or encrypted workspace data. Keep `SESSION_SECRET` and `DATA_KEY` stable across deployments and instances.

## Source archive

To work locally, extract `source/ai-code-chat-source.zip` into a directory, then run:

```bash
npm install
npm run check
npm test
npm start
```

The application accepts project ZIP uploads only. It edits files in the private workspace and lets the user download the updated ZIP. Provider/API keys are configured in the app, encrypted at rest, and never returned to the browser.
