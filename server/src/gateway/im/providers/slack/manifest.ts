// Slack App manifest generator for Quick Setup.
// Produces a manifest JSON suitable for POST apps.manifest.create.
// Mirrors the scopes / events / interactivity that SlackProvider actually uses.

export interface SlackManifestInput {
  /** Bot display name shown in Slack. Max 35 chars. */
  displayName: string
  /** Optional longer description shown in App Directory / settings. */
  description?: string
}

export interface SlackAppManifest {
  display_information: {
    name: string
    description?: string
    background_color?: string
  }
  features: {
    app_home: {
      home_tab_enabled: boolean
      messages_tab_enabled: boolean
      messages_tab_read_only_enabled: boolean
    }
    bot_user: {
      display_name: string
      always_online: boolean
    }
  }
  oauth_config: {
    scopes: {
      bot: string[]
    }
  }
  settings: {
    event_subscriptions: {
      bot_events: string[]
    }
    interactivity: {
      is_enabled: boolean
    }
    org_deploy_enabled: boolean
    socket_mode_enabled: boolean
    token_rotation_enabled: boolean
  }
}

const BOT_SCOPES = [
  'app_mentions:read',
  'channels:history',
  'channels:read',
  'chat:write',
  'files:read',
  'groups:history',
  'groups:read',
  'im:history',
  'im:read',
  'mpim:history',
  'mpim:read',
  'reactions:write',
  'users:read',
]

const BOT_EVENTS = [
  'app_mention',
  'message.channels',
  'message.groups',
  'message.im',
  'message.mpim',
]

const MAX_NAME_LEN = 35

function clampName(name: string): string {
  const trimmed = name.trim() || 'Operon Bot'
  return trimmed.length > MAX_NAME_LEN ? trimmed.slice(0, MAX_NAME_LEN) : trimmed
}

export function buildSlackManifest(input: SlackManifestInput): SlackAppManifest {
  const name = clampName(input.displayName)
  return {
    display_information: {
      name,
      description: input.description?.slice(0, 140),
    },
    features: {
      // Slack defaults messages_tab_read_only_enabled to true, which shows
      // "Sending messages to this app has been turned off" in the bot's DM.
      // We subscribe to message.im, so the tab has to be writable.
      app_home: {
        home_tab_enabled: false,
        messages_tab_enabled: true,
        messages_tab_read_only_enabled: false,
      },
      bot_user: {
        display_name: name,
        always_online: true,
      },
    },
    oauth_config: {
      scopes: {
        bot: BOT_SCOPES,
      },
    },
    settings: {
      event_subscriptions: {
        bot_events: BOT_EVENTS,
      },
      interactivity: {
        is_enabled: true,
      },
      org_deploy_enabled: false,
      socket_mode_enabled: true,
      token_rotation_enabled: false,
    },
  }
}
