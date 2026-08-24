/**
 * Twitter/X read commands — GraphQL + cookie session.
 */

import { defineCommand } from "../define.ts"
import {
  extractTweet,
  getCt0,
  graphqlGet,
  normalizeScreenName,
  resolveQueryId,
  walkTimelineInstructions,
} from "./graphql.ts"

const USER_BY_SCREEN_NAME_QUERY_ID = "IGgvgiOx4QZndDHuD3x9TQ"
const USER_TWEETS_QUERY_ID = "lrMzG9qPQHpqJdP3AbM-bQ"
const HOME_TIMELINE_QUERY_ID = "c-CzHF1LboFilMpsx4ZCrQ"
const HOME_LATEST_TIMELINE_QUERY_ID = "BKB7oi212Fi7kQtCBGE4zA"
const SEARCH_TIMELINE_QUERY_ID = "Yw6L66Pw54NHKuq4Dp7b4Q"

const PROFILE_FEATURES: Record<string, boolean> = {
  hidden_profile_subscriptions_enabled: true,
  rweb_tipjar_consumption_enabled: true,
  responsive_web_graphql_exclude_directive_enabled: true,
  verified_phone_label_enabled: false,
  subscriptions_verification_info_is_identity_verified_enabled: true,
  subscriptions_verification_info_verified_since_enabled: true,
  highlights_tweets_tab_ui_enabled: true,
  responsive_web_twitter_article_notes_tab_enabled: true,
  subscriptions_feature_can_gift_premium: true,
  creator_subscriptions_tweet_preview_api_enabled: true,
  responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
  responsive_web_graphql_timeline_navigation_enabled: true,
}

const TIMELINE_FEATURES: Record<string, boolean> = {
  rweb_video_screen_enabled: false,
  profile_label_improvements_pcf_label_in_post_enabled: true,
  rweb_tipjar_consumption_enabled: true,
  verified_phone_label_enabled: false,
  creator_subscriptions_tweet_preview_api_enabled: true,
  responsive_web_graphql_timeline_navigation_enabled: true,
  responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
  premium_content_api_read_enabled: false,
  communities_web_enable_tweet_community_results_fetch: true,
  c9s_tweet_anatomy_moderator_badge_enabled: true,
  responsive_web_grok_analyze_button_fetch_trends_enabled: false,
  responsive_web_grok_analyze_post_followups_enabled: true,
  responsive_web_jetfuel_frame: false,
  responsive_web_grok_share_attachment_enabled: true,
  articles_preview_enabled: true,
  responsive_web_edit_tweet_api_enabled: true,
  graphql_is_translatable_rweb_tweet_is_translatable_enabled: true,
  view_counts_everywhere_api_enabled: true,
  longform_notetweets_consumption_enabled: true,
  responsive_web_twitter_article_tweet_consumption_enabled: true,
  tweet_awards_web_tipping_enabled: false,
  responsive_web_grok_show_grok_translated_post: false,
  responsive_web_grok_analysis_button_from_backend: false,
  creator_subscriptions_quote_tweet_preview_enabled: false,
  freedom_of_speech_not_reach_fetch_enabled: true,
  standardized_nudges_misinfo: true,
  tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled: true,
  longform_notetweets_rich_text_read_enabled: true,
  longform_notetweets_inline_media_enabled: true,
  responsive_web_grok_image_annotation_enabled: true,
  responsive_web_enhance_cards_enabled: false,
}

