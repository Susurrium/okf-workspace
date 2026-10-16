import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";

await mkdir("dist", { recursive: true });
const [apexStyles, okfStyles, apexPackage, tasksStyles, workbenchStyles] = await Promise.all([
  readFile("apex/styles.css", "utf8"),
  readFile("styles.css", "utf8"),
  readFile("apex/package.json", "utf8").then(JSON.parse),
  readFile("tasks-generated/styles.css", "utf8"),
  readFile("src/ui/workbench-appearance.css", "utf8"),
]);
await Promise.all([
  writeFile(
    "dist/styles.css",
    `/* Tasks 8.5.0 styles */\n${tasksStyles}\n\n/* Apex ${apexPackage.version} upstream styles */\n${apexStyles}\n\n/* OKF integration styles */\n${okfStyles}\n\n/* Workbench presentation */\n${workbenchStyles}`,
    "utf8",
  ),
  copyFile("manifest.json", "dist/manifest.json"),
]);
