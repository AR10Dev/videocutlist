import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import * as ts from "typescript";

const clientRoot = resolve(import.meta.dirname, "..");
const schema = resolve(clientRoot, "../docs/contracts/api.openapi.yaml");
const generatedPath = resolve(clientRoot, "src/generated/api.ts");

const parsed = ts.createSourceFile(
  generatedPath,
  readFileSync(generatedPath, "utf8"),
  ts.ScriptTarget.Latest,
  true,
);

function schemaProperties(schema: string): string[] {
  const components = parsed.statements.find(
    (statement): statement is ts.InterfaceDeclaration =>
      ts.isInterfaceDeclaration(statement) && statement.name.text === "components",
  );
  const schemas = components?.members.find(
    (member): member is ts.PropertySignature =>
      ts.isPropertySignature(member) && member.name.getText(parsed) === "schemas",
  );
  if (!schemas || !schemas.type || !ts.isTypeLiteralNode(schemas.type)) {
    throw new Error("Generated API lacks components.schemas");
  }
  const entry = schemas.type.members.find(
    (member): member is ts.PropertySignature =>
      ts.isPropertySignature(member) && member.name.getText(parsed) === schema,
  );
  if (!entry || !entry.type || !ts.isTypeLiteralNode(entry.type)) {
    throw new Error(`Generated API lacks ${schema}`);
  }
  return entry.type.members
    .filter((member): member is ts.PropertySignature => ts.isPropertySignature(member))
    .map((member) => member.name.getText(parsed));
}

describe("generated API contract", () => {
  it("matches the committed output of the pinned OpenAPI generator", () => {
    const generated = execFileSync(
      resolve(clientRoot, "node_modules/.bin/openapi-typescript"),
      [schema, "--default-non-nullable", "false"],
      { cwd: clientRoot, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 },
    );
    const formatted = execFileSync(
      resolve(clientRoot, "node_modules/.bin/oxfmt"),
      [`--stdin-filepath=${generatedPath}`],
      { cwd: clientRoot, input: generated, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 },
    );
    expect(readFileSync(generatedPath, "utf8")).toBe(formatted);
  });

  it("never exposes deployment root paths in browser settings", () => {
    for (const schema of ["RuntimeDestination", "RuntimeSettings"]) {
      const properties = schemaProperties(schema);
      for (const field of ["root", "mediaRoot", "mediaRoots"]) {
        expect(properties).not.toContain(field);
      }
    }
  });
});
