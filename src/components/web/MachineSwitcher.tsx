import { createContext } from 'react'
import { LogOut, Monitor, RefreshCw } from 'lucide-react'
import { useIntl } from 'react-intl'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'

interface MachineActions {
  label: string
  onSwitch: () => void
  onSignOut: () => void
}

export const MachineActionsContext = createContext<MachineActions | null>(null)

export function MachineSwitcher({ machine }: { machine: MachineActions }) {
  const intl = useIntl()
  const { label, onSwitch, onSignOut } = machine

  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          data-testid="machine-switcher"
          aria-label={intl.formatMessage({ id: 'web.auth.currentMachine', defaultMessage: 'Current machine: {name}' }, { name: label })}
          title={label}
          className="mx-auto mt-1 flex size-11 shrink-0 items-center justify-center rounded-xl border-4 border-transparent bg-clip-padding text-foreground/85 outline-none transition-colors hover:bg-row-hover focus-visible:ring-2 focus-visible:ring-ring/50 data-[state=open]:bg-row-hover"
        >
          <Monitor className="size-5 shrink-0" aria-hidden />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        side="right"
        align="end"
        collisionPadding={12}
        className="w-64 max-w-[var(--radix-dropdown-menu-content-available-width)]"
      >
        <DropdownMenuLabel className="[overflow-wrap:anywhere]">
          <span className="mb-0.5 block text-xs font-normal text-muted-foreground">
            {intl.formatMessage({ id: 'web.auth.machineMenu.title', defaultMessage: 'Current machine' })}
          </span>
          <span className="block">{label}</span>
        </DropdownMenuLabel>
        <DropdownMenuItem className="[@media(pointer:coarse)]:min-h-11" onSelect={onSwitch}>
          <RefreshCw />
          {intl.formatMessage({ id: 'web.auth.switchMachine', defaultMessage: 'Switch machine' })}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem className="[@media(pointer:coarse)]:min-h-11" onSelect={onSignOut}>
          <LogOut />
          {intl.formatMessage({ id: 'web.auth.signOut', defaultMessage: 'Sign out' })}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
