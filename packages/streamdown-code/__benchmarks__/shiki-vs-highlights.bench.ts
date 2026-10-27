import { type BundledLanguage, createHighlighter } from "shiki";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";
import { test } from "vitest";
import { createHighlightsCodePlugin } from "../highlights";
import {
  type CodeHighlighterPlugin,
  createCodePlugin,
  type HighlightResult,
} from "../index";

const THEMES: ["github-light", "github-dark"] = ["github-light", "github-dark"];

const TS_UNIT = `/** Handler N: validates and transforms a batch of items. */
export async function handlerN(items: readonly Item[], opts: Options = {}): Promise<Result<N>> {
  const limit = opts.limit ?? N;
  const out: Result<N>[] = [];
  for (const item of items.slice(0, limit)) {
    if (!item.id || item.tags.includes("skip-N")) { continue; }
    const value = \`\${item.name}-N\`.replace(/[^a-z0-9-]/gi, "_");
    out.push({ id: item.id, value, score: Math.round(item.weight * N.5) });
  }
  return { ok: true, data: out } as Result<N>;
}`;

const PY_UNIT = `@dataclass
class ModelN:
    """Model N keeps a running score."""
    name: str = "model-N"
    weights: list[float] = field(default_factory=list)

    def score(self, xs: list[float]) -> float:
        total = sum(w * x for w, x in zip(self.weights, xs))  # dot product
        return round(total / max(len(xs), 1), N)`;

const repeat = (unit: string, units: number) =>
  Array.from({ length: units }, (_, i) => unit.replaceAll("N", String(i))).join(
    "\n\n"
  );

const minified = (units: number) =>
  Array.from(
    { length: units },
    (_, i) =>
      `function a${i}(b,c){return b.map(d=>d*c+${i}).filter(Boolean)}var x${i}={k:"v${i}",n:${i},r:/[a-z]+${i}/g};`
  ).join("");

interface Sample {
  code: string;
  language: string;
  name: string;
}

const lines = (code: string) => code.split("\n").length;
const sample = (name: string, language: string, code: string): Sample => ({
  code,
  language,
  name: `${name} (${lines(code)} lines, ${(code.length / 1024).toFixed(0)} KiB)`,
});

const SMALL_TS = sample("small ts", "typescript", repeat(TS_UNIT, 2));
const LARGE_TS = sample("large ts", "typescript", repeat(TS_UNIT, 12));
const HUGE_TS = sample("huge ts", "typescript", repeat(TS_UNIT, 120));
const LARGE_PY = sample("large python", "python", repeat(PY_UNIT, 16));
const HUGE_JSON = sample(
  "huge json",
  "json",
  JSON.stringify(
    Array.from({ length: 300 }, (_, i) => ({
      id: i,
      name: `item-${i}`,
      tags: ["a", "b", `t${i}`],
      nested: { ok: i % 2 === 0, score: i * 1.5, note: null },
    })),
    null,
    2
  )
);
const MINIFIED_JS = sample(
  "minified js, one line",
  "javascript",
  minified(200)
);
// Shiki re-tokenizes a growing single line in full on every update, which
// takes minutes per run for the larger sample.
const SMALL_MINIFIED_JS = sample(
  "minified js, one line",
  "javascript",
  minified(50)
);

const plugins: Record<string, CodeHighlighterPlugin> = {
  "shiki (incremental, current)": createCodePlugin({ themes: THEMES }),
  highlights: createHighlightsCodePlugin({ themes: THEMES }),
};

const shikiHighlighter = createHighlighter({
  engine: createJavaScriptRegexEngine({ forgiving: true }),
  langs: ["typescript", "python", "json", "javascript"],
  themes: THEMES,
});

// Re-tokenizes the whole block on every update, as @streamdown/code did
// before it reused the tokens of completed lines.
const shikiFull = async (code: string, language: string) =>
  (await shikiHighlighter).codeToTokens(code, {
    lang: language as BundledLanguage,
    themes: { light: THEMES[0], dark: THEMES[1] },
  });

const highlightWith = (
  plugin: CodeHighlighterPlugin,
  code: string,
  language: string,
  isIncomplete = false
) =>
  new Promise<HighlightResult>((resolve) => {
    const result = plugin.highlight(
      {
        code,
        isIncomplete,
        language: language as BundledLanguage,
        themes: THEMES,
      },
      resolve
    );
    if (result) {
      resolve(result);
    }
  });

// Every run uses distinct code so no step hits a token cache.
let run = 0;
const fresh = ({ code, language }: Sample) => {
  run += 1;
  const marker = language === "python" ? "#" : "//";
  return language === "json"
    ? code.replace('"id": 0', `"id": ${run}`)
    : `${marker} run ${run}\n${code}`;
};

// Streams the text in steps like a code fence that is still open, then
// highlights it once more as the closed fence.
const streamWith = async (
  highlight: (code: string, isIncomplete: boolean) => unknown,
  text: string,
  step: number
) => {
  for (let end = step; end < text.length; end += step) {
    await highlight(text.slice(0, end), true);
  }
  await highlight(text, false);
};

// Runs that take seconds would otherwise repeat for minutes.
const SLOW_RUN = { iterations: 3, time: 0, warmupIterations: 1 };
const runOptions = (item: Sample) =>
  item.code.length > 8000 || !item.code.includes("\n") ? SLOW_RUN : undefined;

const complete = [LARGE_TS, HUGE_TS, LARGE_PY, HUGE_JSON, MINIFIED_JS];
const streamed: [Sample, number][] = [
  [SMALL_TS, 4],
  [SMALL_TS, 24],
  [LARGE_TS, 24],
  [LARGE_PY, 24],
  [HUGE_TS, 64],
  [HUGE_JSON, 64],
  [SMALL_MINIFIED_JS, 64],
];

test("shiki vs highlights", async ({ bench }) => {
  for (const plugin of Object.values(plugins)) {
    for (const { language } of complete) {
      await highlightWith(plugin, "x", language);
    }
  }

  for (const item of complete) {
    for (const [name, plugin] of Object.entries(plugins)) {
      await bench(`complete ${item.name}: ${name}`, () =>
        highlightWith(plugin, fresh(item), item.language)
      ).run(runOptions(item));
    }
  }

  for (const [item, step] of streamed) {
    for (const [name, plugin] of Object.entries(plugins)) {
      await bench(`stream ${item.name} in ${step}-char steps: ${name}`, () =>
        streamWith(
          (code, isIncomplete) =>
            highlightWith(plugin, code, item.language, isIncomplete),
          fresh(item),
          step
        )
      ).run(runOptions(item));
    }
    // Full re-tokenization of the larger samples takes minutes per run.
    if (item.code.length < 8000) {
      await bench(
        `stream ${item.name} in ${step}-char steps: shiki (full, before #631)`,
        () =>
          streamWith(
            (code) => shikiFull(code, item.language),
            fresh(item),
            step
          )
      ).run(SLOW_RUN);
    }
  }
}, 3_600_000);
