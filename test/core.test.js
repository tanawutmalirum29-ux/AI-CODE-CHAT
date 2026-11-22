import test from "node:test";
import assert from "node:assert/strict";
import { encryptSecret, decryptSecret, safeRelativePath, safeJoin, isSensitiveWorkspacePath } from "../lib/security.js";

const testKey = "unit-test-data-key-that-is-at-least-32-characters-long";

test("API secrets encrypt and decrypt with AES-GCM", () => {
  const encrypted = encryptSecret("ou-example-private-key", testKey);
  assert.notEqual(encrypted.encrypted, "ou-example-private-key");
  assert.equal(decryptSecret(encrypted, testKey), "ou-example-private-key");
});

test("tampered API secret fails authentication", () => {
  const encrypted = encryptSecret("private-key", testKey);
  encrypted.encrypted = Buffer.from("tampered").toString("base64");
  assert.throws(() => decryptSecret(encrypted, testKey));
});

test("short encryption key is rejected", () => {
  assert.throws(() => encryptSecret("api-key", "short"));
});

test("safe relative paths accept ordinary project files", () => {
  assert.equal(safeRelativePath("src/app.js"), "src/app.js");
  assert.equal(safeRelativePath("README.md"), "README.md");
});

test("path traversal and absolute paths are rejected", () => {
  assert.equal(safeRelativePath("../outside.txt"), null);
  assert.equal(safeRelativePath("src/../../outside.txt"), null);
  assert.equal(safeRelativePath("/etc/passwd"), null);
  assert.equal(safeRelativePath("C:/Windows/system.ini"), null);
  assert.equal(safeRelativePath("src\\app.js"), null);
});

test("safeJoin keeps targets inside the workspace", () => {
  assert.equal(safeJoin("/tmp/workspace", "src/app.js"), "/tmp/workspace/src/app.js");
  assert.throws(() => safeJoin("/tmp/workspace", "../../outside.txt"));
});

test("secret files and dependency folders are excluded from AI context", () => {
  assert.equal(isSensitiveWorkspacePath(".env"), true);
  assert.equal(isSensitiveWorkspacePath("config/.env.production"), true);
  assert.equal(isSensitiveWorkspacePath("node_modules/library/index.js"), true);
  assert.equal(isSensitiveWorkspacePath("src/app.js"), false);
});
