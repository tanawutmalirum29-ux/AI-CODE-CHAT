import crypto from "node:crypto";
import { EngineError, guardedRequest, guardedStreamRequest, parseEngineUrl, defaultPolicy } from "./net-guard.js";

const json = buffer => {
  try { return JSON.parse(buffer.toString("utf8")); } catch { return null; }
};
const auth = (profile, token) => profile.comfyAuthScheme !== "none" && token ? { Authorization: "Bearer " + token } : {};

function routeUrl(base, route, policy, query = {}) {
  const parsed = parseEngineUrl(base, policy);
  const url = new URL(parsed.origin + parsed.pathname.replace(/\/+$/, "") + route);
  for (const [key, value] of Object.entries(query)) if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
  return url;
}

async function requestJson(profile, token, route, { method = "GET", body, policy = defaultPolicy(), timeoutMs, maxBytes = 4 * 1024 * 1024, query } = {}) {
  if (!profile?.comfyUrl) throw new EngineError("This engine has no ComfyUI URL configured.", { code: "no_comfy_url", status: 400 });
  const url = routeUrl(profile.comfyUrl, route, policy, query);
  const headers = { Accept: "application/json", ...auth(profile, token) };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const result = await guardedRequest({
    url, method, headers, body: body === undefined ? undefined : JSON.stringify(body),
    timeoutMs: timeoutMs || profile.comfyTimeoutMs || 300_000, maxBytes, policy
  });
  const payload = json(result.body);
  if (result.status < 200 || result.status >= 300) {
    const detail = payload?.error?.message || payload?.message || "";
    throw new EngineError(`ComfyUI returned HTTP ${result.status}${detail ? `: ${String(detail).slice(0, 240)}` : ""}`, {
      code: result.status === 401 || result.status === 403 ? "unauthorized" : result.status === 404 ? "not_found" : "comfy_error",
      status: result.status === 401 || result.status === 403 ? 401 : result.status === 429 ? 429 : 502
    });
  }
  if (payload === null) throw new EngineError("ComfyUI returned invalid JSON.", { code: "bad_response" });
  return payload;
}

function nodeInputs(nodeInfo) {
  return nodeInfo?.input?.required || {};
}

function choices(nodeInfo, key) {
  const raw = nodeInputs(nodeInfo)[key];
  return Array.isArray(raw?.[0]) ? raw[0].filter(value => typeof value === "string") : [];
}

export async function fetchComfyObjectInfo(profile, token, policy = defaultPolicy()) {
  return requestJson(profile, token, "/object_info", {
    policy,
    timeoutMs: Math.min(profile.comfyTimeoutMs || 300_000, 60_000),
    maxBytes: 25 * 1024 * 1024
  });
}

export async function inspectComfyCapabilities(profile, token, policy = defaultPolicy()) {
  const objectInfo = await fetchComfyObjectInfo(profile, token, policy);
  const nodes = new Set(Object.keys(objectInfo || {}));
  const inputExists = (nodeName, inputName) => {
    const input = objectInfo[nodeName]?.input || {};
    return Object.prototype.hasOwnProperty.call(input.required || {}, inputName)
      || Object.prototype.hasOwnProperty.call(input.optional || {}, inputName);
  };
  const schemaExists = specs => specs.every(([node, inputs]) => nodes.has(node) && inputs.every(input => inputExists(node, input)));
  const choicesFor = (nodeName, key) => choices(objectInfo[nodeName], key);
  const checkpointModels = choicesFor("CheckpointLoaderSimple", "ckpt_name");
  const samplerChoices = choicesFor("KSampler", "sampler_name");
  const schedulerChoices = choicesFor("KSampler", "scheduler");
  const common = [
    ["CheckpointLoaderSimple", ["ckpt_name"]],
    ["CLIPTextEncode", ["text", "clip"]],
    ["KSampler", ["seed", "steps", "cfg", "sampler_name", "scheduler", "denoise", "model", "positive", "negative", "latent_image"]],
    ["VAEDecode", ["samples", "vae"]],
    ["SaveImage", ["filename_prefix", "images"]]
  ];
  const txt2imgSpecs = [...common, ["EmptyLatentImage", ["width", "height", "batch_size"]]];
  const img2imgSpecs = [...common, ["LoadImage", ["image"]], ["VAEEncode", ["pixels", "vae"]]];
  const inpaintSpecs = [...common, ["LoadImage", ["image"]], ["LoadImageMask", ["image", "channel"]],
    ["InpaintModelConditioning", ["positive", "negative", "vae", "pixels", "mask", "noise_mask"]]];
  const greenMaskSupported = choicesFor("LoadImageMask", "channel").includes("green");
  const hasModels = checkpointModels.length > 0;
  const hasSamplers = samplerChoices.length > 0 && schedulerChoices.length > 0;
  const missingFor = specs => {
    const missing = [];
    for (const [node, inputs] of specs) {
      if (!nodes.has(node)) { missing.push(node); continue; }
      for (const input of inputs) if (!inputExists(node, input)) missing.push(`${node}.${input}`);
    }
    if (!hasModels) missing.push("CheckpointLoaderSimple.ckpt_name models");
    if (!hasSamplers) missing.push("KSampler sampler/scheduler choices");
    return missing;
  };
  const image = {
    txt2img: schemaExists(txt2imgSpecs) && hasModels && hasSamplers,
    img2img: schemaExists(img2imgSpecs) && hasModels && hasSamplers,
    inpaint: schemaExists(inpaintSpecs) && greenMaskSupported && hasModels && hasSamplers,
    models: checkpointModels,
    samplers: samplerChoices,
    schedulers: schedulerChoices,
    missing: {
      txt2img: missingFor(txt2imgSpecs),
      img2img: missingFor(img2imgSpecs),
      inpaint: [...missingFor(inpaintSpecs), ...(greenMaskSupported ? [] : ["LoadImageMask.channel=green"]) ]
    }
  };
  const videoOutputNodes = ["SaveVideo", "SaveWEBM", "VHS_VideoCombine", "VideoCombine"].filter(name => nodes.has(name));
  return {
    checkedAt: new Date().toISOString(),
    nodeCount: nodes.size,
    image,
    video: {
      customWorkflow: videoOutputNodes.length > 0,
      outputNodes: videoOutputNodes,
      reason: videoOutputNodes.length
        ? "A video output node is installed. Import a trusted ComfyUI API workflow; every node is checked against /object_info before submission."
        : "No supported video output node was detected. Install a ComfyUI video output node and refresh capabilities."
    }
  };
}

