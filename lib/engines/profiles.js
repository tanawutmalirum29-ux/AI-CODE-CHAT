import crypto from "node:crypto";
import { encryptSecret, decryptSecret } from "../security.js";
import { listEngineRows, findEngineRow, countEngineRows, insertEngineRow, updateEngineRow, removeEngineRow } from "../database.js";
import { EngineError, parseEngineUrl, defaultPolicy } from "./net-guard.js";

export const ENV_PROFILE_ID = "env";
const MAX_PROFILES = () => Math.max(1, Math.min(20, Number(process.env.ENGINE_MAX_PER_SESSION) || 5));
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SCHEMES = new Set(["bearer", "none"]);

export const isEngineProvider = value => typeof value === "string" && value.startsWith("engine:");
export const engineIdFromProvider = value => value.slice("engine:".length);

function clampTimeout(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(600_000, Math.max(5_000, Math.round(n)));
}

export function envProfile(env = process.env) {
  const comfyUrl = env.COMFYUI_BASE_URL || env.LU_COMFY_BASE_URL || "";
  const comfyToken = env.COMFYUI_TOKEN || env.LU_COMFY_TOKEN || "";
  const chatUrl = env.LU_CHAT_BASE_URL || "";
  if (!chatUrl && !comfyUrl) return null;
  const name = chatUrl && comfyUrl ? "Server Engine (LU Chat + ComfyUI)"
    : chatUrl ? "Locally Uncensored (Chat)" : "ComfyUI Server";
  return {
    profile: {
      id: ENV_PROFILE_ID, name, managedByEnvironment: true,
      chatUrl, authScheme: env.LU_CHAT_TOKEN ? "bearer" : "none", chatTimeoutMs: clampTimeout(env.LU_CHAT_TIMEOUT_MS, 120_000),
      comfyUrl, comfyAuthScheme: comfyToken ? "bearer" : "none", comfyTimeoutMs: clampTimeout(env.LU_COMFY_TIMEOUT_MS, 300_000)
    },
    chatToken: env.LU_CHAT_TOKEN || "",
    comfyToken
  };
}

export function validateProfileInput(body, policy = defaultPolicy()) {
  if (!body || typeof body !== "object") throw new EngineError("Invalid request.", { code: "invalid", status: 400 });
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name || name.length > 60) throw new EngineError("Enter a name (1–60 characters).", { code: "invalid", status: 400 });
  const chatUrl = typeof body.chatUrl === "string" ? body.chatUrl.trim() : "";
  const comfyUrl = typeof body.comfyUrl === "string" ? body.comfyUrl.trim() : "";
  if (!chatUrl && !comfyUrl) throw new EngineError("Set a chat URL or a ComfyUI URL.", { code: "invalid", status: 400 });
  if (chatUrl) parseEngineUrl(chatUrl, policy);
  if (comfyUrl) parseEngineUrl(comfyUrl, policy);
  const authScheme = body.authScheme === undefined ? "bearer" : body.authScheme;
  const comfyAuthScheme = body.comfyAuthScheme === undefined ? "bearer" : body.comfyAuthScheme;
  if (!SCHEMES.has(authScheme) || !SCHEMES.has(comfyAuthScheme)) throw new EngineError("Unsupported auth scheme.", { code: "invalid", status: 400 });
  const token = field => {
    if (field === undefined || field === null || field === "") return undefined;
    if (typeof field !== "string" || field.trim().length < 4 || field.length > 1024 || /[\r\n\0]/.test(field)) throw new EngineError("Enter a valid token.", { code: "invalid", status: 400 });
    return field.trim();
  };
  return {
    name, chatUrl, comfyUrl, authScheme, comfyAuthScheme,
    chatTimeoutMs: clampTimeout(body.chatTimeoutMs, 120_000),
    comfyTimeoutMs: clampTimeout(body.comfyTimeoutMs, 300_000),
    chatToken: token(body.chatToken), comfyToken: token(body.comfyToken),
    clearChatToken: body.clearChatToken === true, clearComfyToken: body.clearComfyToken === true
  };
}

function rowToProfile(row) {
  return {
    id: row.profile_id, name: row.name, managedByEnvironment: false,
    chatUrl: row.chat_url || "", authScheme: row.chat_auth_scheme, chatTimeoutMs: row.chat_timeout_ms,
    comfyUrl: row.comfy_url || "", comfyAuthScheme: row.comfy_auth_scheme, comfyTimeoutMs: row.comfy_timeout_ms,
    hasChatToken: Boolean(row.chat_token_enc), hasComfyToken: Boolean(row.comfy_token_enc)
  };
}

export function publicProfile(profile, extra = {}) {
  return {
    id: profile.id, name: profile.name, managedByEnvironment: Boolean(profile.managedByEnvironment),
    chatUrl: profile.chatUrl, authScheme: profile.authScheme, chatTimeoutMs: profile.chatTimeoutMs,
    comfyUrl: profile.comfyUrl, comfyAuthScheme: profile.comfyAuthScheme, comfyTimeoutMs: profile.comfyTimeoutMs,
    hasChatToken: Boolean(profile.hasChatToken), hasComfyToken: Boolean(profile.hasComfyToken), ...extra
  };
}

function needPool(pool) {
  if (!pool) throw new EngineError("Configure DATABASE_URL to save engine profiles.", { code: "no_database", status: 503 });
}

