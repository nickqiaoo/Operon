import { useMemo, useState } from "react"
import { CheckIcon, ChevronDownIcon, Loader2 } from "lucide-react"
import { useIntl } from "react-intl"
import {
  ModelSelectorEmpty,
  ModelSelectorInput,
  ModelSelectorItem,
  ModelSelectorList,
} from "@/components/ai-elements/model-selector"
import { MobileSheet } from "@/components/mobile/MobileSheet"
import { Command } from "@/components/ui/command"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { TruncatedText } from "@/components/ui/truncated-text"
import { useIsMobile } from "@/hooks/useIsMobile"
import type { ProviderModelOption } from "@/lib/provider-queries"
import { cn } from "@/lib/utils"

/** cmdk needs a non-empty value to highlight the "no specific model" row. */
const DEFAULT_ITEM = "__default__"

function modelLabel(model: ProviderModelOption): string {
  return model.name === model.modelId ? model.modelId : `${model.name} · ${model.modelId}`
}

interface ModelComboboxProps {
  /** The picked model id; empty means the default row, or nothing when there is none. */
  value: string
  onValueChange: (modelId: string) => void
  models: ProviderModelOption[]
  /** Adds a row on top that picks no specific model (reported as ""). */
  defaultLabel?: string
  placeholder?: string
  loading?: boolean
  disabled?: boolean
  "aria-label"?: string
  className?: string
}

/** A searchable model picker for settings forms, for lists too long to scan in a plain Select. */
export function ModelCombobox({
  value,
  onValueChange,
  models,
  defaultLabel,
  placeholder,
  loading,
  disabled,
  "aria-label": ariaLabel,
  className,
}: ModelComboboxProps) {
  const intl = useIntl()
  const isMobile = useIsMobile()
  const [open, setOpen] = useState(false)
  const title = ariaLabel ?? intl.formatMessage({ id: "editor.model.selectTitle", defaultMessage: "Select model" })

  const selected = models.find((m) => m.modelId === value)
  const label = selected ? modelLabel(selected) : value || defaultLabel || placeholder

  const list = (
    <ModelComboboxList
      value={value}
      models={models}
      defaultLabel={defaultLabel}
      loading={loading}
      title={title}
      onPick={(modelId) => {
        onValueChange(modelId)
        setOpen(false)
      }}
    />
  )
  const trigger = (
    <button
      type="button"
      role="combobox"
      aria-label={title}
      aria-haspopup="dialog"
      aria-expanded={open}
      disabled={disabled}
      onClick={isMobile ? () => setOpen(true) : undefined}
      className={cn(
        "flex h-9 items-center justify-between gap-2 rounded-lg border border-border/50 bg-background/80 px-3 text-xs whitespace-nowrap shadow-card transition-[color,box-shadow] outline-none focus-visible:border-ring disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
    >
      <TruncatedText className={cn("min-w-0 truncate", !value && !defaultLabel && "text-muted-foreground")}>
        {label ?? ""}
      </TruncatedText>
      <ChevronDownIcon className="size-4 shrink-0 text-muted-foreground opacity-50" />
    </button>
  )

  if (isMobile) {
    return (
      <>
        {trigger}
        <MobileSheet open={open} onClose={() => setOpen(false)} title={title} bodyClassName="px-1 pb-3">
          {list}
        </MobileSheet>
      </>
    )
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      <PopoverContent
        align="start"
        sideOffset={6}
        collisionPadding={8}
        aria-label={title}
        className="w-96 max-w-[calc(100vw-1rem)] p-1"
      >
        {list}
      </PopoverContent>
    </Popover>
  )
}

/** Mounted only while open, so the search box always starts empty. */
function ModelComboboxList({
  value,
  models,
  defaultLabel,
  loading,
  title,
  onPick,
}: Pick<ModelComboboxProps, "value" | "models" | "defaultLabel" | "loading"> & {
  title: string
  onPick: (modelId: string) => void
}) {
  const intl = useIntl()
  const [search, setSearch] = useState("")
  const query = search.toLowerCase()

  const filtered = useMemo(
    () => models.filter((m) => m.name.toLowerCase().includes(query) || m.modelId.toLowerCase().includes(query)),
    [models, query],
  )
  const showDefault = defaultLabel !== undefined && defaultLabel.toLowerCase().includes(query)

  return (
    <Command shouldFilter={false} defaultValue={value || (defaultLabel ? DEFAULT_ITEM : undefined)} className="h-auto">
      <ModelSelectorInput
        value={search}
        onValueChange={setSearch}
        aria-label={title}
        placeholder={intl.formatMessage({ id: "editor.modelSearch", defaultMessage: "Search models..." })}
        className="text-base md:text-sm"
      />
      <ModelSelectorList className="max-h-[min(18rem,50vh)] p-1">
        {!loading && (
          <ModelSelectorEmpty>
            {intl.formatMessage({ id: "editor.model.noModelsFound", defaultMessage: "No models found." })}
          </ModelSelectorEmpty>
        )}
        {showDefault && (
          <ModelSelectorItem value={DEFAULT_ITEM} onSelect={() => onPick("")} className="py-2 text-xs md:py-1.5">
            <span className="min-w-0 flex-1 truncate">{defaultLabel}</span>
            {!value && <CheckIcon className="size-3.5 shrink-0 text-tint" />}
          </ModelSelectorItem>
        )}
        {filtered.map((m) => (
          <ModelSelectorItem
            key={m.modelId}
            value={m.modelId}
            onSelect={() => onPick(m.modelId)}
            className="py-2 text-xs md:py-1.5"
          >
            <TruncatedText className="min-w-0 flex-1 truncate">{m.name}</TruncatedText>
            {m.name !== m.modelId && <TruncatedText className="max-w-[45%] truncate text-muted-foreground">{m.modelId}</TruncatedText>}
            {value === m.modelId && <CheckIcon className="size-3.5 shrink-0 text-tint" />}
          </ModelSelectorItem>
        ))}
        {loading && (
          <div className="flex items-center gap-2 px-2 py-1.5 text-xs text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            {intl.formatMessage({ id: "assistant.settings.loadingModels", defaultMessage: "Loading models…" })}
          </div>
        )}
      </ModelSelectorList>
    </Command>
  )
}
