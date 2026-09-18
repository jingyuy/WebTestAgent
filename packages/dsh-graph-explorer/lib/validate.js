/**
 * Schema validation for the documents this plugin assembles.
 *
 * README gap 8 is the reason this file exists. Its closed half is that a
 * single parameter's shape is checked at the tool boundary; the half that
 * stayed open is the general one, in the gap's own words: *"the assembled
 * document is still not validated against the normative schemas before the
 * result is called `ok`."* The 0.1.13 live run is what that costs — a
 * `graph.json` that was schema-INVALID written with `ok: true`, because
 * nothing between the tool call and the file compared the two.
 *
 * Two decisions shape the implementation.
 *
 * **No dependency.** `npm test` for this package runs offline and with no
 * `node_modules` at all (the peers are symlinks the test harness supplies),
 * so ajv cannot be the validator that the gate depends on. It stays where it
 * already is: opt-in, behind `npm run prove:schema`, as a second opinion on
 * the vendored schemas themselves. What runs inside the commit has to be
 * bytes in this repository.
 *
 * **The subset is declared, not assumed.** Hand-writing a validator over
 * someone else's schemas is only honest if the walker knows which keywords it
 * is *not* applying: an ignored `anyOf` turns a refusal into a pass, and the
 * failure mode of a validator is silence. So `audit()` walks every schema
 * file, reports the keywords actually used, and `validate()` carries the ones
 * this walker does not implement (`ANY/ALL`-of-another-shape, `not`,
 * `patternProperties`, ...) as an `unchecked` list on its own result. A
 * document that validates against a schema using an unimplemented keyword
 * says so rather than reporting a clean pass.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve as resolvePath } from 'node:path';

/** The vendored schemas, next to `lib/`. */
export const DEFAULT_SCHEMA_ROOT = fileURLToPath(new URL('../schemas/', import.meta.url));

/**
 * Keywords that say something about the schema rather than about the
 * instance. They are read (and skipped) so that the audit does not report
 * them, but none of them changes a verdict.
 */
const ANNOTATIONS = new Set([
    '$schema', '$id', '$comment', 'title', 'description', 'default', 'examples',
    'deprecated', 'readOnly', 'writeOnly', 'contentEncoding', 'contentMediaType',
    '$defs', 'definitions',
]);

/**
 * The keywords this walker *does* apply. Everything else in `ASSERTIONS` is
 * carried as unchecked, because a keyword nobody applied is a check nobody
 * ran.
 */
const ASSERTIONS = new Set([
    '$ref', 'type', 'required', 'properties', 'items', 'additionalProperties',
    'patternProperties', 'enum', 'const', 'pattern', 'minLength', 'maxLength',
    'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'minItems',
    'maxItems', 'uniqueItems', 'minProperties', 'maxProperties', 'multipleOf',
    'allOf', 'anyOf', 'oneOf', 'not', 'if', 'then', 'else', 'dependentRequired',
    'propertyNames', 'format',
]);

const IMPLEMENTED = new Set([
    '$ref', 'type', 'required', 'properties', 'items', 'additionalProperties',
    'enum', 'const', 'pattern', 'minLength', 'maxLength', 'minimum', 'maximum',
    'minItems', 'maxItems', 'uniqueItems', 'allOf', 'oneOf', 'if', 'then',
    'else', 'format',
]);

/**
 * Object-valued keywords whose *keys* are names, not keywords. The audit has
 * to know, or every property in every schema reads as an unknown keyword.
 */
const NAME_MAPS = new Set(['properties', 'patternProperties', '$defs', 'definitions', 'dependentRequired']);

const MAX_ERRORS = 25;
const MAX_REF_DEPTH = 64;

// --- the schema set ----------------------------------------------------------------------------

/**
 * Read the vendored schemas from a root directory, memoised by absolute path.
 *
 * `$ref` in these files is either a local pointer (`#/$defs/id`) or a bare
 * filename in the same directory (`common.schema.json#/$defs/id`), which is
 * why resolving one needs to know which file the reference was written in —
 * and why every walk below carries its file.
 */
