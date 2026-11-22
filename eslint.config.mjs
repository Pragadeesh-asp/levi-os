import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

export default defineConfig([
  ...nextVitals,
  ...nextTs,
  // public/sakuga-vfx holds vendored third-party files, kept byte-identical to upstream.
  globalIgnores([".next/**", "node_modules/**", "coverage/**", "public/sakuga-vfx/**"]),
]);
