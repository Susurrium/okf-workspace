import esbuild from "esbuild";

await esbuild.build({
  entryPoints: ["src/plugin/main.ts"],
  bundle: true,
  external: [
    "obsidian",
    "@codemirror/state",
    "@codemirror/view",
    "node:fs",
    "node:crypto",
    "node:child_process",
  ],
  format: "cjs",
  target: "es2022",
  sourcemap: false,
  treeShaking: true,
  outfile: "dist/main.js",
});