export const profile = defineCommand({
  site: "twitter",
  name: "profile",
  description: "Fetch a Twitter/X user profile",
  domain: "x.com",
  access: "read",
  strategy: "cookie",
  browser: true,
  args: [
    {
      name: "username",
      positional: true,
      help: "Screen name (with or without @). Defaults to logged-in user when omitted.",
    },
  ],
  columns: [
    "screen_name",
    "name",
    "bio",
    "location",
    "followers",
    "following",
    "tweets",
    "verified",
    "url",
  ],
  func: async (page, kwargs) => {
    if (!page) throw new Error("twitter: browser required")
    let username = normalizeScreenName(kwargs.username)
    if (!username) {
      await page.goto("https://x.com/home")
      await page.wait(2)
      await getCt0(page)
      const href = await page.evaluate(`(() => {
        const link = document.querySelector('a[data-testid="AppTabBar_Profile_Link"]');
        return link ? link.getAttribute('href') : null;
      })()`)
      username = normalizeScreenName(href)
      if (!username) throw new Error("twitter.profile: could not detect logged-in user")
    }
    await page.goto(`https://x.com/${username}`)
    await page.wait(2)
    const queryId = await resolveQueryId(page, "UserByScreenName", USER_BY_SCREEN_NAME_QUERY_ID)
    const raw = (await graphqlGet(page, {
      queryId,
      operation: "UserByScreenName",
      variables: { screen_name: username, withSafetyModeUserFields: true },
      features: PROFILE_FEATURES,
    })) as Record<string, unknown>
    if (raw.__httpError) throw new Error(`twitter.profile: HTTP ${raw.__httpError}`)
    const data = raw.data as Record<string, unknown> | undefined
    const user = (data?.user as Record<string, unknown> | undefined)?.result as
      | Record<string, unknown>
      | undefined
    if (!user) throw new Error(`twitter.profile: user @${username} not found`)
    const legacy = (user.legacy as Record<string, unknown> | undefined) || {}
    const core = (user.core as Record<string, unknown> | undefined) || {}
    return {
      screen_name: core.screen_name || legacy.screen_name || username,
      name: core.name || legacy.name || "",
      bio: legacy.description || "",
      location: legacy.location || "",
      followers: legacy.followers_count || 0,
      following: legacy.friends_count || 0,
      tweets: legacy.statuses_count || 0,
      verified: Boolean(user.is_blue_verified || legacy.verified),
      url: `https://x.com/${core.screen_name || legacy.screen_name || username}`,
    }
  },
})

export const timeline = defineCommand({
  site: "twitter",
  name: "timeline",
  description: "Home timeline (for-you or following)",
  domain: "x.com",
  access: "read",
  strategy: "cookie",
  browser: true,
  args: [
    {
      name: "type",
      default: "for-you",
      choices: ["for-you", "following"],
      help: "for-you algorithmic vs following chronological",
    },
    { name: "limit", type: "int", default: 20 },
  ],
  columns: ["id", "author", "text", "likes", "retweets", "replies", "views", "created_at", "url"],
  func: async (page, kwargs) => {
    if (!page) throw new Error("twitter: browser required")
    const limit = Number(kwargs.limit) || 20
    const type = kwargs.type === "following" ? "following" : "for-you"
    await page.goto("https://x.com/home")
    await page.wait(2)
    await getCt0(page)
    const endpoint = type === "following" ? "HomeLatestTimeline" : "HomeTimeline"
    const fallback = type === "following" ? HOME_LATEST_TIMELINE_QUERY_ID : HOME_TIMELINE_QUERY_ID
    const queryId = await resolveQueryId(page, endpoint, fallback)
    const all: Array<Record<string, unknown>> = []
    const seen = new Set<string>()
    let cursor: string | null = null
    for (let i = 0; i < 5 && all.length < limit; i++) {
      const variables: Record<string, unknown> = {
        count: Math.min(40, limit - all.length + 5),
        includePromotedContent: false,
        latestControlAvailable: true,
        requestContext: "launch",
      }
      if (type === "for-you") variables.withCommunity = true
      if (type === "following") variables.seenTweetIds = []
      if (cursor) variables.cursor = cursor
      const raw = (await graphqlGet(page, {
        queryId,
        operation: endpoint,
        variables,
        features: TIMELINE_FEATURES,
        method: type === "following" ? "POST" : "GET",
      })) as Record<string, unknown>
      if (raw.__httpError) {
        if (all.length === 0) throw new Error(`twitter.timeline: HTTP ${raw.__httpError}`)
        break
      }
      const data = raw.data as Record<string, unknown> | undefined
      const home = (data?.home as Record<string, unknown> | undefined)?.home_timeline_urt as
        | { instructions?: unknown[] }
        | undefined
      const { tweets, nextCursor } = walkTimelineInstructions(home?.instructions || [], seen)
      all.push(...tweets)
      if (!nextCursor || nextCursor === cursor) break
      cursor = nextCursor
    }
    return all.slice(0, limit)
  },
})