function decryptField(row, prefix) {
  if (!row[prefix + "_enc"]) return "";
  try { return decryptSecret({ encrypted: row[prefix + "_enc"], iv: row[prefix + "_iv"], tag: row[prefix + "_tag"] }); }
  catch { throw new EngineError("Saved engine token could not be decrypted. Check that DATA_KEY has not changed.", { code: "decrypt_failed", status: 500 }); }
}

export async function listProfiles(pool, sessionId) {
  const list = [];
  const fromEnv = envProfile();
  if (fromEnv) list.push(publicProfile({ ...fromEnv.profile, hasChatToken: Boolean(fromEnv.chatToken), hasComfyToken: Boolean(fromEnv.comfyToken) }));
  if (pool) list.push(...(await listEngineRows(pool, sessionId)).map(row => publicProfile(rowToProfile(row))));
  return list;
}

export async function getProfileWithTokens(pool, sessionId, id) {
  if (id === ENV_PROFILE_ID) {
    const fromEnv = envProfile();
    if (!fromEnv) throw new EngineError("Engine profile not found.", { code: "not_found", status: 404 });
    return fromEnv;
  }
  if (!UUID.test(id)) throw new EngineError("Engine profile not found.", { code: "not_found", status: 404 });
  needPool(pool);
  const row = await findEngineRow(pool, sessionId, id);
  if (!row) throw new EngineError("Engine profile not found.", { code: "not_found", status: 404 });
  return { profile: rowToProfile(row), chatToken: decryptField(row, "chat_token"), comfyToken: decryptField(row, "comfy_token") };
}

function tokenColumns(prefix, newToken, clear, existing) {
  if (newToken) { const e = encryptSecret(newToken); return { [prefix + "_enc"]: e.encrypted, [prefix + "_iv"]: e.iv, [prefix + "_tag"]: e.tag }; }
  if (clear || !existing) return { [prefix + "_enc"]: null, [prefix + "_iv"]: null, [prefix + "_tag"]: null };
  return { [prefix + "_enc"]: existing[prefix + "_enc"], [prefix + "_iv"]: existing[prefix + "_iv"], [prefix + "_tag"]: existing[prefix + "_tag"] };
}

function toRow(id, input, existing) {
  return {
    profile_id: id, name: input.name,
    chat_url: input.chatUrl || null, chat_auth_scheme: input.authScheme, chat_timeout_ms: input.chatTimeoutMs,
    comfy_url: input.comfyUrl || null, comfy_auth_scheme: input.comfyAuthScheme, comfy_timeout_ms: input.comfyTimeoutMs,
    ...tokenColumns("chat_token", input.chatToken, input.clearChatToken, existing),
    ...tokenColumns("comfy_token", input.comfyToken, input.clearComfyToken, existing)
  };
}

export async function createProfile(pool, sessionId, body, policy = defaultPolicy()) {
  needPool(pool);
  if (!process.env.DATA_KEY || process.env.DATA_KEY.length < 32) throw new EngineError("Configure DATA_KEY (at least 32 characters).", { code: "no_data_key", status: 503 });
  const input = validateProfileInput(body, policy);
  if (await countEngineRows(pool, sessionId) >= MAX_PROFILES()) throw new EngineError("Engine profile limit reached. Delete one first.", { code: "limit", status: 409 });
  const row = toRow(crypto.randomUUID(), input, null);
  await insertEngineRow(pool, sessionId, row);
  return publicProfile(rowToProfile(row));
}

export async function updateProfile(pool, sessionId, id, body, policy = defaultPolicy()) {
  needPool(pool);
  if (id === ENV_PROFILE_ID) throw new EngineError("This profile is managed by the server environment.", { code: "managed", status: 409 });
  if (!UUID.test(id)) throw new EngineError("Engine profile not found.", { code: "not_found", status: 404 });
  const existing = await findEngineRow(pool, sessionId, id);
  if (!existing) throw new EngineError("Engine profile not found.", { code: "not_found", status: 404 });
  const input = validateProfileInput(body, policy);
  const row = toRow(id, input, existing);
  await updateEngineRow(pool, sessionId, row);
  return publicProfile(rowToProfile(row));
}

export async function deleteProfile(pool, sessionId, id) {
  needPool(pool);
  if (id === ENV_PROFILE_ID) throw new EngineError("This profile is managed by the server environment.", { code: "managed", status: 409 });
  if (!UUID.test(id) || !(await removeEngineRow(pool, sessionId, id))) throw new EngineError("Engine profile not found.", { code: "not_found", status: 404 });
}

// Draft profiles (from the form, before saving) for Connection Test. Nothing is stored.
export function draftFromBody(body, fallbackTokens = {}, policy = defaultPolicy()) {
  const input = validateProfileInput(body, policy);
  return {
    profile: { id: "draft", name: input.name, chatUrl: input.chatUrl, authScheme: input.authScheme, chatTimeoutMs: input.chatTimeoutMs, comfyUrl: input.comfyUrl, comfyAuthScheme: input.comfyAuthScheme, comfyTimeoutMs: input.comfyTimeoutMs },
    chatToken: input.chatToken ?? fallbackTokens.chatToken ?? "",
    comfyToken: input.comfyToken ?? fallbackTokens.comfyToken ?? ""
  };
}
