# Mobile

## What is it

Operon for iOS and Android uses the same remote app as the browser. It connects to an agent running on your desktop through the hosted Broker, while end-to-end encryption keeps request and response content readable only by the paired device and that desktop.

Your desktop keeps an outbound connection to the Broker, so it does not need a public IP or an inbound port. The Broker routes encrypted traffic but does not hold the content-encryption keys.

## Connect your desktop

1. Open **Settings → Remote** in the desktop app.
2. Turn Remote on and complete sign-in.
3. Keep the desktop app running while you use a remote client.

The Remote card shows whether the machine is connected and the name that appears in the machine picker.

## Pair a device

1. Sign in on the iOS app, Android app, or web app and select your machine.
2. In the desktop app, open **Settings → Remote** and click **Pair device**.
3. Scan the QR code from the remote device. If you are using a browser on the same computer, click **Copy pairing code** on the desktop and paste it into the browser instead.
4. Confirm the device name and fingerprint, then click **Approve** on the desktop.

Pairing is required once per browser profile or native installation. Removing browser storage or reinstalling the app requires pairing again.

## End-to-end encryption

Remote API request and response bodies, AI streams, WebSocket messages, and attachment content are encrypted between the paired client and the desktop. Routing metadata needed to deliver traffic remains visible to the Broker. Release clients require encryption; the development-only switch exists for local debugging and is not exposed as a user setting.

Approved devices are listed under **Settings → Remote → End-to-end encryption**. Revoking a device removes its access immediately; pair it again to restore access.

## Troubleshooting

- **Machine is offline** — Open Operon on the desktop and confirm Remote shows **Connected**.
- **The browser cannot scan the QR code** — Use **Copy pairing code**, then paste it into the pairing form.
- **Waiting for approval** — Return to the desktop and approve the pending device before the code expires.
- **Pairing is requested again** — The local pairing key may have been removed or revoked. Generate a new code and pair again.