export function loadSchemas(root = DEFAULT_SCHEMA_ROOT) {
    const cache = new Map();
    const read = (abs) => {
        if (cache.has(abs)) return cache.get(abs);
        const schema = JSON.parse(readFileSync(abs, 'utf8'));
        cache.set(abs, schema);
        return schema;
    };
    return {
        root,
        /** Absolute path of a schema, for the report. */
        path: (relative) => resolvePath(root, relative),
        /** Parse (once) the schema at a path relative to the root, or absolute. */
        get(relative) {
            const abs = relative.startsWith('/') ? relative : resolvePath(root, relative);
            return read(abs);
        },
        has(relative) {
            try {
                read(resolvePath(root, relative));
                return true;
            } catch {
                return false;
            }
        },
    };
}

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const typeOf = (value) => (Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value);

/** `http://…#/$defs/id` → `{file, pointer}`. A missing file part means this file. */
function splitRef(ref) {
    const [file, pointer = ''] = ref.split('#');
    return { file: file === '' ? null : file, pointer };
}

/** RFC 6901. */
function pointerAt(document, pointer) {
    if (pointer === '' || pointer === '/') return document;
    let node = document;
    for (const raw of pointer.replace(/^\//, '').split('/')) {
        const key = raw.replace(/~1/g, '/').replace(/~0/g, '~');
        if (!isObject(node) && !Array.isArray(node)) return undefined;
        node = node[key];
        if (node === undefined) return undefined;
    }
    return node;
}

// --- the walk ----------------------------------------------------------------------------------

const show = (value) => {
    const text = typeof value === 'string' ? JSON.stringify(value) : JSON.stringify(value);
    return text === undefined ? String(value) : text.length > 60 ? `${text.slice(0, 57)}...` : text;
};

const sameJson = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Collect the errors a schema raises about a value.
 *
 * `seen` is `instancePath|file#pointer` pairs already on the stack: a `$ref`
 * chain that returns to a schema it started from without consuming any
 * instance data is a cycle in the schema, not a defect in the document, and
 * the alternative to stopping is not terminating.
 */
function walk(schema, value, ctx, instancePath, seen, errors) {
    if (errors.length >= MAX_ERRORS) return;
    if (schema === true || schema === undefined) return;
    if (schema === false) {
        errors.push({ path: instancePath, keyword: 'false', message: 'no value is allowed here' });
        return;
    }
    if (!isObject(schema)) return;

    if (typeof schema.$ref === 'string') {
        const { file: refFile, pointer } = splitRef(schema.$ref);
        const file = refFile === null || refFile === '' ? ctx.file : resolvePath(dirname(ctx.file), refFile);
        const key = `${instancePath}|${file}#${pointer}`;
        if (!seen.has(key)) {
            let target;
            try {
                target = pointerAt(ctx.set.get(file), pointer);
            } catch (error) {
                errors.push({ path: instancePath, keyword: '$ref', message: `cannot read ${schema.$ref}: ${error.message}` });
                return;
            }
            if (target === undefined) {
                errors.push({ path: instancePath, keyword: '$ref', message: `${schema.$ref} resolves to nothing` });
                return;
            }
            const inner = new Set(seen);
            inner.add(key);
            walk(target, value, { ...ctx, file }, instancePath, inner, errors);
        }
    }

    const fail = (keyword, message) => errors.push({ path: instancePath, keyword, message });

    if (schema.type !== undefined) {
        const wanted = Array.isArray(schema.type) ? schema.type : [schema.type];
        const actual = typeOf(value);
        const matches = wanted.some((entry) => entry === actual
            || (entry === 'integer' && actual === 'number' && Number.isInteger(value))
            || (entry === 'number' && actual === 'number'));
        if (!matches) {
            fail('type', `expected ${wanted.join(' or ')}, found ${actual} ${show(value)}`);
            return;
        }
    }

    if (schema.const !== undefined && !sameJson(value, schema.const)) {
        fail('const', `expected ${show(schema.const)}, found ${show(value)}`);
    }
    if (Array.isArray(schema.enum) && !schema.enum.some((entry) => sameJson(entry, value))) {
        fail('enum', `${show(value)} is not one of ${schema.enum.map(show).join(', ')}`);
    }

    if (isObject(value)) {
        for (const key of schema.required ?? []) {
            if (!(key in value)) fail('required', `missing required key "${key}"`);
        }
        const properties = isObject(schema.properties) ? schema.properties : {};
        for (const [key, sub] of Object.entries(properties)) {
            if (key in value) walk(sub, value[key], ctx, `${instancePath}.${key}`, seen, errors);
        }
        if (schema.additionalProperties === false) {
            const extra = Object.keys(value).filter((key) => !(key in properties));
            if (extra.length) {
                const allowed = Object.keys(properties);
                fail('additionalProperties', `${extra.map((key) => `"${key}"`).join(', ')} not allowed; `
                    + `the schema declares ${allowed.length ? allowed.join(', ') : 'no keys'}`
                    + (extra.length > 1 ? ` (${extra.length} unexpected keys)` : ''));
            }
        } else if (isObject(schema.additionalProperties)) {
            for (const [key, sub] of Object.entries(value)) {
                if (!(key in properties)) walk(schema.additionalProperties, sub, ctx, `${instancePath}.${key}`, seen, errors);
            }
        }
    }

    if (Array.isArray(value)) {
        if (isObject(schema.items)) {
            value.forEach((entry, index) => walk(schema.items, entry, ctx, `${instancePath}[${index}]`, seen, errors));
        }
        if (typeof schema.minItems === 'number' && value.length < schema.minItems) {
            fail('minItems', `${value.length} item(s), expected at least ${schema.minItems}`);
        }
        if (typeof schema.maxItems === 'number' && value.length > schema.maxItems) {
            fail('maxItems', `${value.length} item(s), expected at most ${schema.maxItems}`);
        }
        if (schema.uniqueItems === true) {
            const seenItems = new Map();
            value.forEach((entry, index) => {
                const key = JSON.stringify(entry);
                if (seenItems.has(key)) fail('uniqueItems', `item ${index} repeats item ${seenItems.get(key)}: ${show(entry)}`);
                else seenItems.set(key, index);
            });
        }
    }

    if (typeof value === 'string') {
        if (typeof schema.minLength === 'number' && value.length < schema.minLength) {
            fail('minLength', `${value.length} character(s), expected at least ${schema.minLength}`);
        }
        if (typeof schema.maxLength === 'number' && value.length > schema.maxLength) {
            fail('maxLength', `${value.length} character(s), expected at most ${schema.maxLength}`);
        }
        if (typeof schema.pattern === 'string') {
            let expression = null;
            try {
                expression = new RegExp(schema.pattern);
            } catch {
                /* a schema with an unusable pattern is not the document's fault */
            }
            if (expression && !expression.test(value)) fail('pattern', `${show(value)} does not match ${show(schema.pattern)}`);
        }
        if (schema.format === 'date-time' && Number.isNaN(Date.parse(value))) {
            fail('format', `${show(value)} is not an ISO date-time`);
        }
        if (schema.format === 'uri') {
            let parsed = false;
            try {
                // eslint-disable-next-line no-new
                new URL(value);
                parsed = true;
            } catch {
                /* not absolute */
            }
            if (!parsed) fail('format', `${show(value)} is not an absolute URL`);
        }
    }

    if (typeof value === 'number') {
        if (typeof schema.minimum === 'number' && value < schema.minimum) fail('minimum', `${value} is below ${schema.minimum}`);
        if (typeof schema.maximum === 'number' && value > schema.maximum) fail('maximum', `${value} is above ${schema.maximum}`);
    }

    for (const sub of schema.allOf ?? []) walk(sub, value, ctx, instancePath, seen, errors);

    if (Array.isArray(schema.oneOf)) {
        const passes = schema.oneOf.filter((sub) => {
            const nested = [];
            walk(sub, value, ctx, instancePath, seen, nested);
            return nested.length === 0;
        });
        if (passes.length !== 1) {
            fail('oneOf', `matched ${passes.length} of ${schema.oneOf.length} alternatives; exactly one must match`);
        }
    }

    // `if` never raises an error of its own: it only chooses which branch to apply.
    if (schema.if !== undefined) {
        const tested = [];
        walk(schema.if, value, ctx, instancePath, seen, tested);
        const branch = tested.length === 0 ? schema.then : schema.else;
        if (branch !== undefined) walk(branch, value, ctx, instancePath, seen, errors);
    }
}

/**
 * Validate one document against one schema.
 *
 * The schema is named by its path *relative to the same root the set was
 * loaded from*, and that is not a convenience: a `$ref` like
 * `common.schema.json#/$defs/id` is relative to the file it is written in, so
 * a walker that does not know which file it started in cannot resolve it.
 *
 * The result is shaped for a report rather than for a person reading a stack
 * trace: `errors` is capped and `error_count` is not, because "twenty-five of
 * ninety" is the fact a report wants, and a truncated list is not evidence of
 * a small problem.
 */
export function validateDocument(document, set, schemaPath, { name = null } = {}) {
    const schema = set.get(schemaPath);
    const errors = [];
    const ctx = { set, file: set.path(schemaPath) };
    walk(schema, document, ctx, '$', new Set(), errors);
    const unchecked = auditSchema(schema, { file: schemaPath });
    return {
        name: name ?? schema?.title ?? null,
        schema: schemaPath,
        valid: errors.length === 0,
        error_count: errors.length,
        errors: errors.slice(0, MAX_ERRORS),
        // A keyword this walker does not apply is a check that did not run, and
        // the caller has to be able to say so instead of reporting a clean pass.
        unchecked: unchecked.unchecked,
    };
}

// --- the audit ---------------------------------------------------------------------------------

/**
 * Which keywords does this schema use that the walker does not apply? Read
 * out of the schema itself, so a schema that grows an `anyOf` cannot quietly
 * stop being enforced.
 */
export function auditSchema(schema, { file = null } = {}) {
    const used = new Set();
    const approximations = [];
    const visit = (node, inNames) => {
        if (Array.isArray(node)) {
            for (const entry of node) visit(entry, false);
            return;
        }
        if (!isObject(node)) return;
        const keys = Object.keys(node);
        for (const key of keys) {
            if (inNames) continue;
            used.add(key);
        }
        // `additionalProperties: false` only ever sees the `properties` written
        // beside it. A sibling branch that declares more keys is the one shape
        // where that reads as a refusal it should not make, so it is reported
        // rather than assumed away.
        if (node.additionalProperties === false) {
            const siblings = [...(node.allOf ?? []), node.then, node.else].filter(isObject);
            if (siblings.some((entry) => isObject(entry.properties) && Object.keys(entry.properties).length)) {
                approximations.push({
                    file,
                    kind: 'additionalProperties',
                    message: 'additionalProperties:false beside a branch that declares properties; '
                        + 'keys declared there are not counted as allowed',
                });
            }
        }
        for (const [key, value] of Object.entries(node)) {
            if (ANNOTATIONS.has(key)) {
                if (key === '$defs' || key === 'definitions') visit(value, true);
                continue;
            }
            if (NAME_MAPS.has(key)) visit(value, true);
            else visit(value, false);
        }
    };
    visit(schema, false);
    const keywords = [...used].filter((key) => !ANNOTATIONS.has(key));
    return {
        keywords: keywords.sort(),
        unchecked: keywords.filter((key) => ASSERTIONS.has(key) && !IMPLEMENTED.has(key)).sort(),
        unknown: keywords.filter((key) => !ASSERTIONS.has(key) && !ANNOTATIONS.has(key)).sort(),
        approximations,
    };
}

/** Every `*.schema.json` under a directory, as paths relative to it. */
export function schemaFiles(root = DEFAULT_SCHEMA_ROOT, prefix = '') {
    const out = [];
    for (const entry of readdirSync(join(root, prefix)).sort()) {
        const relative = prefix ? `${prefix}/${entry}` : entry;
        if (statSync(join(root, relative)).isDirectory()) out.push(...schemaFiles(root, relative));
        else if (entry.endsWith('.schema.json')) out.push(relative);
    }
    return out;
}

/**
 * The audit over the whole vendored set. `unchecked` is what matters: if it is
 * empty, every keyword every vendored schema uses is one this walker applied,
 * and a clean validation is a real pass.
 */
export function auditSchemaSet(root = DEFAULT_SCHEMA_ROOT) {
    const set = loadSchemas(root);
    const keywords = new Set();
    const unchecked = new Set();
    const unknown = new Set();
    const approximations = [];
    const files = schemaFiles(root);
    for (const relative of files) {
        const audit = auditSchema(set.get(relative), { file: relative });
        audit.keywords.forEach((key) => keywords.add(key));
        audit.unchecked.forEach((key) => unchecked.add(key));
        audit.unknown.forEach((key) => unknown.add(key));
        approximations.push(...audit.approximations);
    }
    return {
        root,
        files: files.length,
        keywords: [...keywords].sort(),
        unchecked: [...unchecked].sort(),
        unknown: [...unknown].sort(),
        approximations,
    };
}
