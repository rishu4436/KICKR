import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "app");

export default defineConfig({
  root,
  build: {
    outDir: path.resolve(root, "../dist/client"),
    emptyOutDir: true,
    rollupOptions: {
      input: {
        main: path.resolve(root, "index.html"),
        ops: path.resolve(root, "ops.html"),
        "match-ops": path.resolve(root, "match-ops.html"),
      },
    },
  },
});
