import { z } from 'zod';

export interface JsonSchema {
  type: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  description?: string;
  enum?: unknown[];
  items?: JsonSchema;
  minimum?: number;
  maximum?: number;
  default?: unknown;
}

export function zodToJsonSchema(schema: z.ZodTypeAny): JsonSchema {
  return convert(schema);
}

function convert(schema: z.ZodTypeAny): JsonSchema {
  const def = (schema as unknown as { _def: { typeName: string } })._def;
  const typeName = def.typeName;

  switch (typeName) {
    case 'ZodString':
      return withDescription(schema, { type: 'string' });
    case 'ZodNumber': {
      const out: JsonSchema = { type: 'number' };
      const checks = (def as unknown as { checks?: { kind: string; value?: number }[] }).checks ?? [];
      for (const c of checks) {
        if (c.kind === 'min' && c.value !== undefined) out.minimum = c.value;
        if (c.kind === 'max' && c.value !== undefined) out.maximum = c.value;
        if (c.kind === 'int') out.type = 'integer';
      }
      return withDescription(schema, out);
    }
    case 'ZodBoolean':
      return withDescription(schema, { type: 'boolean' });
    case 'ZodEnum': {
      const values = (def as unknown as { values: string[] }).values;
      return withDescription(schema, { type: 'string', enum: values });
    }
    case 'ZodOptional': {
      const inner = (def as unknown as { innerType: z.ZodTypeAny }).innerType;
      return convert(inner);
    }
    case 'ZodDefault': {
      const inner = (def as unknown as { innerType: z.ZodTypeAny; defaultValue: () => unknown })
        .innerType;
      const defaultValue = (def as unknown as { defaultValue: () => unknown }).defaultValue();
      const out = convert(inner);
      out.default = defaultValue;
      return out;
    }
    case 'ZodObject': {
      const shape = (
        def as unknown as { shape: () => Record<string, z.ZodTypeAny> }
      ).shape();
      const properties: Record<string, JsonSchema> = {};
      const required: string[] = [];
      for (const [key, value] of Object.entries(shape)) {
        properties[key] = convert(value);
        const vDef = (value as unknown as { _def: { typeName: string } })._def;
        if (vDef.typeName !== 'ZodOptional' && vDef.typeName !== 'ZodDefault') {
          required.push(key);
        }
      }
      const out: JsonSchema = { type: 'object', properties };
      if (required.length > 0) out.required = required;
      return withDescription(schema, out);
    }
    default:
      return { type: 'string' };
  }
}

function withDescription(schema: z.ZodTypeAny, base: JsonSchema): JsonSchema {
  const desc = (schema as unknown as { _def: { description?: string } })._def.description;
  if (desc) base.description = desc;
  return base;
}
