# AI Code Chat

An AI workspace with chat, code and generative media tools. Version 1 stores provider settings and projects by browser session; it does not include user accounts or login.

- **AI Chat** — switch between OpenUncensored and Venice chat models.
- **Code Workspace** — upload a project ZIP, ask an AI model to edit source files, then download the updated ZIP.
- **Image Studio** — generate and edit images through OpenUncensored or a configured ComfyUI server; ComfyUI inpainting is enabled only when its installed nodes support the workflow.
- **Video Studio** — run a trusted ComfyUI API-format video workflow, with optional starting-frame upload, prompt-node selection, progress, cancellation and result downloads.

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

### Locally Uncensored (engine profiles)

Locally Uncensored (LU) is a desktop application. It is not a hosted API, so it is added as a user-defined **engine profile** rather than a fixed provider. Existing providers are unchanged.

What LU documents and what this app uses:
- **Chat:** LU's Local API (Settings → Voice & Remote → Local API in LU) serves loaded models through an OpenAI-compatible address behind a token. The app calls `GET {chat URL}/models` and `POST {chat URL}/chat/completions` (streaming supported when the engine streams). These are the standard OpenAI-compatible routes; **press "ทดสอบการเชื่อมต่อ" to verify them against your engine** — they have not been verified against a live LU instance by the authors.
- **Image/Video:** LU's Local API remains Chat-only. Image and video generation connect to ComfyUI directly through its own API, configured separately in the same Engine Profile. The app does not send image/video requests to LU.

Deployment on AWS Amplify:
- Amplify cannot reach `localhost` on your machine. Expose LU's Local API and ComfyUI through an **HTTPS** tunnel or GPU server **with authentication** (token or an authenticating proxy). Never expose either without authentication.
- URLs must be HTTPS. Private, loopback, link-local and metadata addresses are refused, redirects are not followed and DNS results are checked at connection time (SSRF protection). `ENGINE_HOST_ALLOWLIST` / `ENGINE_ALLOW_HTTP` exist for self-hosted development only; leave them unset on Amplify.
- Tokens are encrypted with `DATA_KEY` (AES-256-GCM) and never sent back to the browser.
- Chat and ComfyUI use separate URLs, tokens and timeouts within an Engine Profile. A ComfyUI failure does not change the existing chat-provider configuration.
- All ComfyUI calls pass through the existing HTTPS/SSRF network guard. When Amplify hosts the app, configure a public HTTPS tunnel or GPU server with authentication; Amplify cannot reach a private localhost address.
- Server-wide profile: set `LU_CHAT_BASE_URL`, `LU_CHAT_TOKEN`, `LU_COMFY_BASE_URL`, `LU_COMFY_TOKEN`. Anyone with access to the app can then use that engine.

| Variable | Purpose |
| --- | --- |
| LU_CHAT_BASE_URL / LU_CHAT_TOKEN | Optional server-wide chat engine |
| COMFYUI_BASE_URL / COMFYUI_TOKEN | Optional server-wide ComfyUI (legacy LU_COMFY_* names remain accepted) |
| LU_COMFY_BASE_URL / LU_COMFY_TOKEN | Backwards-compatible ComfyUI variable names |
| LU_CHAT_TIMEOUT_MS / LU_COMFY_TIMEOUT_MS | Optional timeouts (5,000–600,000) |
| ENGINE_MAX_PER_SESSION | Saved profiles per session (default 5) |
| ENGINE_ALLOW_HTTP, ENGINE_HOST_ALLOWLIST | Development only |

LU is AGPL-3.0. This app talks to it over HTTP only and includes none of its code.

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

Use image and video models only for lawful content. Provider safety restrictions still apply, including restrictions on sexual content involving minors, non-consensual imagery and real people without their consent.

## Image and Video Studio

See [docs/MEDIA-STUDIO.md](docs/MEDIA-STUDIO.md) for configuration and workflow details. In brief:
- OpenUncensored remains the simple hosted option for image generation and image editing.
- ComfyUI provides Text-to-Image, Image-to-Image and Inpainting when `/object_info` confirms the required nodes and checkpoint models.
- Video Studio imports a ComfyUI **API prompt JSON** exported from a video workflow. Node classes and input names are validated against the selected server's `/object_info`; no universal video graph is assumed.
- ComfyUI owns its queue and history. The app does not add a second job database, worker, S3 bucket or media storage subsystem.
- Jobs and result routes are scoped to the browser session that submitted them. Image uploads are limited to PNG/JPEG/WebP and checked against file signatures.

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
