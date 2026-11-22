# AI Code Chat

A ZIP-only AI workspace with three tools. Version 1 stores provider settings and projects by browser session; it does not include user accounts or login.

- **AI Chat** — switch between OpenUncensored and Venice chat models.
- **Code Workspace** — upload a project ZIP, ask an AI model to edit source files, then download the updated ZIP.
- **Image Studio** — generate images and edit reference images through OpenUncensored.

The application itself does not connect to GitHub. It has no GitHub OAuth, repository browser, tokens, commits, branches or pull-request features. GitHub is only the source repository that AWS Amplify uses to build and host this application.

## AI providers

### OpenUncensored

Base URL: https://api.openuncensored.com/v1

One prepaid API key supports:
- Chat completions: POST /chat/completions
- Image generation: POST /images/generations
- Image editing: POST /images/edits
- Live model catalogues: GET /models and GET /images/models

Default chat model: deepseek-v4.1-flash-1017-uncensored.

Image Studio includes Z-Image Turbo, Chroma, Qwen Image, Qwen Image 3 Uncensored, Qwen Edit Uncensored, Qwen Image 3 Edit, Seedream 5.5 Edit and FLUX.2 Klein Edit. Text model lists are loaded from provider catalogues when available. Image models are shown from a curated list of supported generation and editing models. Model availability and prices can change; check the provider before use.

Get a key and prepaid credits at https://openuncensored.com/credits.

### Venice

Base URL: https://api.venice.ai/api/v1

Venice is available as a second chat provider. The application queries its text model catalogue when available.

Get an API key at https://venice.ai/settings/api.

## Security and data handling

- Provider API keys entered in Settings are stored per browser session in PostgreSQL.
- Keys are encrypted server-side with AES-256-GCM using DATA_KEY. The key is never returned to the browser.
- Session cookies are HTTP-only, Secure in production, and SameSite=Lax.
- Provider base URLs are fixed in the server allowlist; users cannot submit arbitrary URLs.
- ZIP extraction rejects path traversal, absolute paths, symlinks, special files, suspicious compression ratios, excessive entries and oversized archives.
- The AI code editor does not read .env files, credentials, private keys, .npmrc, .git or node_modules into its prompt. AI edits cannot target those protected paths.
- The application does not run uploaded project code or shell commands. It only edits supported text files and returns a ZIP.
- Uploaded and edited ZIP archives are persisted in PostgreSQL for six hours, with up to four active workspaces per browser session. The extracted working copy is temporary under /tmp and is rebuilt from PostgreSQL when another Amplify compute instance receives a request.
- Text source files selected for AI context are sent to the chosen external model provider. Review that provider's data-retention terms before uploading confidential source code.
- Never upload projects containing secrets unless you have removed them first. Keep a clean backup of the original ZIP.
- If a server-wide provider key is configured in environment variables, anyone who can access this app may be able to use that shared quota. Prefer per-session keys in Settings unless the app is access-restricted.

Use image models only for lawful content. Provider safety restrictions still apply, including restrictions on sexual content involving minors, non-consensual imagery and real people without their consent.

## AWS Amplify Hosting

The repository includes an Express deployment manifest and build script for the Amplify Hosting deployment specification.

Configure these environment variables in Amplify:

| Variable | Required | Purpose |
| --- | --- | --- |
| NODE_ENV | Yes | Set to production |
| SESSION_SECRET | Yes | Stable random secret, at least 32 characters |
| DATA_KEY | Yes | A different stable random secret, at least 32 characters |
| DATABASE_URL | Yes | PostgreSQL connection string; use TLS as required by the database provider |
| LOCAL_WORKSPACE_DIR | Recommended | /tmp/ai-code-chat-workspaces |
| OPENUNCENSORED_API_KEY | Optional | Server-wide OpenUncensored key; users can also add per-session keys in Settings |
| VENICE_API_KEY | Optional | Server-wide Venice key; users can also add per-session keys in Settings |

Generate independent secrets, for example:

~~~sh
openssl rand -hex 32
openssl rand -hex 32
~~~

Keep SESSION_SECRET and DATA_KEY stable across deployments and instances. Changing DATA_KEY makes previously saved provider keys unreadable. PostgreSQL is required for persistent sessions, encrypted provider keys and ZIP workspaces. Do not rely on instance filesystem storage for persistent data.

The Amplify compute runtime has ephemeral storage. Extracted workspace files are deliberately stored only under /tmp; the compressed ZIP is stored in PostgreSQL and restored on demand. Ensure the PostgreSQL plan has sufficient storage for uploaded projects.

## Local development

Node.js 22 or newer and PostgreSQL are required for full functionality.

1. Copy .env.example to .env.
2. Set DATABASE_URL, SESSION_SECRET and DATA_KEY.
3. Install dependencies and start the server:

~~~sh
npm install
npm run check
npm test
npm start
~~~

Open http://localhost:3000.

## Build

~~~sh
npm install
npm run check
npm test
npm run build
~~~

The build creates .amplify-hosting/ with:
- compute/default/ — the Express server and production dependencies
- static/ — the browser application
- deploy-manifest.json — Amplify Hosting route and runtime configuration

The root amplify.yml uses this output directory. The application requires PostgreSQL at runtime; no database is provisioned automatically by the build.
