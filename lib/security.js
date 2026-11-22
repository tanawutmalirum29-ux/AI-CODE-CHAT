import crypto from "node:crypto";
import path from "node:path";

export function deriveDataKey(secret = process.env.DATA_KEY) {
  if (typeof secret !== "string" || secret.length < 32) {
    throw new Error("DATA_KEY must contain at least 32 characters.");
  }
  return crypto.createHash("sha256").update(secret, "utf8").digest();
}

export function encryptSecret(plainText, secret = process.env.DATA_KEY) {
  if (typeof plainText !== "string" || !plainText.trim()) {
    throw new Error("API key is required.");
  }
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", deriveDataKey(secret), iv);
  const encrypted = Buffer.concat([cipher.update(plainText.trim(), "utf8"), cipher.final()]);
  return {
    encrypted: encrypted.toString("base64"),
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64")
  };
}

export function decryptSecret(record, secret = process.env.DATA_KEY) {
  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    deriveDataKey(secret),
    Buffer.from(record.iv, "base64")
  );
  decipher.setAuthTag(Buffer.from(record.tag, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(record.encrypted, "base64")),
    decipher.final()
  ]).toString("utf8");
}

export function safeRelativePath(input) {
  if (typeof input !== "string" || input.length === 0 || input.length > 240) return null;
  if (input.includes("\0") || input.includes("\\") || input.startsWith("/") || /^[A-Za-z]:/.test(input)) return null;
  const parts = input.split("/");
  if (parts.some(part => part === "" || part === "." || part === "..")) return null;
  if (parts.some(part => part.length > 100)) return null;
  return parts.join("/");
}

export function safeJoin(root, relativePath) {
  const safe = safeRelativePath(relativePath);
  if (!safe) throw new Error("Unsafe file path.");
  const rootPath = path.resolve(root);
  const target = path.resolve(rootPath, ...safe.split("/"));
  if (!target.startsWith(rootPath + path.sep)) throw new Error("Unsafe file path.");
  return target;
}

export function isSensitiveWorkspacePath(relativePath) {
  const parts = relativePath.split("/");
  const base = parts.at(-1)?.toLowerCase() || "";
  return parts.some(part => [".git", "node_modules", ".ssh", ".aws"].includes(part.toLowerCase())) ||
    base === ".npmrc" ||
    base === "id_rsa" ||
    base === "id_ed25519" ||
    /^\.env(?:\.|$)/i.test(base) ||
    /(?:secret|credential|private[-_]?key)/i.test(base);
}
