# Image and Video Studio

The media workspace is an addition to the existing app. AI Chat, Code Workspace, existing providers, Locally Uncensored chat, Engine Profiles and the existing security layer remain available.

## Choose a generation backend

### OpenUncensored API

Use this for hosted Text-to-Image and image editing. Add the provider key in Settings & API. The provider decides which models are currently available and bills its own credits. This option does not need ComfyUI.

### ComfyUI server

Create or edit an Engine Profile in Settings & API and set its ComfyUI URL and optional Bearer token. The server must be reachable by the app backend. For an AWS Amplify deployment, use a public HTTPS tunnel or GPU server with authentication; `localhost` on the user's PC is not reachable from Amplify.

The app checks `/object_info` before showing ComfyUI image choices. Text-to-Image, Image-to-Image and Inpainting are available only when the required nodes, inputs, model choices and sampler/scheduler options are present. Inpainting provides a touch-friendly brush: red painted areas are uploaded as the green-channel mask with the resized source image.

Uploads accept PNG, JPEG and WebP only. The server validates magic bytes; file extensions and browser MIME values alone are not trusted.

## Video workflows

ComfyUI video models use different node graphs, model loaders, conditioning and video output nodes. The app therefore does not invent a generic Text-to-Video graph.

1. In ComfyUI, open a workflow that is already installed and configured with its models and custom nodes.
2. Export it in **API prompt format** (the JSON graph that maps numeric node IDs to `class_type` and `inputs`). A normal UI workflow JSON is not the API prompt format.
3. In Video Studio, select the ComfyUI Engine and import that JSON.
4. Choose the positive prompt node, optional negative prompt node and optional image input node. Add a starting frame when that workflow uses an image input.
5. Submit the job. The app checks every node class and input name against the selected server's `/object_info` and requires a recognized video output node before submission.

Only MP4, MOV and WebM result files are exposed by the app. Video downloads are streamed through the backend with a 1 GB size ceiling and a 15-minute transfer timeout. Unsupported or unrecognized output types are not presented as videos.

**Trust imported workflows.** A ComfyUI workflow can invoke custom nodes already installed on your server. Import only workflows from sources you trust and install custom nodes on the ComfyUI host deliberately.

## Queue, progress and privacy

ComfyUI itself owns job submission, queue, history and interruption. This app polls ComfyUI's `/queue` and `/history/{prompt_id}`, and cancels a running prompt with `/interrupt` or removes a pending prompt through `/queue`. It does not introduce a second job queue, worker, S3 bucket or media database.

Job status, cancellation and output routes are associated with the browser session that submitted the prompt. ComfyUI still stores generated files in its own configured output folder; delete and retention policies on the ComfyUI host remain authoritative.

Every engine request passes through `lib/engines/net-guard.js`: HTTPS is required by default, redirects are rejected, DNS is checked at connection time and private/reserved targets are blocked unless explicitly allowlisted for self-hosted development.

## What is and is not available

| Feature | Backend | Availability rule |
| --- | --- | --- |
| Text-to-Image | OpenUncensored | Provider catalogue and account key |
| Image editing | OpenUncensored | Provider edit models |
| Text-to-Image | ComfyUI | Checkpoint loader, prompt encoder, sampler, latent, decode and save nodes plus an installed checkpoint |
| Image-to-Image | ComfyUI | Text-to-Image nodes plus LoadImage and VAEEncode |
| Inpainting | ComfyUI | InpaintModelConditioning, LoadImageMask with green channel, and matching model/schema support |
| Text-to-Video / Image-to-Video | ComfyUI | User-imported API prompt workflow validated against installed nodes and a recognized video output node |
| LU Local API | Chat only | LU Local API is not used for image/video generation |

## Useful endpoints used by the adapter

These are ComfyUI routes used by its documented server implementation, not routes invented by this application:

- `GET /object_info`
- `POST /upload/image`
- `POST /prompt`
- `GET /queue`
- `GET /history/{prompt_id}`
- `GET /view`
- `POST /interrupt`

The browser only calls this app's authenticated `/api/engines/:id/comfy/...` endpoints; it does not receive or store the ComfyUI token.
