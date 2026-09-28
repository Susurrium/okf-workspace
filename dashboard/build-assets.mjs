import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";

await mkdir("dist", { recursive: true });
const [apexStyles, okfStyles] = await Promise.all([
  readFile("apex/styles.css", "utf8"),
  readFile("styles.css", "utf8"),
]);
await Promise.all([
  writeFile(
    "dist/styles.css",
    `/* Apex 2.5.4 upstream styles */\n${apexStyles}\n\n/* OKF integration styles */\n${okfStyles}`,
    "utf8",
  ),
  copyFile("manifest.json", "dist/manifest.json"),
]);