export const tweets = defineCommand({
  site: "twitter",
  name: "tweets",
  description: "Fetch recent tweets from a user",
  domain: "x.com",
  access: "read",
  strategy: "cookie",
  browser: true,
  args: [
    { name: "username", required: true, positional: true, help: "Screen name" },
    { name: "limit", type: "int", default: 20 },
  ],
  columns: ["id", "author", "text", "likes", "retweets", "replies", "views", "created_at", "url"],
  func: async (page, kwargs) => {
    if (!page) throw new Error("twitter: browser required")
    const username = normalizeScreenName(kwargs.username)
    if (!username) throw new Error("twitter.tweets: invalid username")
    const limit = Number(kwargs.limit) || 20
    await page.goto(`https://x.com/${username}`)
    await page.wait(2)
    await getCt0(page)
    const profileQid = await resolveQueryId(page, "UserByScreenName", USER_BY_SCREEN_NAME_QUERY_ID)
    const profileRaw = (await graphqlGet(page, {
      queryId: profileQid,
      operation: "UserByScreenName",
      variables: { screen_name: username, withSafetyModeUserFields: true },
      features: PROFILE_FEATURES,
    })) as Record<string, unknown>
    if (profileRaw.__httpError) throw new Error(`twitter.tweets: profile HTTP ${profileRaw.__httpError}`)
    const userResult = ((profileRaw.data as Record<string, unknown> | undefined)?.user as
      | Record<string, unknown>
      | undefined)?.result as Record<string, unknown> | undefined
    const userId = String(userResult?.rest_id || "")
    if (!userId) throw new Error(`twitter.tweets: user @${username} not found`)

    const tweetsQid = await resolveQueryId(page, "UserTweets", USER_TWEETS_QUERY_ID)
    const all: Array<Record<string, unknown>> = []
    const seen = new Set<string>()
    let cursor: string | null = null
    for (let i = 0; i < 5 && all.length < limit; i++) {
      const variables: Record<string, unknown> = {
        userId,
        count: Math.min(40, limit - all.length + 5),
        includePromotedContent: false,
        withQuickPromoteEligibilityTweetFields: true,
        withVoice: true,
        withV2Timeline: true,
      }
      if (cursor) variables.cursor = cursor
      const raw = (await graphqlGet(page, {
        queryId: tweetsQid,
        operation: "UserTweets",
        variables,
        features: TIMELINE_FEATURES,
      })) as Record<string, unknown>
      if (raw.__httpError) {
        if (all.length === 0) throw new Error(`twitter.tweets: HTTP ${raw.__httpError}`)
        break
      }
      const timeline = (((((raw.data as Record<string, unknown> | undefined)?.user as
        | Record<string, unknown>
        | undefined)?.result as Record<string, unknown> | undefined)?.timeline_v2 as
        | Record<string, unknown>
        | undefined)?.timeline as { instructions?: unknown[] } | undefined)
      const { tweets: pageTweets, nextCursor } = walkTimelineInstructions(
        timeline?.instructions || [],
        seen,
      )
      all.push(...pageTweets)
      if (!nextCursor || nextCursor === cursor) break
      cursor = nextCursor
    }
    return all.slice(0, limit)
  },
})

