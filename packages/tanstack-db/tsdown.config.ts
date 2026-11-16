import { defineConfig } from "tsdown";

// The TanStack packages are peer dependencies, so tsdown leaves them out of the bundle.
export default defineConfig({
  entry: { index: "src/index.ts" },
  format: "esm",
  dts: true,
  platform: "neutral",
  exports: true,
});
