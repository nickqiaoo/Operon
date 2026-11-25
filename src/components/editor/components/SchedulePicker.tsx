import { useIntl } from 'react-intl'
import { displaySendTime, scheduleText } from './schedule-messages'
import { canScheduleAt, MAX_SEND_DELAY_MINUTES } from '@shared/scheduled-messages'
import { useMemo, useState } from 'react'
import { Clock3, RotateCcw, X } from 'lucide-react'
import { PromptInputButton } from '@/components/ai-elements/prompt-input'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { cn } from '@/lib/utils'
import { isMacPlatform } from '@/lib/shortcuts/accelerator'

export type SendTime = { minutes: number } | { at: number }
const minuteMs = 60_000
const digits = (n: number) => String(n).padStart(2, '0')

function ExactTimePicker({ minute, exact, change }: { minute: number; exact: number; change: (at: number) => void }) {
  const intl = useIntl()
  // Iterate actual instants so the choices also follow local clock changes.
  const days = useMemo(() => {
    const result = new Map<string, Map<number, number[]>>()
    for (let i = 1; i <= MAX_SEND_DELAY_MINUTES; i++) {
      const at = (minute + i) * minuteMs
      const date = new Date(at)
      const day = date.toDateString()
      const hour = at - date.getMinutes() * minuteMs
      const hours = result.get(day) ?? new Map<number, number[]>()
      const minutes = hours.get(hour) ?? []
      minutes.push(at)
      hours.set(hour, minutes)
      result.set(day, hours)
    }
    return result
  }, [minute])
  const date = new Date(exact)
  const day = date.toDateString()
  const hours = days.get(day)
  const hour = exact - date.getMinutes() * minuteMs
  const minuteOptions = hours?.get(hour) ?? []
  return <div className="space-y-2">
    <div className="flex gap-1.5">{Array.from(days, ([key, choices]) => {
      const first = choices.values().next().value![0]
      return <Button key={key} type="button" variant="ghost" size="sm" aria-pressed={key === day}
        className="flex-1 bg-muted/35 text-xs text-muted-foreground aria-pressed:bg-tint/10 aria-pressed:text-tint focus-visible:ring-1 focus-visible:ring-tint/30"
        onClick={() => { if (day !== key) change(first) }}>
        {key === new Date(minute * minuteMs).toDateString() ? intl.formatMessage(scheduleText.today) : intl.formatMessage(scheduleText.tomorrow)}
        <span className="font-normal">{intl.formatDate(first, { month: 'short', day: 'numeric' })}</span>
      </Button>
    })}</div>
    <div className="flex items-center gap-2">
      <Select value={hours?.has(hour) ? String(hour) : ''} onValueChange={v => {
        const options = hours?.get(Number(v))
        if (options) change(options.find(at => new Date(at).getMinutes() === date.getMinutes()) ?? options[0])
      }}>
        <SelectTrigger aria-label={intl.formatMessage(scheduleText.hour)} className="flex-1 tabular-nums focus-visible:border-tint/40"><SelectValue placeholder={intl.formatMessage(scheduleText.hour)} /></SelectTrigger>
        <SelectContent>{Array.from(hours?.keys() ?? [], at =>
          <SelectItem key={at} value={String(at)}>{digits(new Date(at).getHours())}</SelectItem>)}</SelectContent>
      </Select>
      <span aria-hidden="true" className="text-muted-foreground">:</span>
      <Select value={minuteOptions.includes(exact) ? String(exact) : ''} onValueChange={v => change(Number(v))}>
        <SelectTrigger aria-label={intl.formatMessage(scheduleText.minute)} className="flex-1 tabular-nums focus-visible:border-tint/40"><SelectValue placeholder={intl.formatMessage(scheduleText.minute)} /></SelectTrigger>
        <SelectContent>{minuteOptions.map(at =>
          <SelectItem key={at} value={String(at)}>{digits(new Date(at).getMinutes())}</SelectItem>)}</SelectContent>
      </Select>
    </div>
  </div>
}

type TimeOptions = {
  value: SendTime | null
  quotaAt: number | null
  select: (time: SendTime) => void
}

