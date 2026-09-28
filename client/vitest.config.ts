import { defineConfig } from "vitest/config";
import solid from "vite-plugin-solid";
export default defineConfig({
  plugins: [solid()],
  test: {
    environment: "node",
    exclude: ["playwright/**", "playwright-real/**", "node_modules/**"],
  },
});
