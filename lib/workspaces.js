import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import yauzl from "yauzl";
import { isSensitiveWorkspacePath, safeJoin, safeRelativePath } from "./security.js";

const workspaces = new Map();
const MAX_ARCHIVE_FILES = 700;
const MAX_EXTRACTED_BYTES = 100 * 1024 * 1024;
const MAX_SINGLE_FILE_BYTES = 25 * 1024 * 1024;
const MAX_CONTEXT_CHARS = 90_000;
const TTL_MS = 6 * 60 * 60 * 1000;
const TEXT_EXTENSIONS = new Set([
  ".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx", ".json", ".html", ".htm", ".css",
  ".scss", ".md", ".txt", ".yml", ".yaml", ".xml", ".svg", ".py", ".sh", ".sql",
  ".go", ".rs", ".java", ".kt", ".swift", ".php", ".rb", ".toml", ".ini"
]);

function baseWorkspaceDir() {
  return process.env.LOCAL_WORKSPACE_DIR || "/tmp/ai-code-chat-workspaces";
}

function sessionFolder(sessionId) {
  return crypto.createHash("sha256").update(sessionId).digest("hex").slice(0, 24);
}

function cleanExpired() {
  const now = Date.now();
  for (const [id, workspace] of workspaces) {
    if (workspace.expiresAt < now) {
      workspaces.delete(id);
      fs.rm(workspace.root, { recursive: true, force: true }).catch(() => {});
    }
  }
}

function normalizeArchiveEntry(name) {
  if (typeof name !== "string" || name.includes("\0") || name.includes("\\") || name.startsWith("/") || /^[A-Za-z]:/.test(name)) {
    throw new Error("ZIP contains an unsafe file path.");
  }
  const trimmed = name.endsWith("/") ? name.slice(0, -1) : name;
  if (!trimmed) return null;
  return safeRelativePath(trimmed) || (() => { throw new Error("ZIP contains an unsafe file path."); })();
}

async function extractZip(buffer, destination) {
  await fs.mkdir(destination, { recursive: true });
  await new Promise((resolve, reject) => {
    yauzl.fromBuffer(buffer, { lazyEntries: true, validateEntrySizes: true, strictFileNames: true }, (openError, zip) => {
      if (openError) return reject(new Error("Could not read this ZIP file."));
      let fileCount = 0;
      let extractedBytes = 0;
      let finished = false;
      const fail = error => {
        if (finished) return;
        finished = true;
        try { zip.close(); } catch {}
        reject(error);
      };
      zip.on("error", fail);
      zip.on("end", () => {
        if (finished) return;
        finished = true;
        resolve();
      });
      zip.on("entry", entry => {
        if (finished) return;
        (async () => {
          fileCount += 1;
          if (fileCount > MAX_ARCHIVE_FILES) throw new Error("ZIP has too many entries (maximum 700).");
          const relative = normalizeArchiveEntry(entry.fileName);
          if (!relative) { zip.readEntry(); return; }
          const unixMode = (entry.externalFileAttributes >>> 16) & 0xffff;
          const fileType = unixMode & 0o170000;
          if (fileType === 0o120000 || (fileType && fileType !== 0o100000 && fileType !== 0o040000)) {
            throw new Error("ZIP contains a symbolic link or special file, which is not supported.");
          }
          const isDirectory = entry.fileName.endsWith("/") || fileType === 0o040000;
          const target = safeJoin(destination, relative);
          if (isDirectory) {
            await fs.mkdir(target, { recursive: true });
            zip.readEntry();
            return;
          }
          if (entry.uncompressedSize > MAX_SINGLE_FILE_BYTES) throw new Error("A file in this ZIP is larger than 25 MB.");
          extractedBytes += entry.uncompressedSize;
          if (extractedBytes > MAX_EXTRACTED_BYTES) throw new Error("ZIP expands beyond the 100 MB workspace limit.");
          if (entry.uncompressedSize > 1_000_000 && entry.compressedSize > 0 && entry.uncompressedSize / entry.compressedSize > 500) {
            throw new Error("ZIP has a suspicious compression ratio.");
          }
          await fs.mkdir(path.dirname(target), { recursive: true });
          zip.openReadStream(entry, (streamError, stream) => {
            if (streamError) return fail(streamError);
            pipeline(stream, createWriteStream(target, { flags: "wx", mode: 0o600 }))
              .then(() => zip.readEntry())
              .catch(fail);
          });
        })().catch(fail);
      });
      zip.readEntry();
    });
  });
}

