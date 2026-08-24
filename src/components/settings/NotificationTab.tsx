import { FormattedMessage } from "react-intl"
import { useNotificationStore } from "@/stores/notification-store"
import { Switch } from "@/components/ui/switch"

export function NotificationTab() {
    const enabled = useNotificationStore((s) => s.enabled)
    const notifyOnComplete = useNotificationStore((s) => s.notifyOnComplete)
    const notifyOnApproval = useNotificationStore((s) => s.notifyOnApproval)
    const setEnabled = useNotificationStore((s) => s.setEnabled)
    const setNotifyOnComplete = useNotificationStore((s) => s.setNotifyOnComplete)
    const setNotifyOnApproval = useNotificationStore((s) => s.setNotifyOnApproval)

    return (
        <div className="space-y-8">
            <div className="flex items-center justify-between pb-8 border-b border-border/60">
                <div>
                    <div className="text-sm font-medium mb-1"><FormattedMessage id="settings.notif.title" defaultMessage="Notifications" /></div>
                    <div className="text-sm text-muted-foreground"><FormattedMessage id="settings.notif.desc" defaultMessage="Show system notifications when the window is not focused" /></div>
                </div>
                <Switch checked={enabled} onCheckedChange={setEnabled} />
            </div>

            {enabled && (
                <>
                    <div className="flex items-center justify-between pb-8 border-b border-border/60">
                        <div>
                            <div className="text-sm font-medium mb-1"><FormattedMessage id="settings.notif.onComplete" defaultMessage="Notify on Response Complete" /></div>
                            <div className="text-sm text-muted-foreground"><FormattedMessage id="settings.notif.onCompleteDesc" defaultMessage="Get notified when the AI finishes its response" /></div>
                        </div>
                        <Switch checked={notifyOnComplete} onCheckedChange={setNotifyOnComplete} />
                    </div>

                    <div className="flex items-center justify-between pb-8 border-b border-border/60">
                        <div>
                            <div className="text-sm font-medium mb-1"><FormattedMessage id="settings.notif.onApproval" defaultMessage="Notify on Approval Required" /></div>
                            <div className="text-sm text-muted-foreground"><FormattedMessage id="settings.notif.onApprovalDesc" defaultMessage="Get notified when a tool needs your permission" /></div>
                        </div>
                        <Switch checked={notifyOnApproval} onCheckedChange={setNotifyOnApproval} />
                    </div>
                </>
            )}
        </div>
    )
}
