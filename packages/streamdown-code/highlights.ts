"use client";

import {
  type CodeToTokensOptions,
  codeToTokens,
  isSupportedLanguage,
  LiveTokenizer,
  type Theme,
  type ThemedToken,
  type TokensResult,
} from "@pierre/highlights";
import githubDark from "@pierre/highlights/themes/github-dark";
import githubLight from "@pierre/highlights/themes/github-light";
import type { BundledLanguage } from "shiki";
import type {
  CodeHighlighterPlugin,
  HighlightOptions,
  HighlightResult,
  ThemeInput,
} from "./index";

export type HighlightsThemeInput = ThemeInput | Theme;

export interface HighlightsCodePluginOptions {
  /**
   * Themes for syntax highlighting [light, dark]. Bundled names other than
   * `github-light` and `github-dark` need their Highlights theme object.
   * @default [githubLight, githubDark]
   */
  themes?: [HighlightsThemeInput, HighlightsThemeInput];
}

const builtInThemes: Record<string, Theme> = {
  "github-dark": githubDark,
  "github-light": githubLight,
};

const isHighlightsTheme = (theme: unknown): theme is Theme =>
  typeof theme === "object" &&
  theme !== null &&
  "style" in theme &&
  "appearance" in theme;

const resolveTheme = (theme: HighlightsThemeInput, fallback: Theme): Theme => {
  if (isHighlightsTheme(theme)) {
    return theme;
  }
  if (typeof theme === "string") {
    return builtInThemes[theme] ?? fallback;
  }
  return fallback;
};

// Results of finished code blocks, least recently used first. Highlighting is
// synchronous, so this only keeps token arrays (and the React memo keyed on
// them) stable when the same block renders again.
const MAX_CACHED_RESULTS = 200;
const tokensCache = new Map<string, TokensResult>();

const getCached = (key: string): TokensResult | undefined => {
  const result = tokensCache.get(key);
  if (result) {
    tokensCache.delete(key);
    tokensCache.set(key, result);
  }
  return result;
};

const setCached = (key: string, result: TokensResult): void => {
  tokensCache.set(key, result);
  if (tokensCache.size > MAX_CACHED_RESULTS) {
    tokensCache.delete(tokensCache.keys().next().value as string);
  }
};

/**
 * A streaming block's document, kept in a `LiveTokenizer` so each update
 * re-tokenizes only the lines its appended text changes.
 */
interface StreamState {
  code: string;
  key: string;
  /** Start offset of each line in `code` */
  lineStarts: number[];
  live: LiveTokenizer;
  meta: Omit<TokensResult, "tokens">;
  rows: ThemedToken[][];
}

// Each state owns a WebAssembly instance, so only a few are kept. That still
// lets blocks that stream at the same time in different renderers each keep
// their own.
const MAX_STREAM_STATES = 4;
const streamStates: StreamState[] = [];

const lineBreakLength = (code: string, end: number): number => {
  if (code[end] === "\r") {
    return code[end + 1] === "\n" ? 2 : 1;
  }
  return 1;
};

// Rebuilds the rows from `fromLine` on with offsets into the whole code.
const refreshRows = (state: StreamState, fromLine: number): void => {
  const { code, live, lineStarts, rows } = state;
  rows.length = fromLine;
  lineStarts.length = fromLine + 1;
  for (let line = fromLine; line < live.lineCount; line += 1) {
    const start = lineStarts[line] ?? 0;
    const { tokens } = live.getLineTokens(line);
    for (const token of tokens) {
      token.offset += start;
    }
    rows.push(tokens);
    const end = start + live.getLineLength(line);
    lineStarts.push(end + lineBreakLength(code, end));
  }
};

const createStreamState = (
  code: string,
  key: string,
  options: CodeToTokensOptions
): StreamState => {
  const { tokens: _, ...meta } = codeToTokens("", options);
  const state: StreamState = {
    code,
    key,
    lineStarts: [0],
    live: new LiveTokenizer({ ...options, code }),
    meta,
    rows: [],
  };
  refreshRows(state, 0);
  return state;
};

const appendToStream = (state: StreamState, code: string): void => {
  const lastLine = state.live.lineCount - 1;
  const end = { line: lastLine, character: state.live.getLineLength(lastLine) };
  const update = state.live.applyEdits([
    { range: { start: end, end }, newText: code.slice(state.code.length) },
  ]);
  state.code = code;
  let fromLine = lastLine;
  for (const change of update.lineChanges) {
    fromLine = Math.min(fromLine, change.newStartLine);
  }
  refreshRows(state, fromLine);
};

const highlightStreaming = (
  code: string,
  key: string,
  options: CodeToTokensOptions
): TokensResult => {
  // A live document breaks the line at a lone "\r", but a full highlight
  // keeps it in the line until its "\n" arrives.
  if (code.endsWith("\r")) {
    return codeToTokens(code, options);
  }
  const index = streamStates.findIndex(
    (candidate) => candidate.key === key && code.startsWith(candidate.code)
  );
  let state: StreamState;
  if (index === -1) {
    state = createStreamState(code, key, options);
    if (streamStates.length >= MAX_STREAM_STATES) {
      streamStates.pop()?.live.dispose();
    }
  } else {
    [state] = streamStates.splice(index, 1);
    if (code.length > state.code.length) {
      appendToStream(state, code);
    }
  }
  streamStates.unshift(state);
  // A new array per update, so React sees the change
  return { ...state.meta, tokens: [...state.rows] };
};

/**
 * Create a code plugin backed by `@pierre/highlights` instead of Shiki.
 * Highlighting runs synchronously, so `highlight` always returns a result.
 */
export function createHighlightsCodePlugin(
  options: HighlightsCodePluginOptions = {}
): CodeHighlighterPlugin {
  const defaultThemes: [HighlightsThemeInput, HighlightsThemeInput] =
    options.themes ?? [githubLight, githubDark];

  return {
    name: "shiki",
    type: "code-highlighter",

    supportsLanguage(language: BundledLanguage): boolean {
      return isSupportedLanguage(language.trim().toLowerCase());
    },

    getSupportedLanguages(): BundledLanguage[] {
      return [];
    },

    getThemes() {
      return defaultThemes as [ThemeInput, ThemeInput];
    },

    highlight({
      code,
      language,
      themes,
      isIncomplete = false,
    }: HighlightOptions): HighlightResult {
      const lower = language.trim().toLowerCase();
      const lang = isSupportedLanguage(lower) ? lower : "text";
      const light = resolveTheme(themes[0], githubLight);
      const dark = resolveTheme(themes[1], githubDark);
      const highlighterKey = `${lang}:${light.name}:${dark.name}`;
      const tokensOptions: CodeToTokensOptions = {
        lang,
        themes: { light, dark },
        cssVariablePrefix: "--shiki-",
      };

      if (isIncomplete) {
        return highlightStreaming(code, highlighterKey, tokensOptions);
      }

      const key = `${highlighterKey}\n${code}`;
      let result = getCached(key);
      if (!result) {
        result = codeToTokens(code, tokensOptions);
        setCached(key, result);
      }
      return result;
    },
  };
}

export const highlightsCode = createHighlightsCodePlugin();
