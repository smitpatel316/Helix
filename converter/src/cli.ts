// prism2hlx — convert a Prism 10 `.prism` file to a Helix `.hlx` file.
//
//   prism2hlx <input.prism> [output.hlx] [--json]
//
// The input file is only ever read, never written. The output is written
// with Helix's own serializer, so it opens in Helix unchanged. `--json`
// prints the transfer report as JSON instead of text.
//
// Exit codes: 0 converted, 1 the file couldn't be converted (plain-language
// reason on stderr), 2 bad usage.

import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { basename, extname } from "node:path";
import { serializeProjectFile } from "../../src/lib/project-file";
import { convertPrism, formatReport } from "./prism";

function usage(): never {
  console.error("Usage: prism2hlx <input.prism> [output.hlx] [--json]");
  console.error("  Convert a Prism 10 .prism file to a Helix .hlx file.");
  process.exit(2);
}

const args = process.argv.slice(2).filter((a) => a !== "--json");
const asJson = process.argv.includes("--json");
const [input, outputArg] = args;
if (!input || args.length > 2) usage();

const output = outputArg ?? input.replace(/\.prism$/i, "") + ".hlx";
if (extname(output).toLowerCase() !== ".hlx") {
  console.error(`Output “${output}” must end in .hlx.`);
  process.exit(2);
}

let inputBuffer: Buffer;
try {
  inputBuffer = await readFile(input);
} catch {
  console.error(`Can't read “${input}” — check the file exists and is readable.`);
  process.exit(1);
}
const before = createHash("sha256").update(inputBuffer).digest("hex");
let result;
try {
  result = await convertPrism(inputBuffer, basename(input));
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}
let after: string;
try {
  after = createHash("sha256").update(await readFile(input)).digest("hex");
} catch {
  console.error(`“${basename(input)}” disappeared while converting — the output was not written. Try again.`);
  process.exit(1);
}
if (before !== after) {
  // The converter only reads its input; a changed checksum means something
  // else touched the file mid-run. Say so rather than silently continuing.
  console.error(`“${basename(input)}” changed while converting — the output was not written. Try again.`);
  process.exit(1);
}
await writeFile(output, serializeProjectFile(result.project));
if (asJson) console.log(JSON.stringify(result.report, null, 2));
else console.log(formatReport(result.report) + `\nWrote “${output}”.`);
