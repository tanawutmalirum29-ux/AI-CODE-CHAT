import { decryptSecret } from "./security.js";
import { findProviderKey, removeProviderKey, upsertProviderKey } from "./database.js";

export const PROVIDERS = {
  openuncensored: {
    id: "openuncensored",
    name: "OpenUncensored",
    baseUrl: "https://api.openuncensored.com/v1",
    envName: "OPENUNCENSORED_API_KEY",
    defaultChatModel: "deepseek-v4.1-flash-1017-uncensored",
    description: "Uncensored text models, image generation and image editing."
  },
  venice: {
    id: "venice",
    name: "Venice",
    baseUrl: "https://api.venice.ai/api/v1",
    envName: "VENICE_API_KEY",
    defaultChatModel: "deepseek-v4-1-flash-1017-uncensored",
    description: "OpenAI-compatible text and image APIs, including uncensored models."
  }
};

export const DEFAULT_CHAT_MODELS = {
  openuncensored: [
    { id: "deepseek-v4.1-flash-1017-uncensored", name: "DeepSeek V4.1 Flash 1017 Uncensored" },
    { id: "abliterated-large-flash", name: "Abliterated Large Flash" }
  ],
  venice: [
    { id: "deepseek-v4-1-flash-1017-uncensored", name: "DeepSeek V4.1 Flash 1017 Uncensored" },
    { id: "glm-5.3-flash-uncensored", name: "GLM 5.3 Flash Uncensored" }
  ]
};

export const IMAGE_MODELS = [
  { id: "z-image-turbo", name: "Z-Image Turbo", operation: "generate", price: "$0.01 / image" },
  { id: "chroma", name: "Chroma", operation: "generate", price: "$0.01 / image" },
  { id: "qwen-image", name: "Qwen Image", operation: "generate", price: "$0.03 / image" },
  { id: "qwen-image-3-uncensored", name: "Qwen Image 3 Uncensored", operation: "generate", price: "$0.04 / image" },
  { id: "hidream-o1-dev", name: "HiDream O1 Dev", operation: "generate", price: "$0.02 / image" },
  { id: "juggernaut-xl", name: "Juggernaut XL", operation: "generate", price: "From $0.013 / image" },
  { id: "wai-illustrious", name: "WAI Illustrious", operation: "generate", price: "From $0.013 / image" },
  { id: "pony-diffusion-v6", name: "Pony Diffusion V6", operation: "generate", price: "From $0.013 / image" },
  { id: "qwen-edit-uncensored", name: "Qwen Edit Uncensored", operation: "edit", price: "$0.04 / image" },
  { id: "qwen-image-3-edit", name: "Qwen Image 3 Edit", operation: "edit", price: "From $0.04 / image" },
  { id: "seedream-v5-5-edit", name: "Seedream 5.5 Edit", operation: "edit", price: "Variable" },
  { id: "flux-2-klein-edit", name: "FLUX.2 Klein Edit", operation: "edit", price: "$0.05 / image" }
];

const IMAGE_GENERATION_IDS = new Set(IMAGE_MODELS.filter(model => model.operation === "generate").map(model => model.id));
const IMAGE_EDIT_IDS = new Set(IMAGE_MODELS.filter(model => model.operation === "edit").map(model => model.id));
const TIMEOUT_MS = 240_000;

function providerConfig(providerId) {
  const provider = PROVIDERS[providerId];
  if (!provider) throw new Error("Unknown AI provider.");
  return provider;
}

export async function getProviderKey(pool, sessionId, providerId) {
  const provider = providerConfig(providerId);
  const environmentKey = process.env[provider.envName];
  if (environmentKey) return environmentKey;
  if (!pool) return null;
  const row = await findProviderKey(pool, sessionId, providerId);
  if (!row) return null;
  try {
    return decryptSecret(row);
  } catch {
    throw new Error("Saved API key could not be decrypted. Check that DATA_KEY has not changed.");
  }
}

export async function saveProviderKey(pool, sessionId, providerId, encrypted) {
  providerConfig(providerId);
  if (!pool) throw new Error("DATABASE_URL is required to save provider API keys.");
  await upsertProviderKey(pool, sessionId, providerId, encrypted);
}

export async function deleteProviderKey(pool, sessionId, providerId) {
  providerConfig(providerId);
  if (pool) await removeProviderKey(pool, sessionId, providerId);
}

export async function providerStatuses(pool, sessionId) {
  const result = [];
  for (const provider of Object.values(PROVIDERS)) {
    const envConfigured = Boolean(process.env[provider.envName]);
    let storedConfigured = false;
    if (pool && !envConfigured) {
      const row = await findProviderKey(pool, sessionId, provider.id);
      storedConfigured = Boolean(row);
    }
    result.push({
      id: provider.id,
      name: provider.name,
      description: provider.description,
      configured: envConfigured || storedConfigured,
      managedByEnvironment: envConfigured
    });
  }
  return result;
}

function extractModelRows(payload) {
  if (Array.isArray(payload?.data)) return payload.data;
  if (Array.isArray(payload?.models)) return payload.models;
  if (Array.isArray(payload)) return payload;
  return [];
}