export async function createWorkspace(sessionId, archiveBuffer, originalName) {
  cleanExpired();
  const id = crypto.randomUUID();
  const root = path.join(baseWorkspaceDir(), sessionFolder(sessionId), id);
  try {
    await extractZip(archiveBuffer, root);
    const workspace = { id, sessionId, root, originalName: String(originalName || "project.zip").slice(0, 100), expiresAt: Date.now() + TTL_MS };
    workspaces.set(id, workspace);
    return { id, files: await listWorkspaceFiles(workspace), expiresInHours: 6 };
  } catch (error) {
    await fs.rm(root, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

export function getWorkspace(sessionId, id) {
  cleanExpired();
  const workspace = workspaces.get(id);
  if (!workspace || workspace.sessionId !== sessionId) return null;
  workspace.expiresAt = Date.now() + TTL_MS;
  return workspace;
}

export async function listWorkspaceFiles(workspace) {
  const output = [];
  async function walk(directory, prefix = "") {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const relative = prefix ? prefix + "/" + entry.name : entry.name;
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        output.push({ path: relative + "/", type: "directory" });
        await walk(path.join(directory, entry.name), relative);
      } else if (entry.isFile()) {
        const stat = await fs.stat(path.join(directory, entry.name));
        output.push({ path: relative, type: "file", size: stat.size });
      }
      if (output.length >= 700) return;
    }
  }
  await walk(workspace.root);
  return output.slice(0, 700);
}

export async function buildWorkspaceContext(workspace) {
  const files = [];
  let total = 0;
  async function walk(directory, prefix = "") {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const relative = prefix ? prefix + "/" + entry.name : entry.name;
      if (entry.isSymbolicLink() || isSensitiveWorkspacePath(relative)) continue;
      if (entry.isDirectory()) {
        await walk(path.join(directory, entry.name), relative);
        continue;
      }
      if (!entry.isFile()) continue;
      const extension = path.extname(entry.name).toLowerCase();
      if (!TEXT_EXTENSIONS.has(extension) && !["package.json", "tsconfig.json", "Dockerfile", "Makefile"].includes(entry.name)) continue;
      const stat = await fs.stat(path.join(directory, entry.name));
      if (stat.size > 80_000) continue;
      const content = await fs.readFile(path.join(directory, entry.name), "utf8");
      if (content.includes("\u0000")) continue;
      const block = "\n--- FILE: " + relative + " ---\n" + content + "\n";
      if (total + block.length > MAX_CONTEXT_CHARS) break;
      files.push(block);
      total += block.length;
    }
  }
  await walk(workspace.root);
  if (!files.length) throw new Error("No readable source files were found in this ZIP.");
  return files.join("");
}

export async function applyWorkspaceChanges(workspace, changes) {
  if (!Array.isArray(changes) || changes.length < 1 || changes.length > 40) {
    throw new Error("The AI response must contain between 1 and 40 file changes.");
  }
  const validated = [];
  const seen = new Set();
  let bytes = 0;
  for (const change of changes) {
    const relative = safeRelativePath(change?.path);
    if (!relative || isSensitiveWorkspacePath(relative)) throw new Error("The AI attempted to change a protected or unsafe path.");
    if (seen.has(relative)) throw new Error("The AI returned duplicate changes for " + relative);
    if (typeof change.content !== "string") throw new Error("Invalid content for " + relative);
    bytes += Buffer.byteLength(change.content, "utf8");
    if (bytes > 2_000_000) throw new Error("The AI response is too large to apply.");
    validated.push({ relative, content: change.content });
    seen.add(relative);
  }
  for (const change of validated) {
    const target = safeJoin(workspace.root, change.relative);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, change.content, { encoding: "utf8", mode: 0o600 });
  }
  return validated.map(change => change.relative);
}

export async function archiveWorkspace(workspace, outputStream) {
  const archiver = (await import("archiver")).default;
  const archive = archiver("zip", { zlib: { level: 6 } });
  archive.on("warning", error => {
    if (error.code !== "ENOENT") archive.emit("error", error);
  });
  archive.on("error", error => outputStream.destroy(error));
  archive.pipe(outputStream);
  archive.directory(workspace.root, false);
  await archive.finalize();
}
