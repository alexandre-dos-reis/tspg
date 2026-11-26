import { defineConfig } from "tsdown";

// The TanStack packages are peer dependencies, so tsdown leaves them out of the bundle.
export default defineConfig([
  {
    entry: { index: "src/index.ts" },
    format: "esm",
    dts: true,
    platform: "neutral",
    exports: true,
  },
  // The command line (`tspg-db`) runs on Node: it reads files and loads a driver. `@tspg/introspect` and the
  // adapters are inlined, so installing this package is all it takes; the drivers are the project's own.
  {
    entry: { bin: "src/bin.ts" },
    format: "esm",
    dts: false,
    platform: "node",
    clean: false,
    outExtensions: () => ({ js: ".js" }),
  },
]);
