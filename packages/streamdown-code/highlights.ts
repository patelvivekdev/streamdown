"use client";

import {
  codeToTokens,
  isSupportedLanguage,
  type Theme,
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
      const key = `${lang}:${light.name}:${dark.name}\n${code}`;

      let result = getCached(key);
      if (!result) {
        result = codeToTokens(code, {
          lang,
          themes: { light, dark },
          cssVariablePrefix: "--shiki-",
        });
        if (!isIncomplete) {
          setCached(key, result);
        }
      }
      return result;
    },
  };
}

export const highlightsCode = createHighlightsCodePlugin();
