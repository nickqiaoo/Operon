import { useState, useEffect, useCallback } from "react"
import { api } from "@/lib/api"
import { parse as parseToml } from "smol-toml"

export interface ConfigFileState {
    content: string
    originalContent: string
    loading: boolean
    saving: boolean
    error: string | null
    saved: boolean
    validationError: string | null
}

export interface ConfigFileDefinition<T extends string = string> {
    id: T
    label: React.ReactNode
    filename: string
    icon: React.ComponentType<{ className?: string }>
    /** "json" | "toml" | "none" */
    validation: "json" | "toml" | "none"
    placeholder?: string
    description?: React.ReactNode
}

function validateJson(content: string): string | null {
    if (!content.trim()) return null
    try {
        JSON.parse(content)
        return null
    } catch (e) {
        if (e instanceof SyntaxError) {
            const match = e.message.match(/position (\d+)/)
            if (match) {
                const position = parseInt(match[1])
                const lines = content.substring(0, position).split('\n')
                const line = lines.length
                const column = lines[lines.length - 1].length + 1
                return `JSON Error at line ${line}, column ${column}: ${e.message.replace(/at position \d+/, '').trim()}`
            }
            return `JSON Error: ${e.message}`
        }
        return `JSON Error: ${e}`
    }
}

function validateToml(content: string): string | null {
    if (!content.trim()) return null
    try {
        parseToml(content)
        return null
    } catch (e) {
        if (e instanceof Error) {
            return `TOML Error: ${e.message}`
        }
        return `TOML Error: ${e}`
    }
}

function validate(content: string, type: "json" | "toml" | "none"): string | null {
    if (type === "json") return validateJson(content)
    if (type === "toml") return validateToml(content)
    return null
}

interface UseConfigEditorOptions<T extends string> {
    configDir: string // e.g. ".claude", ".codex", ".config/opencode"
    files: ConfigFileDefinition<T>[]
}

export function useConfigEditor<T extends string>({ configDir, files }: UseConfigEditorOptions<T>) {
    const [activeFile, setActiveFile] = useState<T>(files[0].id)
    const [homePath, setHomePath] = useState("")
    const [fileStates, setFileStates] = useState<Record<T, ConfigFileState>>(() => {
        const initial = {} as Record<T, ConfigFileState>
        for (const f of files) {
            initial[f.id] = {
                content: "",
                originalContent: "",
                loading: true,
                saving: false,
                error: null,
                saved: false,
                validationError: null,
            }
        }
        return initial
    })

    const getFilePath = useCallback((filename: string) => {
        if (!homePath) return ""
        return `${homePath}/${configDir}/${filename}`
    }, [homePath, configDir])

    useEffect(() => {
        api.getHomePath().then(setHomePath).catch(err => {
            console.error("Failed to get home path:", err)
        })
    }, [])

    useEffect(() => {
        if (!homePath) return

        async function loadFile(fileDef: ConfigFileDefinition<T>) {
            const filePath = `${homePath}/${configDir}/${fileDef.filename}`
            try {
                const exists = await api.exists(filePath)
                if (!exists) {
                    const defaultContent = fileDef.filename.endsWith(".json") ? "{}" : ""
                    setFileStates(prev => ({
                        ...prev,
                        [fileDef.id]: { ...prev[fileDef.id], content: defaultContent, originalContent: defaultContent, loading: false }
                    }))
                    return
                }
                const content = await api.readFile(filePath)
                setFileStates(prev => ({
                    ...prev,
                    [fileDef.id]: { ...prev[fileDef.id], content, originalContent: content, loading: false }
                }))
            } catch (err) {
                setFileStates(prev => ({
                    ...prev,
                    [fileDef.id]: { ...prev[fileDef.id], loading: false, error: `Failed to load: ${err}` }
                }))
            }
        }

        files.forEach(f => loadFile(f))
    }, [homePath, configDir, files])

    const handleContentChange = useCallback((fileId: T, content: string) => {
        const fileDef = files.find(f => f.id === fileId)
        const validationError = fileDef ? validate(content, fileDef.validation) : null
        setFileStates(prev => ({
            ...prev,
            [fileId]: { ...prev[fileId], content, saved: false, validationError }
        }))
    }, [files])

    const handleSave = useCallback(async (fileId: T) => {
        const fileDef = files.find(f => f.id === fileId)
        if (!fileDef || !homePath) return

        const filePath = getFilePath(fileDef.filename)
        setFileStates(prev => ({
            ...prev,
            [fileId]: { ...prev[fileId], saving: true, error: null }
        }))

        try {
            await api.writeFile(filePath, fileStates[fileId].content)
            setFileStates(prev => ({
                ...prev,
                [fileId]: { ...prev[fileId], saving: false, saved: true, originalContent: prev[fileId].content }
            }))
            setTimeout(() => {
                setFileStates(prev => ({
                    ...prev,
                    [fileId]: { ...prev[fileId], saved: false }
                }))
            }, 2000)
        } catch (err) {
            setFileStates(prev => ({
                ...prev,
                [fileId]: { ...prev[fileId], saving: false, error: `Failed to save: ${err}` }
            }))
        }
    }, [files, homePath, getFilePath, fileStates])

    const currentFile = fileStates[activeFile]
    const currentFileDef = files.find(f => f.id === activeFile)
    const hasChanges = currentFile.content !== currentFile.originalContent

    return {
        activeFile,
        setActiveFile,
        homePath,
        getFilePath,
        fileStates,
        currentFile,
        currentFileDef,
        hasChanges,
        handleContentChange,
        handleSave,
        files,
    }
}
