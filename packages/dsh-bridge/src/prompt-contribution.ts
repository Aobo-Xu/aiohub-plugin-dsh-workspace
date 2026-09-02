import { createLiteralPlaceholderCodec } from "./literal-placeholder-codec.js";

type Assembler = (input: string) => Promise<string>;

export function createPromptContribution(options: { assembler: Assembler }) {
  if (typeof options.assembler !== "function") {
    throw new Error("assembler must be a function");
  }

  const codec = createLiteralPlaceholderCodec();

  return {
    async contribute(input: string): Promise<string> {
      if (typeof input !== "string") {
        throw new Error("prompt contribution must be a string");
      }

      const encoded = codec.encode(input);
      return options.assembler(encoded.text);
    },
  };
}