export async function listProviderModels(providerId, type, apiKey = null) {
  const provider = providerConfig(providerId);
  const isImage = type === "image";
  if (isImage && providerId !== "openuncensored") {
    return { models: [], defaultModel: null, source: "not-supported" };
  }
  const endpoint = isImage ? "/images/models" : "/models";
  try {
    const headers = apiKey ? { Authorization: "Bearer " + apiKey } : {};
    const response = await fetch(provider.baseUrl + endpoint, {
      headers,
      signal: AbortSignal.timeout(15_000)
    });
    if (!response.ok) throw new Error("Model catalogue unavailable.");
    const payload = await response.json();
    const rows = extractModelRows(payload);
    const models = rows
      .filter(row => typeof row?.id === "string")
      .filter(row => isImage ? (row.operations?.includes?.("generate") !== false) : row.modality !== "image")
      .map(row => ({
        id: row.id,
        name: row.name || row.id,
        description: row.description || "",
        modality: row.modality || (isImage ? "image" : "text"),
        pricing: row.pricing || null,
        operations: row.operations || []
      }));
    if (models.length) {
      return { models, defaultModel: isImage ? "z-image-turbo" : provider.defaultChatModel, source: "live" };
    }
  } catch {
    // Keep the workspace usable when a provider catalogue is temporarily unavailable.
  }
  if (isImage) {
    return {
      models: IMAGE_MODELS.filter(model => model.operation === "generate").map(({ id, name, price }) => ({ id, name, description: price })),
      defaultModel: "z-image-turbo",
      source: "fallback"
    };
  }
  return {
    models: DEFAULT_CHAT_MODELS[providerId],
    defaultModel: provider.defaultChatModel,
    source: "fallback"
  };
}

async function providerRequest(providerId, apiKey, route, body, options = {}) {
  const provider = providerConfig(providerId);
  const headers = { Authorization: "Bearer " + apiKey, ...options.headers };
  if (!options.formData) headers["Content-Type"] = "application/json";
  const response = await fetch(provider.baseUrl + route, {
    method: "POST",
    headers,
    body: options.formData || JSON.stringify(body),
    signal: AbortSignal.timeout(options.timeout || TIMEOUT_MS)
  });
  const text = await response.text();
  let payload;
  try { payload = JSON.parse(text); } catch { payload = { error: { message: text.slice(0, 500) } }; }
  if (!response.ok) {
    const message = payload?.error?.message || payload?.message || "AI provider returned HTTP " + response.status + ".";
    const error = new Error(String(message).slice(0, 600));
    error.status = response.status === 401 ? 401 : response.status === 429 ? 429 : 502;
    throw error;
  }
  return payload;
}

export async function createChatCompletion({ providerId, apiKey, model, messages, temperature = 0.7, maxTokens = 2048 }) {
  const provider = providerConfig(providerId);
  const body = { model, messages, temperature, max_tokens: maxTokens, stream: false };
  const payload = await providerRequest(providerId, apiKey, "/chat/completions", body);
  const choice = payload?.choices?.[0];
  const content = choice?.message?.content;
  const text = Array.isArray(content)
    ? content.map(part => part?.text || "").join("")
    : typeof content === "string" ? content : "";
  if (!text) throw new Error("The AI provider returned an empty response.");
  return {
    text,
    model: payload.model || model,
    usage: payload.usage || null,
    provider: payload.ou?.provider || provider.name,
    costUsd: payload.ou?.cost_usd ?? null,
    requestId: payload.ou?.request_id || null
  };
}

export async function generateImages({ apiKey, model, prompt, negativePrompt = "", size = "1024x1024", count = 1 }) {
  if (!IMAGE_GENERATION_IDS.has(model)) throw new Error("That model is not enabled for image generation.");
  const payload = await providerRequest("openuncensored", apiKey, "/images/generations", {
    model,
    prompt,
    negative_prompt: negativePrompt || undefined,
    size,
    n: count,
    response_format: "b64_json"
  });
  const images = (payload.data || []).map(item => {
    if (item.b64_json) return "data:image/png;base64," + item.b64_json;
    if (typeof item.url === "string" && item.url.startsWith("data:image/")) return item.url;
    return null;
  }).filter(Boolean);
  if (!images.length) throw new Error("The image provider returned no image data.");
  return { images, model: payload.model || model, costUsd: payload.ou?.cost_usd ?? null };
}

export async function editImages({ apiKey, model, prompt, size = "1024x1024", files }) {
  if (!IMAGE_EDIT_IDS.has(model)) throw new Error("That model is not enabled for image editing.");
  const form = new FormData();
  form.append("model", model);
  form.append("prompt", prompt);
  form.append("size", size);
  for (const file of files) {
    form.append("image[]", new Blob([file.buffer], { type: file.mimetype }), file.originalname || "reference.png");
  }
  const payload = await providerRequest("openuncensored", apiKey, "/images/edits", null, {
    formData: form,
    timeout: TIMEOUT_MS
  });
  const images = (payload.data || []).map(item => {
    if (item.b64_json) return "data:image/png;base64," + item.b64_json;
    if (typeof item.url === "string" && item.url.startsWith("data:image/")) return item.url;
    return null;
  }).filter(Boolean);
  if (!images.length) throw new Error("The image editing provider returned no image data.");
  return { images, model: payload.model || model, costUsd: payload.ou?.cost_usd ?? null };
}
