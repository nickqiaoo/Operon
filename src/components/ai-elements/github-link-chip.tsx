import { createContext, useContext, type MouseEvent, type ReactNode } from "react";
import { GithubIcon } from "@/components/icons/GithubIcon";
import { githubLinkKey, type GithubLinkRef } from "@/lib/github-links";
import { openExternalUrl } from "@/lib/open-external";
import { cn } from "@/lib/utils";

/**
 * What the surface around the markdown knows about GitHub: a task's own PR
 * repo (links into it drop the `owner/repo` prefix) and a state word for the
 * PRs it tracks (`closed`, `merged`), keyed by {@link githubLinkKey}.
 */
export interface GithubLinkInfo {
  repo?: string;
  states?: Record<string, string>;
}

const GithubLinkContext = createContext<GithubLinkInfo>({});

export function GithubLinkProvider({ value, children }: { value: GithubLinkInfo; children: ReactNode }) {
  return <GithubLinkContext.Provider value={value}>{children}</GithubLinkContext.Provider>;
}

/** A bare GitHub PR / issue URL in markdown, shown the way the task sidebar names it: `PR #1 · closed`. */
export function GithubLinkChip({ link }: { link: GithubLinkRef }) {
  const { repo, states } = useContext(GithubLinkContext);
  const key = githubLinkKey(link.owner, link.repo, link.number);
  const sameRepo = repo != null && repo.toLowerCase() === `${link.owner}/${link.repo}`.toLowerCase();
  const label = sameRepo
    ? `${link.kind === "pull" ? "PR" : "Issue"} #${link.number}`
    : `${link.owner}/${link.repo}#${link.number}`;
  const state = states?.[key];
  const open = (e: MouseEvent<HTMLButtonElement>) => {
    e.preventDefault();
    e.stopPropagation();
    openExternalUrl(link.url);
  };
  return (
    <button
      type="button"
      title={link.url}
      onClick={open}
      className={cn(
        "inline-flex max-w-full appearance-none items-baseline gap-1 rounded border border-border/50 bg-muted/40 px-1.5 align-baseline text-[0.92em] leading-[1.45] text-foreground/85 no-underline transition-colors [font-family:inherit]",
        "hover:bg-accent-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 dark:border-border/35",
      )}
    >
      <GithubIcon className="h-3 w-3 shrink-0 self-center" />
      <span className="truncate">{label}</span>
      {state && <span className="shrink-0 text-muted-foreground">· {state}</span>}
    </button>
  );
}
