import githubDarkDefault from "@pierre/highlights/themes/github-dark-default";
import type { BundledLanguage } from "shiki";
import { describe, expect, it } from "vitest";
import { createHighlightsCodePlugin } from "../highlights";
import type { ThemeInput } from "../index";

const THEMES: [ThemeInput, ThemeInput] = ["github-light", "github-dark"];
const HEX_COLOR = /^#/;

const highlight = (code: string, language: string, themes = THEMES) => {
  const result = createHighlightsCodePlugin().highlight({
    code,
    language: language as BundledLanguage,
    themes,
  });
  if (!result) {
    throw new Error("Expected a synchronous result");
  }
  return result;
};

const text = (tokens: { content: string }[][]) =>
  tokens.map((row) => row.map((token) => token.content).join("")).join("\n");

describe("createHighlightsCodePlugin", () => {
  it("returns tokens synchronously with dark colors in --shiki-dark", () => {
    const result = highlight("const a = 1;\nlet b;", "ts");
    expect(result.tokens).toHaveLength(2);
    expect(result.tokens[0]?.[0]?.htmlStyle).toMatchObject({
      color: expect.stringMatching(HEX_COLOR),
      "--shiki-dark": expect.stringMatching(HEX_COLOR),
    });
    expect(result.bg).toContain("--shiki-dark-bg:");
  });

  it("keeps every character of the code", () => {
    const code = 'fn main() {\n    println!("{}", 1); // é 🎉\n}\n';
    expect(text(highlight(code, "rust").tokens)).toBe(code);
  });

  it("renders unknown and truncated languages as plain text", () => {
    const plugin = createHighlightsCodePlugin();
    expect(plugin.supportsLanguage("not-a-language" as BundledLanguage)).toBe(
      false
    );
    const result = highlight("if (x) { y }", "typesc");
    expect(text(result.tokens)).toBe("if (x) { y }");
    expect(
      new Set(result.tokens[0]?.map((token) => token.htmlStyle?.color)).size
    ).toBe(1);
  });

  it("accepts language names in any case and with surrounding spaces", () => {
    const plugin = createHighlightsCodePlugin();
    expect(plugin.supportsLanguage(" TypeScript " as BundledLanguage)).toBe(
      true
    );
  });

  it("accepts Highlights theme objects", () => {
    const result = highlight("const a = 1;", "js", [
      "github-light",
      githubDarkDefault as unknown as ThemeInput,
    ]);
    expect(result.bg).toContain(
      `--shiki-dark-bg:${githubDarkDefault.style.background}`
    );
  });

  it("returns the cached result for a finished block", () => {
    const plugin = createHighlightsCodePlugin();
    const options = {
      code: "x = 1",
      language: "python" as BundledLanguage,
      themes: THEMES,
    };
    expect(plugin.highlight(options)).toBe(plugin.highlight(options));
  });

  it("does not cache a streaming block", () => {
    const plugin = createHighlightsCodePlugin();
    const options = {
      code: "y = 2",
      isIncomplete: true,
      language: "python" as BundledLanguage,
      themes: THEMES,
    };
    expect(plugin.highlight(options)).not.toBe(plugin.highlight(options));
  });
});
