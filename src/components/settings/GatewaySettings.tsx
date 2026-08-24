import { IMPlatformSettings } from "./IMPlatformSettings"
import { DiffPreviewSettings } from "./DiffPreviewSettings"
import { AgentSettings } from "./AgentSettings"

export function GatewaySettings() {
    return (
        <div className="space-y-6">
            <AgentSettings />
            <IMPlatformSettings />
            <DiffPreviewSettings />
        </div>
    )
}