function TimeOptions({ value, quotaAt, select }: TimeOptions) {
  const intl = useIntl()
  const [mode, setMode] = useState(value && 'at' in value ? 'date' : 'delay')
  const [minutes, setMinutes] = useState(String(value && 'minutes' in value ? value.minutes : 10))
  const now = Date.now()
  const minute = Math.floor(now / minuteMs)
  const [exact, setExact] = useState(() => value && 'at' in value && canScheduleAt(value.at, now)
    ? Math.max(minute + 1, Math.floor(value.at / minuteMs)) * minuteMs
    : (minute + 10) * minuteMs)
  const count = Number(minutes)
  const valid = mode === 'delay' ? /^\d+$/.test(minutes) && count >= 1 && count <= MAX_SEND_DELAY_MINUTES : canScheduleAt(exact, now)
  function apply() {
    if (valid && (mode === 'delay' || canScheduleAt(exact))) select(mode === 'delay' ? { minutes: count } : { at: exact })
  }
  const tabClass = 'text-xs focus-visible:outline-none focus-visible:border-tint/40 focus-visible:ring-1 focus-visible:ring-tint/25'
  return <>
    <div className="flex items-baseline justify-between">
      <span className="text-sm font-semibold">{intl.formatMessage(scheduleText.title)}</span>
      <span className="text-xs text-muted-foreground">{intl.formatMessage(scheduleText.limit)}</span>
    </div>
    <Button type="button" variant="ghost" disabled={!canScheduleAt(quotaAt, now)}
      onClick={() => quotaAt && canScheduleAt(quotaAt) && select({ at: quotaAt })}
      className="h-auto w-full justify-start gap-2.5 rounded-lg bg-muted/40 px-2.5 py-2 text-left">
      <RotateCcw className="size-3.5 text-muted-foreground"/>
      <span className="min-w-0 flex-1">
        <span className="block text-xs">{intl.formatMessage(scheduleText.quota)}</span>
        <span className="block text-xs font-normal text-muted-foreground">{canScheduleAt(quotaAt, now) ? displaySendTime(intl, quotaAt) : quotaAt && quotaAt > now ? intl.formatMessage(scheduleText.tooLate) : intl.formatMessage(scheduleText.unknown)}</span>
      </span>
      <kbd className="font-sans text-xs text-muted-foreground">{isMacPlatform() ? '⌘⌥↵' : 'Ctrl+Alt+↵'}</kbd>
    </Button>
    <Tabs value={mode} onValueChange={setMode} className="gap-2.5">
      <TabsList aria-label={intl.formatMessage(scheduleText.mode)} className="h-8 w-full">
        <TabsTrigger value="delay" className={tabClass}>{intl.formatMessage(scheduleText.delay)}</TabsTrigger>
        <TabsTrigger value="date" className={tabClass}>{intl.formatMessage(scheduleText.date)}</TabsTrigger>
      </TabsList>
      <TabsContent value="delay" className="space-y-2">
        <div className="flex gap-1.5">{[10, 30, 60].map(n =>
          <Button key={n} type="button" variant="ghost" size="xs" aria-pressed={count === n}
            className="flex-1 bg-muted/35 text-muted-foreground aria-pressed:bg-tint/10 aria-pressed:text-tint"
            onClick={() => setMinutes(String(n))}>{n === 60 ? intl.formatMessage(scheduleText.oneHour) : intl.formatMessage(scheduleText.preset, { count: n })}</Button>)}</div>
        <label className="relative block">
          <Input type="text" inputMode="numeric" aria-label={intl.formatMessage(scheduleText.minutesLabel)} value={minutes}
            onChange={e => setMinutes(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); apply() } }}
            className="pr-20 tabular-nums" />
          <span className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-xs text-muted-foreground">{intl.formatMessage(scheduleText.minutes)}</span>
        </label>
      </TabsContent>
      <TabsContent value="date">
        <ExactTimePicker minute={minute} exact={exact} change={setExact} />
      </TabsContent>
    </Tabs>
    <Button type="button" size="sm" variant="brand" disabled={!valid} className="w-full" onClick={apply}>{intl.formatMessage(scheduleText.apply)}</Button>
  </>
}

export function SchedulePicker({ value, open, setOpen, select, focusInput, quotaAt }: {
  value: SendTime | null; open: boolean; setOpen: (open: boolean) => void
  focusInput: () => void; select: (value: SendTime | null) => void; quotaAt: number | null
}) {
  const intl = useIntl()
  return <div className={cn('group/schedule relative inline-flex shrink-0 items-center text-xs', value && 'rounded-full bg-tint/10 text-tint')}>
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <PromptInputButton type="button" aria-label={intl.formatMessage(scheduleText.title)} title={intl.formatMessage(scheduleText.title)}
          size={value ? 'sm' : 'icon-sm'}
          className={value ? 'rounded-full bg-transparent text-inherit hover:bg-transparent hover:text-inherit' : 'rounded-lg text-muted-foreground data-[state=open]:bg-tint/10 data-[state=open]:text-tint'}>
          <Clock3 className="size-4" />{value && ('minutes' in value ? intl.formatMessage(scheduleText.inMinutes, { count: value.minutes }) : displaySendTime(intl, value.at))}
        </PromptInputButton>
      </PopoverTrigger>
      <PopoverContent aria-label={intl.formatMessage(scheduleText.title)} align="end" side="top" className="w-72 space-y-3"
        onCloseAutoFocus={e => { e.preventDefault(); focusInput() }}>
        <TimeOptions value={value} quotaAt={quotaAt} select={time => { select(time); setOpen(false) }} />
      </PopoverContent>
    </Popover>
    {value && <Button type="button" variant="ghost" size="icon-xs" aria-label={intl.formatMessage(scheduleText.clear)}
      className="absolute right-0 top-0 z-10 size-4 -translate-y-1/4 rounded-full bg-floating text-muted-foreground shadow-card hover:bg-floating hover:text-foreground pointer-events-none opacity-0 [@media(hover:none)]:pointer-events-auto [@media(hover:none)]:opacity-100 group-hover/schedule:pointer-events-auto group-hover/schedule:opacity-100 group-focus-within/schedule:pointer-events-auto group-focus-within/schedule:opacity-100 transition-opacity" onClick={() => { select(null); setOpen(false); focusInput() }}><X /></Button>}
  </div>
}
