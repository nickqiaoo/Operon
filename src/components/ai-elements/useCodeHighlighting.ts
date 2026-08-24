import { useEffect, useMemo, useState } from "react";
import type { BundledLanguage } from "shiki";
import {
  type TokenizedCode,
  createRawTokens,
  highlightCode,
} from "./shikiHighlighter";

export function useCodeHighlighting(
  code: string,
  language: BundledLanguage
): TokenizedCode {
  // Memoized raw tokens for immediate display
  const rawTokens = useMemo(() => createRawTokens(code), [code]);

  // Try to get cached result synchronously, otherwise use raw tokens
  const [tokenized, setTokenized] = useState<TokenizedCode>(
    () => highlightCode(code, language) ?? rawTokens
  );

  useEffect(() => {
    // Reset to raw tokens when code changes (shows current code, not stale tokens)
    setTokenized(highlightCode(code, language) ?? rawTokens);

    // Subscribe to async highlighting result
    highlightCode(code, language, setTokenized);
  }, [code, language, rawTokens]);

  return tokenized;
}