const boundedInt = (value, fallback, min, max, multiple = 1) => {
  const n = Number(value);
  const whole = Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : fallback;
  return Math.max(min, Math.floor(whole / multiple) * multiple);
};

export function buildImageWorkflow({ type, params, capabilities, imageName, maskName }) {
  const operation = type === "image.txt2img" ? "txt2img" : type === "image.img2img" ? "img2img" : type === "image.inpaint" ? "inpaint" : null;
  if (!operation) throw new EngineError("Unsupported ComfyUI image job type.", { code: "unsupported_job", status: 400 });
  if (!capabilities?.image?.[operation]) {
    const missing = capabilities?.image?.missing?.[operation] || [];
    throw new EngineError(`This ComfyUI installation does not support ${operation}. Missing: ${missing.join(", ") || "required nodes or checkpoint models"}.`, { code: "capability_missing", status: 409 });
  }
  const model = String(params.model || "");
  if (!capabilities.image.models.includes(model)) throw new EngineError("Choose a checkpoint model discovered from ComfyUI /object_info.", { code: "model_not_available", status: 400 });
  const width = boundedInt(params.width, 1024, 256, 2048, 8);
  const height = boundedInt(params.height, 1024, 256, 2048, 8);
  const count = boundedInt(params.count, 1, 1, 4);
  const steps = boundedInt(params.steps, 24, 1, 60);
  const cfg = Math.min(20, Math.max(1, Number(params.cfg) || 7));
  const seedRaw = Number(params.seed);
  const seed = Number.isSafeInteger(seedRaw) && seedRaw >= 0 ? seedRaw : crypto.randomInt(0, 2 ** 31);
  const sampler = capabilities.image.samplers.includes(params.sampler) ? params.sampler : capabilities.image.samplers[0];
  const scheduler = capabilities.image.schedulers.includes(params.scheduler) ? params.scheduler : capabilities.image.schedulers[0];
  if (!sampler || !scheduler) throw new EngineError("The installed KSampler does not report a supported sampler and scheduler.", { code: "capability_missing", status: 409 });
  const prompt = String(params.prompt || "").trim();
  const negative = String(params.negativePrompt || "").slice(0, 3000);
  if (!prompt || prompt.length > 8000) throw new EngineError("Enter a prompt (maximum 8,000 characters).", { code: "invalid_prompt", status: 400 });

  const graph = {
    "1": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: model } },
    "2": { class_type: "CLIPTextEncode", inputs: { text: prompt, clip: ["1", 1] } },
    "3": { class_type: "CLIPTextEncode", inputs: { text: negative, clip: ["1", 1] } },
    "5": { class_type: "KSampler", inputs: {
      seed, steps, cfg, sampler_name: sampler, scheduler, denoise: 1.0,
      model: ["1", 0], positive: ["2", 0], negative: ["3", 0], latent_image: null
    } },
    "6": { class_type: "VAEDecode", inputs: { samples: ["5", 0], vae: ["1", 2] } },
    "7": { class_type: "SaveImage", inputs: { filename_prefix: "ai-code-chat", images: ["6", 0] } }
  };

  if (operation === "txt2img") {
    graph["4"] = { class_type: "EmptyLatentImage", inputs: { width, height, batch_size: count } };
    graph["5"].inputs.latent_image = ["4", 0];
  } else if (operation === "img2img") {
    if (!imageName) throw new EngineError("An uploaded source image is required.", { code: "source_image_required", status: 400 });
    graph["4"] = { class_type: "LoadImage", inputs: { image: imageName } };
    graph["8"] = { class_type: "VAEEncode", inputs: { pixels: ["4", 0], vae: ["1", 2] } };
    graph["5"].inputs.latent_image = ["8", 0];
    graph["5"].inputs.denoise = Math.min(1, Math.max(0.05, Number(params.denoise) || 0.65));
  } else {
    if (!imageName || !maskName) throw new EngineError("Inpainting needs both a source image and a mask image.", { code: "inpaint_inputs_required", status: 400 });
    graph["4"] = { class_type: "LoadImage", inputs: { image: imageName } };
    graph["8"] = { class_type: "LoadImageMask", inputs: { image: maskName, channel: "green" } };
    graph["9"] = { class_type: "InpaintModelConditioning", inputs: {
      positive: ["2", 0], negative: ["3", 0], vae: ["1", 2], pixels: ["4", 0], mask: ["8", 0], noise_mask: true
    } };
    graph["5"].inputs.positive = ["9", 0];
    graph["5"].inputs.negative = ["9", 1];
    graph["5"].inputs.latent_image = ["9", 2];
    graph["5"].inputs.denoise = Math.min(1, Math.max(0.05, Number(params.denoise) || 0.85));
  }
  return { prompt: graph, client_id: crypto.randomUUID() };
}