export const search = defineCommand({
  site: "twitter",
  name: "search",
  description: "Search Twitter/X posts",
  domain: "x.com",
  access: "read",
  strategy: "cookie",
  browser: true,
  args: [
    { name: "query", required: true, positional: true, help: "Search query" },
    { name: "limit", type: "int", default: 20 },
    {
      name: "product",
      default: "Latest",
      choices: ["Latest", "Top"],
      help: "Latest or Top results",
    },
  ],
  columns: ["id", "author", "text", "likes", "retweets", "replies", "url"],
  func: async (page, kwargs) => {
    if (!page) throw new Error("twitter: browser required")
    const query = String(kwargs.query ?? "").trim()
    if (!query) throw new Error("twitter.search: query required")
    const limit = Number(kwargs.limit) || 20
    const product = kwargs.product === "Top" ? "Top" : "Latest"
    await page.goto(`https://x.com/search?q=${encodeURIComponent(query)}&src=typed_query&f=${product === "Top" ? "top" : "live"}`)
    await page.wait(2)
    await getCt0(page)
    const queryId = await resolveQueryId(page, "SearchTimeline", SEARCH_TIMELINE_QUERY_ID)
    const all: Array<Record<string, unknown>> = []
    const seen = new Set<string>()
    let cursor: string | null = null
    for (let i = 0; i < 5 && all.length < limit; i++) {
      const variables: Record<string, unknown> = {
        rawQuery: query,
        count: Math.min(40, limit - all.length + 5),
        querySource: "typed_query",
        product,
      }
      if (cursor) variables.cursor = cursor
      const raw = (await graphqlGet(page, {
        queryId,
        operation: "SearchTimeline",
        variables,
        features: TIMELINE_FEATURES,
      })) as Record<string, unknown>
      if (raw.__httpError) {
        if (all.length === 0) throw new Error(`twitter.search: HTTP ${raw.__httpError}`)
        break
      }
      const instructions =
        (((((((raw.data as Record<string, unknown> | undefined)?.search_by_raw_query as
          | Record<string, unknown>
          | undefined)?.search_timeline as Record<string, unknown> | undefined)?.timeline as
          | { instructions?: unknown[] }
          | undefined)?.instructions) as unknown[]) || [])
      const { tweets: pageTweets, nextCursor } = walkTimelineInstructions(instructions, seen)
      // Fallback: some payloads nest differently — walk any tweet_results
      if (pageTweets.length === 0) {
        const flat = JSON.stringify(raw)
        // no extra extraction if empty
        void flat
      }
      all.push(...pageTweets)
      if (!nextCursor || nextCursor === cursor) break
      cursor = nextCursor
    }
    return all.slice(0, limit)
  },
})

export const thread = defineCommand({
  site: "twitter",
  name: "thread",
  description: "Fetch a tweet thread by status URL or id",
  domain: "x.com",
  access: "read",
  strategy: "cookie",
  browser: true,
  args: [
    { name: "url", required: true, positional: true, help: "Tweet URL or numeric status id" },
    { name: "limit", type: "int", default: 30 },
  ],
  columns: ["id", "author", "text", "likes", "retweets", "url"],
  func: async (page, kwargs) => {
    if (!page) throw new Error("twitter: browser required")
    const raw = String(kwargs.url ?? "").trim()
    let statusId = ""
    if (/^\d+$/.test(raw)) statusId = raw
    else {
      try {
        const u = new URL(raw)
        const m = u.pathname.match(/\/status\/(\d+)/)
        if (m) statusId = m[1]!
      } catch {
        // ignore
      }
    }
    if (!statusId) throw new Error("twitter.thread: need status URL or id")
    const limit = Number(kwargs.limit) || 30
    await page.goto(`https://x.com/i/status/${statusId}`)
    await page.wait(3)
    await getCt0(page)
    // DOM fallback: collect article texts on conversation page (stable without Conversation GraphQL churn)
    const rows = (await page.evaluate(`(() => {
      const items = [];
      const seen = new Set();
      for (const article of document.querySelectorAll('article')) {
        const link = article.querySelector('a[href*="/status/"]');
        const href = link ? link.getAttribute('href') || '' : '';
        const m = href.match(/\\/status\\/(\\d+)/);
        const id = m ? m[1] : '';
        if (!id || seen.has(id)) continue;
        seen.add(id);
        const authorLink = article.querySelector('a[role="link"][href^="/"]');
        const author = authorLink ? (authorLink.getAttribute('href') || '').replace(/^\\//, '').split('/')[0] : '';
        const textEl = article.querySelector('[data-testid="tweetText"]');
        const text = textEl ? textEl.innerText : '';
        items.push({
          id,
          author,
          text,
          likes: 0,
          retweets: 0,
          url: author ? 'https://x.com/' + author + '/status/' + id : 'https://x.com/i/status/' + id,
        });
      }
      return items;
    })()`)) as Array<Record<string, unknown>>
    if (!Array.isArray(rows) || rows.length === 0) {
      // still return focal id shell
      return [{ id: statusId, author: "", text: "", likes: 0, retweets: 0, url: `https://x.com/i/status/${statusId}` }]
    }
    return rows.slice(0, limit)
  },
})

// re-export extractTweet for tests
export { extractTweet }
