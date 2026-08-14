/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { devMailbox } from "./scripts/dev-mailbox.ts";

export default defineConfig({
  plugins: [react(), devMailbox()],
  resolve: {
    alias: {
      "@core": fileURLToPath(new URL("./core", import.meta.url)),
      // libsodium-wrappers' published ESM entry has a broken relative import;
      // the CJS/UMD bundle resolves "libsodium" through node_modules correctly.
      "libsodium-wrappers": fileURLToPath(
        new URL("./node_modules/libsodium-wrappers/dist/modules/libsodium-wrappers.js", import.meta.url),
      ),
    },
  },
  build: {
    outDir: "dist",
    sourcemap: true,
  },
  test: {
    include: ["core/**/*.test.ts", "api/**/*.test.ts"],
    environment: "node",
    testTimeout: 30000,
  },
});