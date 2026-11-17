import { defineConfig } from "tsdown";
import { getAdapterEntries } from "../adapters/build.ts";

// `@tspg/adapters` is a devDependency on purpose: tsdown bundles what is not a dependency, so the
// published package carries the adapters and asks for no other package of this repository.
export default defineConfig({
  entry: {
    index: "src/index.ts",
    ...(await getAdapterEntries()),
  },
  format: "esm",
  dts: true,
  platform: "neutral",
  exports: true,
});
