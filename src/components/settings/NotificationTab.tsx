import { FormattedMessage } from "react-intl"
import { Bell } from "lucide-react"
import { useNotificationStore } from "@/stores/notification-store"
import { Switch } from "@/components/ui/switch"
import { SettingsRow, SettingsSection } from "./SettingsSection"

export function NotificationTab() {
    const enabled = useNotificationStore((s) => s.enabled)
    const notifyOnComplete = useNotificationStore((s) => s.notifyOnComplete)
    const notifyOnApproval = useNotificationStore((s) => s.notifyOnApproval)
    const setEnabled = useNotificationStore((s) => s.setEnabled)
    const setNotifyOnComplete = useNotificationStore((s) => s.setNotifyOnComplete)
    const setNotifyOnApproval = useNotificationStore((s) => s.setNotifyOnApproval)

    return (
        <SettingsSection
            icon={Bell}
            title={<FormattedMessage id="settings.notif.title" defaultMessage="Notifications" />}
            description={<FormattedMessage id="settings.notif.desc" defaultMessage="Show system notifications when the window is not focused" />}
            action={<Switch checked={enabled} onCheckedChange={setEnabled} />}
        >
            {enabled && (
                <div>
                    <SettingsRow
                        title={<FormattedMessage id="settings.notif.onComplete" defaultMessage="Notify on Response Complete" />}
                        description={<FormattedMessage id="settings.notif.onCompleteDesc" defaultMessage="Get notified when the AI finishes its response" />}
                        control={<Switch checked={notifyOnComplete} onCheckedChange={setNotifyOnComplete} />}
                    />
                    <SettingsRow
                        title={<FormattedMessage id="settings.notif.onApproval" defaultMessage="Notify on Approval Required" />}
                        description={<FormattedMessage id="settings.notif.onApprovalDesc" defaultMessage="Get notified when a tool needs your permission" />}
                        control={<Switch checked={notifyOnApproval} onCheckedChange={setNotifyOnApproval} />}
                    />
                </div>
            )}
        </SettingsSection>
    )
}
