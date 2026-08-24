# Remote Web Access

## What is it

Remote Web Access lets you drive the agents running on your desktop from a browser, iPhone, or Android device. Chats, tasks, files, terminal sessions, and git review still run against the repositories and tools on your own machine.

Your machine never opens an inbound port. It keeps an outbound connection to Operon's Broker, which routes remote requests back to the selected machine. Request and response content is end-to-end encrypted between each approved client and the desktop.

## Connecting

1. Open **Settings → Remote** in the desktop app.
2. Turn Remote on and complete sign-in.
3. Open the web or mobile app, sign in, and select the machine.
4. Complete the one-time secure pairing shown by the client.

For pairing instructions, including how to paste a code when you cannot scan the QR, see [Mobile](mobile).

## What works remotely

Chat, tasks, channels, files, terminal sessions, and git review work through the Broker, including streaming responses and stopping a running turn.

Some settings that control local desktop hardware are hidden in remote builds, including the in-app Browser, Computer Use, Chrome control, desktop logs, and the Remote settings page itself.

## Disconnecting

Turn Remote off on the desktop. The machine is removed from the Broker and remote clients can no longer reach it. Local conversations, tasks, and repositories remain unchanged.
