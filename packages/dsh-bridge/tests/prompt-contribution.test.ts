import { describe, expect, it } from "vitest";
import { createPromptContribution } from "../src/prompt-contribution.js";

function assembler(input: string) {
  return Promise.resolve(input);
}

describe("prompt contribution", () => {
  it("passes VCP placeholders through the DSH assembler byte-for-byte", async () => {
    const contribution = createPromptContribution({ assembler });
    const cases = [
      "{{Nova}}",
      "a{{Nova}}{{Other}}b",
      "{{Nova",
      "{{{Nova}}}",
      "重复{{Nova}}重复{{Nova}}",
    ];

    for (const input of cases) {
      const output = await contribution.contribute(input);
      expect(new TextEncoder().encode(output)).toEqual(new TextEncoder().encode(input));
    }
  });

  it("keeps DSH as the sole System Prompt assembler", async () => {
    const calls: string[] = [];
    const contribution = createPromptContribution({
      assembler: async (input) => {
        calls.push(input);
        return input;
      },
    });

    await contribution.contribute("Keep {{Nova}} literal.");

    expect(calls).toEqual(["Keep {{Nova}} literal."]);
  });

  it("does not reinterpret placeholders or inject new content", async () => {
    const contribution = createPromptContribution({ assembler });
    const output = await contribution.contribute("A {{Nova}} B");

    expect(output).toBe("A {{Nova}} B");
    expect(output).not.toContain("NovaInterpreted");
    expect(output).not.toContain("AIO:");
  });
});

