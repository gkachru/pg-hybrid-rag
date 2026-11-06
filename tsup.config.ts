import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm", "cjs"],
  dts: true,
  splitting: false,
  sourcemap: true,
  clean: true,
  target: "es2022",
  // Shims import.meta.url in the CJS build (ragMigrate locates the package's sql/ directory with it).
  shims: true,
});
