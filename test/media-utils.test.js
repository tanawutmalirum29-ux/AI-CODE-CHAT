import test from "node:test";
import assert from "node:assert/strict";
import { hasValidImageSignature, comfyOutputFiles, validateComfyWorkflowGraph, rememberComfySessionJob, ownsComfySessionJob, COMFY_SESSION_JOB_TTL } from "../lib/engines/media-utils.js";

const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]);
const jpeg = Buffer.from([255, 216, 255, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
const webp = Buffer.from("RIFF0000WEBP", "ascii");

test("image upload validation checks PNG, JPEG and WebP magic bytes", () => {
  assert.equal(hasValidImageSignature({ mimetype: "image/png", buffer: png }), true);
  assert.equal(hasValidImageSignature({ mimetype: "image/jpeg", buffer: jpeg }), true);
  assert.equal(hasValidImageSignature({ mimetype: "image/webp", buffer: webp }), true);
  assert.equal(hasValidImageSignature({ mimetype: "image/gif", buffer: Buffer.from("GIF89a123456") }), false);
  assert.equal(hasValidImageSignature({ mimetype: "image/png", buffer: Buffer.from("not an image") }), false);
  assert.equal(hasValidImageSignature({ mimetype: "image/jpeg", buffer: png }), false);
});

test("ComfyUI output collection accepts media outputs and ignores unknown or unsafe extensions", () => {
  const files = comfyOutputFiles({ outputs: {
    "1": { images: [{ filename: "still.png" }, { filename: "ignored.svg" }], gifs: [{ filename: "clip.webp" }] },
    "2": { videos: [{ filename: "render.mp4", subfolder: "video", type: "output" }, { filename: "render.webm" }] },
    "3": { files: [{ filename: "bad.exe" }, { filename: "../secret.png" }, { filename: "ok.png", subfolder: "../private" }] }
  } });
  assert.deepEqual(files.map(file => file.filename), ["still.png", "clip.webp", "render.mp4", "render.webm"]);
  assert.equal(files[2].subfolder, "video");
});

test("ComfyUI workflow validation requires installed nodes, supported inputs and a video output node", () => {
  const info = {
    CLIPTextEncode: { input: { required: { text: ["STRING", {}] }, optional: {} } },
    SaveVideo: { input: { required: { video: ["VIDEO", {}] }, optional: {} } },
    LoadImage: { input: { required: { image: [["upload.png"], {}] }, optional: {} } }
  };
  const graph = {
    "1": { class_type: "CLIPTextEncode", inputs: { text: "" } },
    "2": { class_type: "SaveVideo", inputs: { video: ["3", 0] } },
    "3": { class_type: "LoadImage", inputs: { image: "sample.png" } }
  };
  assert.equal(validateComfyWorkflowGraph(graph, info), null);
  assert.match(validateComfyWorkflowGraph({ "1": graph["1"] }, info), /video output node/);
  assert.match(validateComfyWorkflowGraph({ "1": { class_type: "SaveVideo", inputs: { video: ["999", 0] } } }, info), /links to missing node/);
  assert.match(validateComfyWorkflowGraph({ "1": { class_type: "MissingNode", inputs: {} } }, info), /not installed/);
  assert.match(validateComfyWorkflowGraph({ "1": { class_type: "CLIPTextEncode", inputs: { unknown: "value" } }, "2": graph["2"] }, info), /not present in the installed \/object_info schema/);
  assert.match(validateComfyWorkflowGraph({ "../1": graph["1"] }, info), /invalid/);
  assert.match(validateComfyWorkflowGraph([], info), /object/);
});

test("ComfyUI workflow node limits are enforced", () => {
  const graph = {};
  for (let i = 1; i <= 201; i++) graph[String(i)] = { class_type: "SaveVideo", inputs: {} };
  assert.match(validateComfyWorkflowGraph(graph, { SaveVideo: {} }), /between 1 and 200/);
});


test("ComfyUI jobs and outputs are scoped to the submitting browser session", () => {
  const userA = {};
  const userB = {};
  const now = 1_000_000;
  rememberComfySessionJob(userA, "engine-a", "11111111-1111-4111-8111-111111111111", now);
  assert.equal(ownsComfySessionJob(userA, "engine-a", "11111111-1111-4111-8111-111111111111", now + 1), true);
  assert.equal(ownsComfySessionJob(userB, "engine-a", "11111111-1111-4111-8111-111111111111", now + 1), false);
  assert.equal(ownsComfySessionJob(userA, "engine-b", "11111111-1111-4111-8111-111111111111", now + 1), false);
  assert.equal(ownsComfySessionJob(userA, "engine-a", "11111111-1111-4111-8111-111111111111", now + COMFY_SESSION_JOB_TTL + 1), false);
});

test("ComfyUI session job tracking is capped at the latest 50 active references", () => {
  const session = {};
  for (let i = 1; i <= 55; i++) rememberComfySessionJob(session, "engine", String(i), i * 1000);
  assert.equal(Object.keys(session.comfyJobs).length, 50);
  assert.equal(ownsComfySessionJob(session, "engine", "55", 56_000), true);
  assert.equal(ownsComfySessionJob(session, "engine", "1", 56_000), false);
});
