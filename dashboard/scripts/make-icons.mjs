import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(scriptDir, "../..");
const src = process.env.SARATHY_LOGO || path.join(root, "sarathy_logo.png");
const outDir = path.resolve(scriptDir, "../public/icons");

const sizes = [
  { name: "icon-192.png", size: 192, maskable: false },
  { name: "icon-512.png", size: 512, maskable: false },
  { name: "icon-512-maskable.png", size: 512, maskable: true },
  { name: "icon-180.png", size: 180, maskable: false },
];

await mkdir(outDir, { recursive: true });

for (const { name, size, maskable } of sizes) {
  let image = sharp(src).resize(size, size, { fit: "contain", background: { r: 9, g: 9, b: 11, alpha: 1 } });
  if (maskable) {
    const side = Math.round(size * 1.5);
    image = sharp(src)
      .resize(side, side, { fit: "contain", background: { r: 9, g: 9, b: 11, alpha: 1 } })
      .resize(size, size, { fit: "cover" });
  }
  await image.png().toFile(path.join(outDir, name));
  console.log(`wrote ${path.join("public/icons", name)}`);
}