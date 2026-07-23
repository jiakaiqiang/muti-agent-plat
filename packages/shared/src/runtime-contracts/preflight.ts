const ALLOWED_SCHEMA_KEYWORDS = new Set([
  '$id',
  'type',
  'const',
  'enum',
  'anyOf',
  'oneOf',
  'properties',
  'required',
  'additionalProperties',
  'items',
  'minItems',
  'maxItems',
  'uniqueItems',
  'minLength',
  'maxLength',
  'minimum',
  'maximum',
  'pattern',
  'description',
  'title'
]);

export function assertStrictJsonSchema(schema: unknown, root = '$'): void {
  visitSchema(schema, root);
}

function visitSchema(schema: unknown, path: string): void {
  if (!isRecord(schema)) throw new Error(`STRICT_SCHEMA_INVALID: ${path} must be a schema object.`);

  for (const keyword of Object.keys(schema)) {
    if (!ALLOWED_SCHEMA_KEYWORDS.has(keyword)) {
      throw new Error(`STRICT_SCHEMA_UNSUPPORTED_KEYWORD: ${path}.${keyword}`);
    }
  }

  if ('const' in schema && typeof schema.type !== 'string') {
    throw new Error(`STRICT_SCHEMA_CONST_TYPE_REQUIRED: ${path}`);
  }
  if ('enum' in schema && typeof schema.type !== 'string') {
    throw new Error(`STRICT_SCHEMA_ENUM_TYPE_REQUIRED: ${path}`);
  }

  if (schema.type === 'object') {
    if (schema.additionalProperties !== false) {
      throw new Error(`STRICT_SCHEMA_OBJECT_MUST_BE_CLOSED: ${path}`);
    }
    if (!isRecord(schema.properties)) {
      throw new Error(`STRICT_SCHEMA_PROPERTIES_REQUIRED: ${path}`);
    }
    if (!Array.isArray(schema.required)) {
      throw new Error(`STRICT_SCHEMA_REQUIRED_ARRAY_MISSING: ${path}`);
    }
    const properties = schema.properties as Record<string, unknown>;
    const propertyNames = Object.keys(properties);
    const required = new Set(schema.required);
    const missing = propertyNames.filter((name) => !required.has(name));
    const unknown = [...required].filter((name) => typeof name !== 'string' || !(name in properties));
    if (missing.length || unknown.length) {
      throw new Error(
        `STRICT_SCHEMA_ALL_PROPERTIES_REQUIRED: ${path} missing=[${missing.join(',')}] unknown=[${unknown.join(',')}]`
      );
    }
    for (const [name, propertySchema] of Object.entries(properties)) {
      visitSchema(propertySchema, `${path}.properties.${name}`);
    }
  }

  if (schema.type === 'array') {
    if (!('items' in schema)) throw new Error(`STRICT_SCHEMA_ARRAY_ITEMS_REQUIRED: ${path}`);
    visitSchema(schema.items, `${path}.items`);
  }

  for (const unionKey of ['anyOf', 'oneOf'] as const) {
    if (!(unionKey in schema)) continue;
    const alternatives = schema[unionKey];
    if (!Array.isArray(alternatives) || alternatives.length === 0) {
      throw new Error(`STRICT_SCHEMA_UNION_EMPTY: ${path}.${unionKey}`);
    }
    alternatives.forEach((alternative, index) => visitSchema(alternative, `${path}.${unionKey}.${index}`));
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
