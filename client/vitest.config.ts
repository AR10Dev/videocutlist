import { defineConfig } from "vitest/config";
import solid from "@solidjs/vite-plugin";
export default defineConfig({
  plugins: [solid()],
  test: { environment: "node", exclude: ["playwright/**", "node_modules/**"] },
});