function multipart({ field, fileName, mime, buffer, boundary }) {
  const header = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${field}"; filename="${fileName}"\r\nContent-Type: ${mime}\r\n\r\n`);
  const footer = Buffer.from(`\r\n--${boundary}--\r\n`);
  return Buffer.concat([header, buffer, footer]);
}

export async function uploadComfyImage({ profile, token, buffer, mime, fileName, policy = defaultPolicy() }) {
  const boundary = "----ai-code-chat-" + crypto.randomBytes(12).toString("hex");
  const extension = mime === "image/jpeg" ? "jpg" : mime === "image/webp" ? "webp" : "png";
  const safeName = typeof fileName === "string" && /^[a-zA-Z0-9_-]{1,50}\.[a-zA-Z0-9]{2,5}$/.test(fileName)
    ? fileName : `reference-${crypto.randomUUID()}.${extension}`;
  const body = multipart({ field: "image", fileName: safeName, mime, buffer, boundary });
  const url = routeUrl(profile.comfyUrl, "/upload/image", policy);
  const result = await guardedRequest({
    url, method: "POST", headers: { ...auth(profile, token), "Content-Type": `multipart/form-data; boundary=${boundary}`, "Content-Length": String(body.length), Accept: "application/json" },
    body, timeoutMs: Math.min(profile.comfyTimeoutMs || 300_000, 120_000), maxBytes: 1024 * 1024, policy
  });
  const payload = json(result.body);
  if (result.status < 200 || result.status >= 300 || typeof payload?.name !== "string") {
    throw new EngineError(`ComfyUI image upload failed (HTTP ${result.status}).`, { code: "comfy_upload_failed", status: 502 });
  }
  return payload;
}

export async function submitComfyPrompt({ profile, token, workflow, policy = defaultPolicy() }) {
  const payload = await requestJson(profile, token, "/prompt", { method: "POST", body: workflow, policy, timeoutMs: Math.min(profile.comfyTimeoutMs || 300_000, 60_000) });
  if (typeof payload.prompt_id !== "string" || !payload.prompt_id) {
    throw new EngineError("ComfyUI did not return a prompt_id.", { code: "comfy_bad_prompt_response" });
  }
  if (payload.node_errors && Object.keys(payload.node_errors).length) {
    throw new EngineError("ComfyUI rejected part of the workflow. Check installed nodes and models.", { code: "comfy_node_validation", status: 409 });
  }
  return payload;
}

export async function fetchComfyQueue({ profile, token, policy = defaultPolicy() }) {
  return requestJson(profile, token, "/queue", { policy, timeoutMs: 15_000, maxBytes: 2 * 1024 * 1024 });
}

export async function fetchComfyHistory({ profile, token, promptId, policy = defaultPolicy() }) {
  return requestJson(profile, token, `/history/${encodeURIComponent(promptId)}`, { policy, timeoutMs: 20_000, maxBytes: 8 * 1024 * 1024 });
}

