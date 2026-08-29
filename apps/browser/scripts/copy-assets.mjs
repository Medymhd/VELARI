// Copies the loadable-extension static assets into dist/ so the built folder
// can be loaded via chrome://extensions → "Load unpacked" (tsc only emits JS).
import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist");
mkdirSync(dist, { recursive: true });

for (const file of ["manifest.json", "icon.png"]) {
  copyFileSync(join(root, "src", file), join(dist, file));
  console.log(`copied ${file} → dist/`);
}
