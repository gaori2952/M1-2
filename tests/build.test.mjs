import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  copyFile,
  writeFile,
  readFile,
  rm,
  cp,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
async function fixture(fn) {
  const dir = await mkdtemp(join(tmpdir(), "m1-build-"));
  try {
    await copyFile("frontend/build-config.mjs", join(dir, "build-config.mjs"));
    for (const f of [
      "index.html",
      "styles.css",
      "app.js",
      "api.js",
      "auth.js",
      "card-editor.js",
      "card-renderer.js",
      "image-review.js",
      "review-images.js",
      "image-review.css",
    ])
      await writeFile(join(dir, f), "test asset");
    await cp("frontend/vendor", join(dir, "vendor"), { recursive: true });
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
const firebase = {
  apiKey: "AIza" + "A".repeat(35),
  authDomain: "example.firebaseapp.com",
  projectId: "example",
};
test("build exports public config and excludes backend secrets", () =>
  fixture(async (dir) => {
    const result = spawnSync(
      process.execPath,
      [join(dir, "build-config.mjs")],
      {
        env: {
          ...process.env,
          VERCEL: "1",
          API_BASE_URL: "https://api.example.com",
          FIREBASE_WEB_CONFIG: JSON.stringify(firebase),
          OPENAI_API_KEY: "must-not-be-exported",
          FIREBASE_SERVICE_ACCOUNT_JSON: "private-server-only",
        },
        encoding: "utf8",
      },
    );
    assert.equal(result.status, 0, result.stderr);
    const output = await readFile(join(dir, "public", "config.js"), "utf8");
    assert.match(output, /https:\/\/api.example.com/);
    assert.ok(!output.includes("must-not-be-exported"));
    assert.ok(!output.includes("private-server-only"));
    for (const name of [
      "image-review.js",
      "review-images.js",
      "image-review.css",
    ])
      assert.equal(
        await readFile(join(dir, "public", name), "utf8"),
        "test asset",
      );
  }));
test("production rejects missing config and private fields", () =>
  fixture(async (dir) => {
    for (const data of [{}, { ...firebase, private_key: "never-echo-this" }]) {
      const result = spawnSync(
        process.execPath,
        [join(dir, "build-config.mjs")],
        {
          env: {
            ...process.env,
            VERCEL: "1",
            API_BASE_URL: "https://api.example.com",
            FIREBASE_WEB_CONFIG: JSON.stringify(data),
          },
          encoding: "utf8",
        },
      );
      assert.notEqual(result.status, 0);
      assert.ok(!result.stderr.includes("never-echo-this"));
    }
  }));

test("production rejects a masked Firebase key before publishing it", () =>
  fixture(async (dir) => {
    for (const key of ["AIzaAAAA" + "•".repeat(31), "AIza" + "*".repeat(35)]) {
      const result = spawnSync(
        process.execPath,
        [join(dir, "build-config.mjs")],
        {
          env: {
            ...process.env,
            VERCEL: "1",
            API_BASE_URL: "https://api.example.com",
            FIREBASE_WEB_CONFIG: JSON.stringify({ ...firebase, apiKey: key }),
          },
          encoding: "utf8",
        },
      );
      assert.notEqual(result.status, 0);
      assert.ok(!result.stderr.includes(key));
    }
  }));
