import { usePwaUpdate } from "@/hooks/usePwaUpdate"
import { PwaUpdatePrompt } from "@/components/web/PwaUpdatePrompt"

export function PwaUpdateManager() {
  const pwaUpdate = usePwaUpdate()

  if (__APP_TARGET__ !== "web") return null

  return (
    <PwaUpdatePrompt
      updateAvailable={pwaUpdate.updateAvailable}
      onRefresh={pwaUpdate.refresh}
      onDismiss={pwaUpdate.dismiss}
    />
  )
}
