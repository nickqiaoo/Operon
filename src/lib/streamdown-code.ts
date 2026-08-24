import {
  createCodePlugin,
  type CodeHighlighterPlugin,
  type CodePluginOptions,
  type HighlightOptions,
  type HighlightResult,
} from "@streamdown/code";
import type { BundledLanguage } from "shiki";

const fallbackLanguageMap: Record<string, BundledLanguage> = {
  dotenv: "ini",
  env: "ini",
};

const normalizeCodeLanguage = (language: string): BundledLanguage => {
  const normalized = language.trim().toLowerCase();
  return fallbackLanguageMap[normalized] ?? (language as BundledLanguage);
};

const createPlainTextHighlightResult = (code: string): HighlightResult => ({
  tokens: (code || "").split("\n").map((line) =>
    line === ""
      ? []
      : [
          {
            content: line,
            color: "inherit",
            offset: 0,
          },
        ]
  ),
  fg: "inherit",
  bg: "transparent",
});

export const createSafeCodePlugin = (
  options?: CodePluginOptions
): CodeHighlighterPlugin => {
  const basePlugin = createCodePlugin(options);

  return {
    ...basePlugin,
    supportsLanguage: () => true,
    highlight: (
      options: HighlightOptions,
      callback?: (result: HighlightResult) => void
    ) => {
      const normalizedLanguage = normalizeCodeLanguage(options.language as string);
      if (!basePlugin.supportsLanguage(normalizedLanguage)) {
        return createPlainTextHighlightResult(options.code);
      }

      return basePlugin.highlight(
        {
          ...options,
          language: normalizedLanguage,
        },
        callback
      );
    },
  };
};

export const safeCode = createSafeCodePlugin();
