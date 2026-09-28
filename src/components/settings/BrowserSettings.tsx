import { AppWindow, Chrome, ShieldCheck } from "lucide-react"
import { FormattedMessage } from "react-intl"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { BrowserUseSettings } from "./BrowserUseSettings"
import { ChromeUseSettings } from "./ChromeUseSettings"
import { BrowserPermissionsSettings } from "./BrowserPermissionsSettings"

export function BrowserSettings({ initialSurface = "built-in" }: { initialSurface?: "built-in" | "chrome" }) {
    return (
        <Tabs defaultValue={initialSurface} className="gap-6">
            <TabsList className="h-auto w-full flex-wrap justify-start gap-1 bg-muted/50 p-1 sm:w-fit">
                <TabsTrigger value="built-in" className="px-3 py-1.5">
                    <AppWindow />
                    <FormattedMessage id="settings.browser.surface.builtIn" defaultMessage="Built-in Browser" />
                </TabsTrigger>
                <TabsTrigger value="chrome" className="px-3 py-1.5">
                    <Chrome />
                    <FormattedMessage id="settings.browser.surface.chrome" defaultMessage="Chrome" />
                </TabsTrigger>
                <TabsTrigger value="permissions" className="px-3 py-1.5">
                    <ShieldCheck />
                    <FormattedMessage id="settings.browser.surface.permissions" defaultMessage="Permissions" />
                </TabsTrigger>
            </TabsList>
            <TabsContent value="built-in"><BrowserUseSettings /></TabsContent>
            <TabsContent value="chrome"><ChromeUseSettings /></TabsContent>
            <TabsContent value="permissions"><BrowserPermissionsSettings /></TabsContent>
        </Tabs>
    )
}
