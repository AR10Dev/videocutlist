import { existsSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const requiredFiles = [
  "go.mod",
  "cmd/videocutlist/main.go",
  "api/api.openapi.yaml",
  "web/package.json",
  "web/pnpm-lock.yaml",
  "web/src/main.tsx",
  "web/src/api.ts",
  "web/src/generated/effect-api.ts",
];

export function checkLayout(root) {
  const problems = [];
  for (const path of requiredFiles)
    if (!existsSync(join(root, path))) problems.push(`Missing required file: ${path}`);
  for (const path of ["client", "docs/contracts", "src"])
    if (existsSync(join(root, path))) problems.push(`Retired layout: ${path}`);

  const walk = (directory = "") => {
    for (const entry of readdirSync(join(root, directory), { withFileTypes: true })) {
      const path = directory ? `${directory}/${entry.name}` : entry.name;
      if (entry.name.startsWith(".") || ["node_modules", "dist"].includes(entry.name)) continue;
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile()) {
        if (entry.name === "go.mod" && path !== "go.mod")
          problems.push(`Nested Go module: ${path}`);
        if (entry.name.endsWith(".go") && !/^(cmd|internal|test)\//.test(path))
          problems.push(`Go source belongs in cmd/, internal/ or test/: ${path}`);
      }
    }
  };
  walk();
  return problems;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const problems = checkLayout(resolve(dirname(fileURLToPath(import.meta.url)), ".."));
  if (problems.length) {
    console.error(problems.join("\n"));
    process.exitCode = 1;
  } else console.log("Repository layout check passed.");
}
