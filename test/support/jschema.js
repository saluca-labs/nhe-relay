// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Saluca Labs

// A small JSON Schema checker for the subset the Tiresias decision contract uses: type
// (string or list), enum, const, required, properties, additionalProperties false, pattern,
// minLength, items and local $ref into #/$defs. An unknown keyword throws, so a contract that
// grows a keyword this checker does not know turns the test red instead of passing unchecked.

const KNOWN = new Set(["$schema", "$id", "$ref", "$defs", "title", "description", "type", "enum", "const",
  "required", "properties", "additionalProperties", "pattern", "minLength", "items"]);

function typeOf(v) {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v;
}

/** Returns a list of error strings, empty when the value conforms. */
export function validate(root, schema, value, path = "$") {
  const errs = [];
  for (const k of Object.keys(schema))
    if (!KNOWN.has(k)) throw new Error(`unsupported schema keyword ${k} at ${path}`);
  if (schema.$ref !== undefined) {
    const m = /^#\/\$defs\/([A-Za-z_]+)$/.exec(schema.$ref);
    if (!m || !root.$defs?.[m[1]]) throw new Error(`unresolvable $ref ${schema.$ref}`);
    errs.push(...validate(root, root.$defs[m[1]], value, path));
  }
  if (schema.const !== undefined && value !== schema.const) errs.push(`${path}: not const ${schema.const}`);
  if (schema.enum && !schema.enum.includes(value)) errs.push(`${path}: not in enum`);
  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.includes(typeOf(value))) { errs.push(`${path}: type ${typeOf(value)} not in ${types}`); return errs; }
  }
  if (typeof value === "string") {
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) errs.push(`${path}: pattern`);
    if (schema.minLength !== undefined && value.length < schema.minLength) errs.push(`${path}: too short`);
  }
  if (typeOf(value) === "object") {
    for (const r of schema.required ?? []) if (!(r in value)) errs.push(`${path}: missing ${r}`);
    const props = schema.properties ?? {};
    for (const [k, v] of Object.entries(value)) {
      if (k in props) errs.push(...validate(root, props[k], v, `${path}.${k}`));
      else if (schema.additionalProperties === false) errs.push(`${path}: unexpected ${k}`);
    }
  }
  if (typeOf(value) === "array" && schema.items)
    value.forEach((v, i) => errs.push(...validate(root, schema.items, v, `${path}[${i}]`)));
  return errs;
}
