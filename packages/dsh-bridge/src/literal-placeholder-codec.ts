export type LiteralPlaceholderStrategy = "identity" | "scoped-variable" | "upstream-escape";

export interface LiteralPlaceholderCodec {
  readonly strategy: LiteralPlaceholderStrategy;
  encode(input: string): {
    text: string;
    variables: Readonly<Record<string, string>>;
  };
}

export function createLiteralPlaceholderCodec(): LiteralPlaceholderCodec {
  return {
    strategy: "identity",
    encode(input) {
      if (typeof input !== "string") {
        throw new Error("prompt contribution must be a string");
      }

      return { text: input, variables: Object.freeze({}) };
    },
  };
}
