import { brotliCompressSync, gzipSync } from "node:zlib";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

async function compress(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = join(directory, entry.name);
    if (entry.isDirectory()) await compress(file);
    else if (/\.(?:css|html|js|json|svg)$/.test(entry.name)) {
      const source = await readFile(file);
      await Promise.all([
        writeFile(`${file}.br`, brotliCompressSync(source)),
        writeFile(`${file}.gz`, gzipSync(source)),
      ]);
    }
  }
}

await compress(fileURLToPath(new URL("../dist", import.meta.url)));
