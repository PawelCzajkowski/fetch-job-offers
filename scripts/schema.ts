// Regenerates the committed config.schema.json from the Zod schema.
// Run with `pnpm schema`.
import { writeFile } from "node:fs/promises";
import { configJsonSchema } from "../src/config/schema.ts";

const target = new URL("../config.schema.json", import.meta.url);
await writeFile(target, configJsonSchema());
console.log(`Wrote ${target.pathname}`);
