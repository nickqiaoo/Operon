import { FormattedMessage } from "react-intl"
import { useNotificationStore } from "@/stores/notification-store"
import { Switch } from "@/components/ui/switch"
import { SettingsRow } from "./SettingsSection"

export function NotificationTab() {
    const enabled = useNotificationStore((s) => s.enabled)
    const notifyOnComplete = useNotificationStore((s) => s.notifyOnComplete)
    const notifyOnApproval = useNotificationStore((s) => s.notifyOnApproval)
    const setEnabled = useNotificationStore((s) => s.setEnabled)
    const setNotifyOnComplete = useNotificationStore((s) => s.setNotifyOnComplete)
    const setNotifyOnApproval = useNotificationStore((s) => s.setNotifyOnApproval)

    return (
        <div>
            <SettingsRow
                title={<span id="notify-enabled"><FormattedMessage id="settings.notif.system" defaultMessage="System notifications" /></span>}
                description={<FormattedMessage id="settings.notif.desc" defaultMessage="Show system notifications when the window is not focused" />}
                control={<Switch aria-labelledby="notify-enabled" checked={enabled} onCheckedChange={setEnabled} />}
            />
            {enabled && (
                <>
                    <SettingsRow
                        title={<span id="notify-onComplete"><FormattedMessage id="settings.notif.onComplete" defaultMessage="Notify on Response Complete" /></span>}
                        description={<FormattedMessage id="settings.notif.onCompleteDesc" defaultMessage="Get notified when the AI finishes its response" />}
                        control={<Switch aria-labelledby="notify-onComplete" checked={notifyOnComplete} onCheckedChange={setNotifyOnComplete} />}
                    />
                    <SettingsRow
                        title={<span id="notify-onApproval"><FormattedMessage id="settings.notif.onApproval" defaultMessage="Notify on Approval Required" /></span>}
                        description={<FormattedMessage id="settings.notif.onApprovalDesc" defaultMessage="Get notified when a tool needs your permission" />}
                        control={<Switch aria-labelledby="notify-onApproval" checked={notifyOnApproval} onCheckedChange={setNotifyOnApproval} />}
                    />
                </>
            )}
        </div>
    )
}