export async function waitForComfyResult({ profile, token, promptId, signal, onProgress = () => {}, shouldCancel = async () => false, policy = defaultPolicy(), pollMs = 1500 }) {
  const deadline = Date.now() + (profile.comfyTimeoutMs || 300_000);
  let lastPhase = "queued";
  while (Date.now() < deadline) {
    if (signal?.aborted || await shouldCancel()) {
      await cancelComfyPrompt({ profile, token, promptId, policy }).catch(() => {});
      throw new EngineError("Job cancelled.", { code: "cancelled", status: 409 });
    }
    const [history, queue] = await Promise.all([
      fetchComfyHistory({ profile, token, promptId, policy }),
      fetchComfyQueue({ profile, token, policy }).catch(() => null)
    ]);
    const item = history?.[promptId];
    if (item) {
      const status = item.status || {};
      if (status.completed === false && status.status_str === "error") {
        throw new EngineError("ComfyUI failed to execute the workflow. Review the node errors in ComfyUI.", { code: "comfy_execution_failed" });
      }
      const outputs = item.outputs || {};
      const images = [];
      for (const node of Object.values(outputs)) {
        for (const image of node.images || []) if (image?.filename) images.push(image);
      }
      if (images.length) {
        onProgress({ phase: "complete", progress: 100 });
        return { images, promptId, status };
      }
      if (status.completed) throw new EngineError("ComfyUI completed but returned no image outputs.", { code: "empty_comfy_output" });
    }
    const running = (queue?.queue_running || []).some(entry => Array.isArray(entry) && entry[1] === promptId);
    const pending = (queue?.queue_pending || []).some(entry => Array.isArray(entry) && entry[1] === promptId);
    const phase = running ? "running" : pending ? "queued" : lastPhase;
    if (phase !== lastPhase) { lastPhase = phase; onProgress({ phase, progress: null }); }
    await new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, pollMs);
      if (signal) signal.addEventListener("abort", () => { clearTimeout(timer); reject(new EngineError("Job cancelled.", { code: "cancelled", status: 409 })); }, { once: true });
    });
  }
  throw new EngineError("ComfyUI job timed out. The job may still need to be interrupted in ComfyUI.", { code: "comfy_timeout", status: 504 });
}

export async function getComfyOutput({ profile, token, file, policy = defaultPolicy(), maxBytes = 30 * 1024 * 1024 }) {
  const url = routeUrl(profile.comfyUrl, "/view", policy, { filename: file.filename, subfolder: file.subfolder || "", type: file.type || "output" });
  const result = await guardedRequest({ url, method: "GET", headers: { ...auth(profile, token), Accept: "image/png,image/webp,image/jpeg,video/mp4,video/webm,video/quicktime,application/octet-stream" }, timeoutMs: profile.comfyTimeoutMs || 300_000, maxBytes, policy });
  if (result.status < 200 || result.status >= 300) throw new EngineError(`Could not retrieve ComfyUI output (HTTP ${result.status}).`, { code: "comfy_output_failed" });
  return result.body;
}

export async function streamComfyOutput({ profile, token, file, policy = defaultPolicy() }) {
  const url = routeUrl(profile.comfyUrl, "/view", policy, {
    filename: file.filename, subfolder: file.subfolder || "", type: file.type || "output"
  });
  const result = await guardedStreamRequest({
    url, method: "GET",
    headers: { ...auth(profile, token), Accept: "image/png,image/webp,image/jpeg,video/mp4,video/webm,video/quicktime,application/octet-stream" },
    timeoutMs: Math.min(profile.comfyTimeoutMs || 300_000, 60_000), policy
  });
  if (result.status < 200 || result.status >= 300) {
    result.stream.resume();
    throw new EngineError(`Could not retrieve ComfyUI output (HTTP ${result.status}).`, { code: "comfy_output_failed" });
  }
  return result;
}

export async function cancelComfyPrompt({ profile, token, promptId, policy = defaultPolicy() }) {
  const queue = await fetchComfyQueue({ profile, token, policy });
  const running = (queue.queue_running || []).some(entry => Array.isArray(entry) && entry[1] === promptId);
  const pending = (queue.queue_pending || []).some(entry => Array.isArray(entry) && entry[1] === promptId);
  if (running) return requestJson(profile, token, "/interrupt", { method: "POST", body: { prompt_id: promptId }, policy, timeoutMs: 20_000 });
  if (pending) return requestJson(profile, token, "/queue", { method: "POST", body: { delete: [promptId] }, policy, timeoutMs: 20_000 });
  return { cancelled: false, phase: "not-in-queue" };
}
