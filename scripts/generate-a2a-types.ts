/**
 * Generate TypeScript types from the canonical A2A JSON Schema in
 * inference-gateway/schemas. Run via `pnpm generate:types`.
 *
 * Pass `--check` to verify the working tree matches what the script would
 * produce without writing. CI uses this mode to fail on schema drift.
 */
import { compile, type JSONSchema } from 'json-schema-to-typescript';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Pin the schema by commit SHA so regeneration is reproducible.
// Bump this when the upstream schema you want to consume changes.
export const SCHEMA_REPO = 'inference-gateway/schemas';
export const SCHEMA_PATH = 'a2a/a2a-schema.json';
export const SCHEMA_REF = '2b5aea62d53c6dc13990f14a2da6483db1a97902';

export const SCHEMA_URL = `https://raw.githubusercontent.com/${SCHEMA_REPO}/${SCHEMA_REF}/${SCHEMA_PATH}`;

const ROOT = resolve(fileURLToPath(import.meta.url), '..', '..');
export const OUTPUT_FILE = resolve(ROOT, 'src/types/generated/a2a.ts');

const HEADER = `// Code generated from A2A schema. DO NOT EDIT.
//
// Source: https://github.com/${SCHEMA_REPO}/blob/${SCHEMA_REF}/${SCHEMA_PATH}
// Regenerate with: pnpm generate:types
`;

type JsonValue =
  string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

interface RawSchema {
  $schema?: string;
  definitions: Record<string, JsonValue>;
  [key: string]: JsonValue | undefined;
}

async function fetchSchema(): Promise<RawSchema> {
  const response = await fetch(SCHEMA_URL);
  if (!response.ok) {
    throw new Error(
      `Failed to fetch ${SCHEMA_URL}: ${response.status} ${response.statusText}`
    );
  }
  const json = (await response.json()) as RawSchema;
  if (!json.definitions || typeof json.definitions !== 'object') {
    throw new Error('Schema is missing a top-level "definitions" object.');
  }
  return json;
}

function pascalCase(input: string): string {
  return input
    .replace(/(?:^|[\s_-])(\w)/g, (_, c: string) => c.toUpperCase())
    .replace(/\W+/g, '');
}

function isRecord(value: JsonValue): value is { [key: string]: JsonValue } {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Normalize the schema so json-schema-to-typescript emits stable per-definition
 * types without numbered duplicates:
 *
 * 1. Hoist inline named enums (`{ title, type, enum }`) into top-level
 *    definitions and rewrite occurrences as $refs. Otherwise the library
 *    inlines them and produces TaskState, TaskState1, ... per usage site.
 *
 * 2. Strip sibling keys from `$ref` usages, leaving a pure $ref. When a $ref
 *    site carries a sibling description, the library treats it as a distinct
 *    subtype and emits Struct1, Struct2, ... per occurrence even though
 *    they're structurally identical.
 */
function normalizeSchema(schema: RawSchema): RawSchema {
  const hoisted: Record<string, JsonValue> = {};

  function visit(node: JsonValue): JsonValue {
    if (Array.isArray(node)) {
      return node.map(visit);
    }
    if (!isRecord(node)) {
      return node;
    }
    if (Array.isArray(node['enum']) && typeof node['title'] === 'string') {
      const name = pascalCase(node['title']);
      if (!hoisted[name]) {
        hoisted[name] = {
          title: node['title'],
          type: typeof node['type'] === 'string' ? node['type'] : 'string',
          enum: node['enum'],
        };
      }
      return { $ref: `#/definitions/${name}` };
    }
    if (typeof node['$ref'] === 'string') {
      return { $ref: node['$ref'] };
    }
    return Object.fromEntries(
      Object.entries(node).map(([k, v]) => [k, visit(v)])
    );
  }

  const rewrittenDefs = visit(schema.definitions) as Record<string, JsonValue>;
  return {
    ...schema,
    definitions: { ...rewrittenDefs, ...hoisted },
  };
}

export async function generate(): Promise<string> {
  const raw = await fetchSchema();
  const schema = normalizeSchema(raw);

  const names = Object.keys(schema.definitions).sort((a, b) =>
    a.localeCompare(b)
  );

  const blocks: string[] = [];
  for (const name of names) {
    const subSchema = {
      $schema: schema.$schema,
      ...(schema.definitions[name] as object),
      definitions: schema.definitions,
    } as JSONSchema;

    const block = await compile(subSchema, name, {
      bannerComment: '',
      additionalProperties: false,
      declareExternallyReferenced: false,
      enableConstEnums: false,
      strictIndexSignatures: true,
      style: { singleQuote: true, semi: true, trailingComma: 'all' },
    });

    blocks.push(block.trim());
  }

  const body = blocks.join('\n\n');
  return `${HEADER}\n${body}\n`;
}

export async function check(): Promise<{
  ok: boolean;
  expected: string;
  actual: string;
}> {
  const expected = await generate();
  let actual = '';
  try {
    actual = await readFile(OUTPUT_FILE, 'utf8');
  } catch {
    return { ok: false, expected, actual };
  }
  return { ok: expected === actual, expected, actual };
}

async function main(): Promise<void> {
  if (process.argv.includes('--check')) {
    const { ok } = await check();
    if (!ok) {
      console.error(
        `Generated A2A types are out of date.\nRun \`pnpm generate:types\` and commit the result.`
      );
      process.exit(1);
    }
    console.log('A2A types are up to date.');
    return;
  }

  const generated = await generate();
  await mkdir(dirname(OUTPUT_FILE), { recursive: true });
  await writeFile(OUTPUT_FILE, generated);
  console.log(`Wrote ${OUTPUT_FILE}`);
}

const invokedDirectly =
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith('generate-a2a-types.ts');

if (invokedDirectly) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
}
