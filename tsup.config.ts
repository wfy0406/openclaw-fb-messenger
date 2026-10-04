import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "index.ts",
    "setup-entry": "setup-entry.ts",
  },
  format: ["esm"],
  target: "node22",
  platform: "node",
  outDir: "dist",
  clean: true,
  dts: false,
  splitting: false,
  // The OpenClaw host supplies the plugin SDK at runtime — never bundle it.
  external: [/^openclaw($|\/)/],
});
