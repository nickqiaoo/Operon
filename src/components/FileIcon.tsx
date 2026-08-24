import {
    FileText,
} from "lucide-react"
import {
    SiTypescript,
    SiJavascript,
    SiGo,
    SiPython,
    SiRust,
    SiHtml5,
    SiCss,
    SiSass,
    SiJson,
    SiMarkdown,
    SiDocker,
    SiGit,
    SiNextdotjs,
    SiVite,
    SiPostgresql,
    SiBun,
    SiYarn,
    SiNpm,
    SiPnpm,
    SiTailwindcss,
    SiEslint,
    SiPrettier,
    SiGnubash,
    SiCplusplus,
    SiC,
    SiKotlin,
    SiRuby,
    SiPhp,
    SiOpenjdk,
} from "react-icons/si"
import { VscFileMedia, VscFileZip } from "react-icons/vsc"
import { cn } from "@/lib/utils"

export const getFileIcon = (name: string, className?: string) => {
    const lowerName = name.toLowerCase()
    const ext = name.split(".").pop()?.toLowerCase() || ""
    const sizeClass = className || "size-4"

    // Specific filenames
    if (lowerName === "package.json") return <SiNpm className={cn(sizeClass, "text-[#CB3837]")} />
    if (lowerName === "bun.lockb" || lowerName === "bun.lock") return <SiBun className={cn(sizeClass, "text-[#FBF0DF]")} />
    if (lowerName === "yarn.lock") return <SiYarn className={cn(sizeClass, "text-[#2C8EBB]")} />
    if (lowerName === "pnpm-lock.yaml") return <SiPnpm className={cn(sizeClass, "text-[#F69220]")} />
    if (lowerName === "dockerfile") return <SiDocker className={cn(sizeClass, "text-[#2496ED]")} />
    if (lowerName === "makefile") return <FileText className={cn(sizeClass, "text-muted-foreground")} />
    if (lowerName.startsWith(".env")) return <FileText className={cn(sizeClass, "text-[#ECD53F]")} />
    if (lowerName === ".gitignore" || lowerName === ".gitattributes") return <SiGit className={cn(sizeClass, "text-[#F05032]")} />
    if (lowerName === ".eslintrc.json" || lowerName.includes("eslint")) return <SiEslint className={cn(sizeClass, "text-[#4B32C3]")} />
    if (lowerName === ".prettierrc" || lowerName.includes("prettier")) return <SiPrettier className={cn(sizeClass, "text-[#F7B93E]")} />
    if (lowerName === "tailwind.config.js" || lowerName === "tailwind.config.ts") return <SiTailwindcss className={cn(sizeClass, "text-[#06B6D4]")} />
    if (lowerName === "next.config.js" || lowerName === "next.config.mjs") return <SiNextdotjs className={cn(sizeClass, "text-foreground")} />
    if (lowerName === "vite.config.ts" || lowerName === "vite.config.js") return <SiVite className={cn(sizeClass, "text-[#646CFF]")} />
    if (lowerName === "tsconfig.json") return <SiTypescript className={cn(sizeClass, "text-[#3178C6]")} />

    // Extensions
    switch (ext) {
        case "ts":
        case "tsx":
            if (lowerName.endsWith(".test.tsx") || lowerName.endsWith(".spec.tsx"))
                return <SiTypescript className={cn(sizeClass, "text-[#3178C6] opacity-70")} />
            return <SiTypescript className={cn(sizeClass, "text-[#3178C6]")} />
        case "js":
        case "jsx":
        case "mjs":
        case "cjs":
            return <SiJavascript className={cn(sizeClass, "text-[#F7DF1E]")} />
        case "go":
            return <SiGo className={cn(sizeClass, "text-[#00ADD8]")} />
        case "py":
        case "python":
            return <SiPython className={cn(sizeClass, "text-[#3776AB]")} />
        case "rs":
            return <SiRust className={cn(sizeClass, "text-[#DEA584]")} />
        case "html":
            return <SiHtml5 className={cn(sizeClass, "text-[#E34F26]")} />
        case "css":
            return <SiCss className={cn(sizeClass, "text-[#1572B6]")} />
        case "scss":
        case "sass":
            return <SiSass className={cn(sizeClass, "text-[#CC6699]")} />
        case "json":
        case "jsonc":
        case "json5":
            return <SiJson className={cn(sizeClass, "text-[#F7DF1E]")} />
        case "md":
        case "mdx":
            return <SiMarkdown className={cn(sizeClass, "text-foreground/80")} />
        case "java":
        case "jar":
            return <SiOpenjdk className={cn(sizeClass, "text-[#ED8B00]")} />
        case "kt":
        case "kts":
            return <SiKotlin className={cn(sizeClass, "text-[#7F52FF]")} />
        case "rb":
        case "erb":
            return <SiRuby className={cn(sizeClass, "text-[#CC342D]")} />
        case "php":
            return <SiPhp className={cn(sizeClass, "text-[#777BB4]")} />
        case "c":
        case "h":
            return <SiC className={cn(sizeClass, "text-[#A8B9CC]")} />
        case "cpp":
        case "hpp":
        case "cc":
            return <SiCplusplus className={cn(sizeClass, "text-[#00599C]")} />
        case "sh":
        case "bash":
        case "zsh":
            return <SiGnubash className={cn(sizeClass, "text-[#4EAA25]")} />
        case "yaml":
        case "yml":
            return <FileText className={cn(sizeClass, "text-purple-400")} />
        case "sql":
            return <SiPostgresql className={cn(sizeClass, "text-[#336791]")} />
        case "png":
        case "jpg":
        case "jpeg":
        case "gif":
        case "svg":
        case "webp":
        case "ico":
            return <VscFileMedia className={cn(sizeClass, "text-emerald-500")} />
        case "zip":
        case "tar":
        case "gz":
        case "7z":
            return <VscFileZip className={cn(sizeClass, "text-orange-500")} />
        default:
            return <FileText className={cn(sizeClass, "text-muted-foreground")} />
    }
}

export function FileIcon({ name, className }: { name: string; className?: string }) {
    return getFileIcon(name, className)
}
