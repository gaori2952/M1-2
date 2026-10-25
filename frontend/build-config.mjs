import { mkdir, writeFile, copyFile, readFile, cp } from "node:fs/promises";
import { createHash } from "node:crypto";
const root = new URL("./", import.meta.url);
const raw = JSON.parse(process.env.FIREBASE_WEB_CONFIG || "{}");
const allowed = [
  "apiKey",
  "authDomain",
  "projectId",
  "appId",
  "messagingSenderId",
  "storageBucket",
];
if (Object.keys(raw).some((k) => !allowed.includes(k)))
  throw new Error(
    "FIREBASE_WEB_CONFIG must contain only public Firebase web configuration fields.",
  );
const api = new URL(process.env.API_BASE_URL || "http://localhost:8000");
if (
  !["http:", "https:"].includes(api.protocol) ||
  api.username ||
  api.password ||
  api.search ||
  api.hash
)
  throw new Error("Invalid API_BASE_URL");
if (
  process.env.VERCEL &&
  (api.protocol !== "https:" ||
    !raw.apiKey ||
    !raw.projectId ||
    !raw.authDomain)
)
  throw new Error(
    "Production requires HTTPS API_BASE_URL and Firebase public configuration.",
  );
if (process.env.VERCEL && !/^AIza[A-Za-z0-9_-]{35}$/.test(raw.apiKey))
  throw new Error(
    "Firebase apiKey is malformed or masked. Use the original public Web API key from Firebase project settings, not the masked display value.",
  );
const config = `window.APP_CONFIG = ${JSON.stringify({ apiBaseUrl: api.href.replace(/\/$/, ""), firebase: raw })};\n`;
await writeFile(new URL("config.js", root), config);
await mkdir(new URL("public/", root), { recursive: true });
for (const file of [
  "index.html",
  "styles.css",
  "growth.css",
  "growth.js",
  "app.js",
  "card-editor.js",
  "card-renderer.js",
  "image-review.js",
  "review-images.js",
  "image-review.css",
  "api.js",
  "auth.js",
  "config.js",
])
  await copyFile(new URL(file, root), new URL(`public/${file}`, root));
await cp(new URL("vendor/", root), new URL("public/vendor/", root), {
  recursive: true,
});
// Version asset URLs so browsers pick up new CSS/JS after each build.
const hash = createHash("sha256");
for (const file of [
  "styles.css",
  "growth.css",
  "growth.js",
  "app.js",
  "card-editor.js",
  "card-renderer.js",
  "image-review.js",
  "review-images.js",
  "image-review.css",
  "api.js",
  "auth.js",
  "config.js",
])
  hash.update(await readFile(new URL(file, root)));
const version = hash.digest("hex").slice(0, 10);
const html = await readFile(new URL("index.html", root), "utf8");
await writeFile(
  new URL("public/index.html", root),
  html.replace(
    /(href|src)="(styles\.css|growth\.css|image-review\.css|app\.js|config\.js)"/g,
    `$1="$2?v=${version}"`,
  ),
);
console.log("Built static frontend with public configuration only.");

for (const file of [
  "app.js",
  "card-editor.js",
  "card-renderer.js",
  "image-review.js",
]) {
  const js = await readFile(new URL(file, root), "utf8");
  await writeFile(
    new URL(`public/${file}`, root),
    js.replace(
      /from (["'])\.\/(api|auth|growth|card-editor|card-renderer|image-review|review-images)\.js\1/g,
      `from "./$2.js?v=${version}"`,
    ),
  );
}
