import { Type, type TLiteral, type TSchema, type TUnion } from '@sinclair/typebox';

export const StrictString = Type.String();
export const NonEmptyString = Type.String({ minLength: 1 });
export const NullableString = Type.Union([Type.String(), Type.Null()]);
export const NullableNonEmptyString = Type.Union([Type.String({ minLength: 1 }), Type.Null()]);
export const StringArray = Type.Array(Type.String());
export const NonEmptyStringArray = Type.Array(Type.String({ minLength: 1 }));
export const NullableNumber = Type.Union([Type.Number(), Type.Null()]);

export function strictObject<const T extends Record<string, TSchema>>(properties: T) {
  return Type.Object(properties, { additionalProperties: false });
}

type LiteralSchemas<T extends readonly string[]> = {
  -readonly [K in keyof T]: T[K] extends string ? TLiteral<T[K]> : never;
};

export function literalUnion<const T extends readonly [string, ...string[]]>(
  values: T
): TUnion<LiteralSchemas<T>> {
  return Type.Union(
    values.map((value) => Type.Literal(value)) as [TLiteral<string>, ...TLiteral<string>[]]
  ) as TUnion<LiteralSchemas<T>>;
}
