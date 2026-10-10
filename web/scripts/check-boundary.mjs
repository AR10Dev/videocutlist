import ts from "typescript";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Exact capability exceptions, not directory exemptions.
export const adapters = {
  "api.ts": ["http"],
  "main.tsx": ["provider"],
  "features/app/server.ts": ["runtime", "persistence", "transport"],
  "features/app/syncCommand.ts": ["command"],
  "features/app/persistence.ts": ["storage", "persistence"],
  "features/access/bootstrap.ts": ["http", "command"],
  "features/media/thumbnail.ts": ["http"],
  "features/preview/resources.ts": ["http"],
  "features/preview/model.ts": ["http"],
  "features/projects/interchange.ts": ["http"],
  "features/queue/jobStream.ts": ["http"],
};

const execution = /^(runPromise(?:Exit)?|runFork|runSync(?:Exit)?|runCallback|runEffect)$/;
const storage = /^(localStorage|sessionStorage|indexedDB)$/;
const transport = /^(fetch|XMLHttpRequest|WebSocket|EventSource)$/;
const httpMethods = /^(request|assetRequest|mediaRequest|streamRequest|apiRequest)$/;

export function checkSource(path, source) {
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
  const aliases = new Map();
  const problems = [];
  const allowed = new Set(adapters[path] ?? []);
  const report = (node, capability, detail) => {
    if (allowed.has(capability)) return;
    const { line, character } = file.getLineAndCharacterOfPosition(node.getStart(file));
    problems.push(`${path}:${line + 1}:${character + 1}: ${capability} boundary: ${detail}`);
  };
  const origin = (node, seen = new Set()) => {
    if (ts.isIdentifier(node)) {
      if (seen.has(node.text)) return node.text;
      seen.add(node.text);
      const value = aliases.get(node.text);
      return value && typeof value !== "string" ? origin(value, seen) : (value ?? node.text);
    }
    if (ts.isPropertyAccessExpression(node))
      return `${origin(node.expression, seen)}.${node.name.text}`;
    if (
      ts.isElementAccessExpression(node) &&
      node.argumentExpression &&
      ts.isStringLiteral(node.argumentExpression)
    )
      return `${origin(node.expression, seen)}.${node.argumentExpression.text}`;
    if (
      ts.isParenthesizedExpression(node) ||
      ts.isAsExpression(node) ||
      ts.isNonNullExpression(node)
    )
      return origin(node.expression, seen);
    return "";
  };
  const collect = (node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const module = node.moduleSpecifier.text;
      const clause = node.importClause;
      if (clause && !clause.isTypeOnly) {
        if (/persistence|BrowserKeyValueStore/.test(module))
          report(node, "persistence", `import ${module}`);
        if (/\/http\//.test(module)) report(node, "http", `import ${module}`);
        if (clause.name) aliases.set(clause.name.text, module.split("/").at(-1));
        const bindings = clause.namedBindings;
        if (bindings && ts.isNamespaceImport(bindings))
          aliases.set(bindings.name.text, module.split("/").at(-1));
        if (bindings && ts.isNamedImports(bindings))
          for (const item of bindings.elements)
            if (!item.isTypeOnly) {
              const symbol = (item.propertyName ?? item.name).text;
              if (execution.test(symbol)) report(item, "execution", `import ${symbol}`);
              if (symbol === "apiRequest") report(item, "http", `import ${symbol}`);
              if (symbol === "RegistryProvider") report(item, "provider", `import ${symbol}`);
              if (symbol === "createNativeHttpClientLayer")
                report(item, "transport", `import ${symbol}`);
              const owner = module.split("/").at(-1);
              aliases.set(
                item.name.text,
                ["Atom", "Runtime", "ManagedRuntime", "AtomRegistry"].includes(owner)
                  ? `${owner}.${symbol}`
                  : symbol,
              );
            }
      }
    }
    if (ts.isVariableDeclaration(node) && node.initializer) {
      if (ts.isIdentifier(node.name)) aliases.set(node.name.text, node.initializer);
      if (ts.isObjectBindingPattern(node.name))
        for (const item of node.name.elements)
          if (ts.isIdentifier(item.name)) {
            const property = item.propertyName?.getText(file) ?? item.name.text;
            aliases.set(item.name.text, `${origin(node.initializer)}.${property}`);
          }
    }
    ts.forEachChild(node, collect);
  };
  collect(file);
  const visit = (node) => {
    // Imports, types and property labels are not runtime references.
    if (ts.isImportDeclaration(node) || ts.isTypeNode(node)) return;
    if (ts.isIdentifier(node) && storage.test(node.text)) report(node, "storage", node.text);
    if (ts.isPropertyAccessExpression(node) && storage.test(node.name.text))
      report(node, "storage", node.name.text);
    if (
      ts.isElementAccessExpression(node) &&
      node.argumentExpression &&
      ts.isStringLiteral(node.argumentExpression) &&
      storage.test(node.argumentExpression.text)
    )
      report(node, "storage", node.argumentExpression.text);
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      const name = origin(node);
      if (execution.test(name.split(".").at(-1))) report(node, "execution", name);
    }
    if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
      const name = origin(node.expression);
      const last = name.split(".").at(-1);
      if (transport.test(last) || httpMethods.test(last)) report(node, "http", name);
      if (execution.test(last)) report(node, "execution", name);
      if (
        /^(Atom|ManagedRuntime|Runtime|AtomRegistry|Registry)\.(make|runtime)$/.test(name) &&
        name !== "Atom.make"
      )
        report(node, "runtime", name);
      if (name === "AtomHttpApi.Service") report(node, "runtime", name);
      if (name === "Atom.fn" || name === "Atom.fnSync") report(node, "command", name);
      if (name === "Atom.kvs") report(node, "storage", name);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return [...new Set(problems)];
}

export function checkDirectory(root) {
  const problems = [];
  const walk = (directory) => {
    for (const item of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, item.name);
      if (item.isDirectory()) walk(path);
      else if (/\.[cm]?[jt]sx?$/.test(item.name) && !/\.test\.[jt]sx?$/.test(item.name)) {
        const name = relative(root, path).replaceAll("\\", "/");
        if (name === "generated/effect-api.ts") continue;
        problems.push(...checkSource(name, readFileSync(path, "utf8")));
      }
    }
  };
  walk(root);
  return problems;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const problems = checkDirectory(resolve(dirname(fileURLToPath(import.meta.url)), "../src"));
  if (problems.length) {
    console.error(problems.join("\n"));
    process.exitCode = 1;
  } else console.log("Presentation boundary check passed.");
}
