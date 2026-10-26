import { defineConfig } from "tsup";

export default defineConfig({
  entry: [
    "src/index.ts",
    "src/wire/index.ts",
    "src/panel/index.ts",
    "src/persist/index.ts",
  ],
  format: ["esm"],
  dts: false,
  clean: false,
  sourcemap: true,
  target: "es2022",
});
