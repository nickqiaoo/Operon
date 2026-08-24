import { existsSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { BrowserCapability } from "../wire.ts";

interface ApiDeclaration {
  text: string;
  references?: string[];
}

interface ApiMember {
  declarations?: ApiDeclaration[];
  documented?: boolean;
}

interface ApiManifest {
  interfaces: Record<string, Record<string, ApiMember>>;
  root: string;
  types: Record<string, { text?: string }>;
}

interface DocumentationCondition {
  browserTypes?: string[];
  requiredApiMembers?: string[];
  requiredBrowserCapabilities?: string[];
}

interface DocumentationEntry {
  description?: string;
  mode: "included" | "lookup";
  name: string;
  when?: DocumentationCondition;
}

export interface BrowserDocumentationContext {
  browserId: string;
  browserName: string;
  browserType: "iab" | "extension" | "cdp";
  apiSupportOverrides?: Record<string, boolean>;
  browserCapabilities?: BrowserCapability[];
  tabCapabilities?: BrowserCapability[];
}

const UNSUPPORTED_BY_DEFAULT: Readonly<Record<string, readonly string[]>> = {
  "BrowserUser.claimTab": ["iab", "cdp"],
  "BrowserUser.history": ["iab", "cdp"],
  "Tabs.content": ["iab", "extension", "cdp"],
  "Tabs.finalize": ["iab", "cdp"],
  "Tab.markDeliverable": ["iab", "cdp"],
  "Tab.markHandoff": ["iab", "cdp"],
  "CUAAPI.downloadMedia": ["iab"],
  "DomCUAAPI.downloadMedia": ["iab"],
};

// Current browser-client keeps these runtime methods for internal compatibility,
// but its model-facing API view always disables them in favour of Tabs.finalize().
const DISABLED_MODEL_MEMBERS = new Set([
  "Tab.markDeliverable",
  "Tab.markHandoff",
]);

function documentationRoots(): string[] {
  return [
    fileURLToPath(new URL("../docs/", import.meta.url)),
    fileURLToPath(new URL("./docs/", import.meta.url)),
  ];
}

function documentationRoot(): string {
  const root = documentationRoots().find((candidate) =>
    existsSync(`${candidate}/api.json`),
  );
  if (root == null) {
    throw new Error("Browser documentation assets are unavailable");
  }
  return root;
}

function readJsonFile<T>(name: string): T {
  return JSON.parse(readFileSync(`${documentationRoot()}/${name}`, "utf8")) as T;
}

const API_MANIFEST = readJsonFile<ApiManifest>("api.json");
const DOCUMENTS = readJsonFile<DocumentationEntry[]>("documents.json");

export function supportsBrowserApiMember(
  context: Pick<BrowserDocumentationContext, "browserType" | "apiSupportOverrides">,
  member: string,
): boolean {
  if (DISABLED_MODEL_MEMBERS.has(member)) return false;
  const separator = member.indexOf(".");
  const interfaceName = separator === -1 ? member : member.slice(0, separator);
  const memberName = separator === -1 ? "" : member.slice(separator + 1);
  if (API_MANIFEST.interfaces[interfaceName]?.[memberName] == null) return false;
  const override = context.apiSupportOverrides?.[member];
  if (override != null) return override;
  return !(UNSUPPORTED_BY_DEFAULT[member] ?? []).includes(context.browserType);
}

function conditionMatches(
  condition: DocumentationCondition | undefined,
  context: BrowserDocumentationContext,
): boolean {
  if (condition?.browserTypes != null && !condition.browserTypes.includes(context.browserType)) {
    return false;
  }
  if (
    condition?.requiredApiMembers != null
    && !condition.requiredApiMembers.every((member) => supportsBrowserApiMember(context, member))
  ) {
    return false;
  }
  if (condition?.requiredBrowserCapabilities != null) {
    const capabilities = new Set((context.browserCapabilities ?? []).map((item) => item.id));
    if (!condition.requiredBrowserCapabilities.every((id) => capabilities.has(id))) return false;
  }
  return true;
}

function renderApiReference(context: BrowserDocumentationContext): string {
  const sections = ["# Browser API Reference"];
  for (const [interfaceName, members] of Object.entries(API_MANIFEST.interfaces)) {
    const declarations: string[] = [];
    for (const [memberName, member] of Object.entries(members)) {
      if (member.documented === false) continue;
      if (!supportsBrowserApiMember(context, `${interfaceName}.${memberName}`)) continue;
      for (const declaration of member.declarations ?? []) declarations.push(declaration.text);
    }
    if (declarations.length === 0) continue;
    sections.push(`## ${interfaceName}\n\n\`\`\`ts\n${declarations.join("\n")}\n\`\`\``);
  }

  const typeDeclarations = Object.values(API_MANIFEST.types)
    .map((entry) => entry.text)
    .filter((text): text is string => typeof text === "string" && text.length > 0);
  if (typeDeclarations.length > 0) {
    sections.push(`## Types\n\n\`\`\`ts\n${typeDeclarations.join("\n\n")}\n\`\`\``);
  }
  return sections.join("\n\n");
}

function safeDocumentName(name: string): string {
  const normalized = name.trim().replace(/\.md$/u, "");
  if (
    normalized === ""
    || normalized.startsWith("/")
    || normalized.split("/").some((part) => part === "" || part === "." || part === "..")
    || !/^[a-zA-Z0-9/_-]+$/u.test(normalized)
  ) {
    throw new Error(`Invalid browser documentation name: ${name}`);
  }
  return normalized;
}

export async function readBrowserDocument(name: string): Promise<string> {
  const normalized = safeDocumentName(name);
  for (const root of documentationRoots()) {
    try {
      return await readFile(`${root}/${normalized}.md`, "utf8");
    } catch {
      // Packaged and source layouts use different relative roots.
    }
  }
  throw new Error(`Browser documentation not found: ${normalized}`);
}

async function readCapabilityDocuments(context: BrowserDocumentationContext): Promise<string[]> {
  const documents: string[] = [];
  const groups: Array<["browser" | "tab", BrowserCapability[]]> = [
    ["browser", context.browserCapabilities ?? []],
    ["tab", context.tabCapabilities ?? []],
  ];
  for (const [scope, capabilities] of groups) {
    for (const capability of capabilities) {
      // Explicitly out of scope for the current implementation.
      if (capability.id === "browserAuth" || capability.id.toLowerCase() === "webmcp") continue;
      try {
        documents.push(await readBrowserDocument(`capabilities/${scope}/${capability.id}`));
      } catch {
        documents.push(`# ${scope === "browser" ? "Browser" : "Tab"} Capability: ${capability.id}\n\n${capability.description}`);
      }
    }
  }
  return documents;
}

export async function readCapabilityDocumentation(
  scope: "browser" | "tab",
  capability: BrowserCapability,
): Promise<string> {
  if (capability.id === "browserAuth" || capability.id.toLowerCase() === "webmcp") {
    throw new Error(`Capability is not available: ${capability.id}`);
  }
  try {
    return await readBrowserDocument(`capabilities/${scope}/${capability.id}`);
  } catch {
    return capability.description;
  }
}

function lookupCatalog(context: BrowserDocumentationContext): string | undefined {
  const entries = DOCUMENTS.filter(
    (entry) => entry.mode === "lookup" && conditionMatches(entry.when, context),
  );
  if (entries.length === 0) return undefined;
  const lines = entries.map((entry) =>
    `- \`${entry.name}\`${entry.description == null ? "" : ` — ${entry.description}`}`,
  );
  return `# Additional Browser Documentation\n\nUse \`await agent.documentation.get(name)\` when needed.\n\n${lines.join("\n")}`;
}

export async function buildBrowserDocumentation(
  context: BrowserDocumentationContext,
): Promise<string> {
  const selected = [
    "# Selected Browser",
    `- Name: ${context.browserName}`,
    `- Type: ${context.browserType}`,
    `- ID: ${context.browserId}`,
    "Reuse this browser binding across later turns. A new user turn or tab error does not invalidate it.",
    "If a tab is stale or missing, obtain or create a fresh tab from this browser instead of reselecting a browser.",
  ].join("\n");

  const included: string[] = [];
  for (const entry of DOCUMENTS) {
    if (entry.mode !== "included" || !conditionMatches(entry.when, context)) continue;
    included.push(await readBrowserDocument(entry.name));
  }
  included.push(...await readCapabilityDocuments(context));

  return [
    selected,
    ...included,
    renderApiReference(context),
    lookupCatalog(context),
  ].filter((section): section is string => section != null && section.trim() !== "").join("\n\n");
}

const DEFAULT_DOCUMENTATION_CONTEXT: BrowserDocumentationContext = {
  browserId: "iab",
  browserName: "Operon",
  browserType: "iab",
  apiSupportOverrides: {
    "BrowserUser.claimTab": true,
    "Tabs.content": true,
    "Tabs.finalize": true,
  },
};

/** Synchronous API reference retained for tests and non-selected help surfaces. */
export const BROWSER_DOCUMENTATION = renderApiReference(DEFAULT_DOCUMENTATION_CONTEXT);
