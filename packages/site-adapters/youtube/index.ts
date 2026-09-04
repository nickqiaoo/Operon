/**
 * YouTube read commands — cookie + ytInitialData / innertube bootstrap.
 */

import { defineCommand } from "../define.ts"
import { parseVideoId } from "./utils.ts"

export const search = defineCommand({
  site: "youtube",
  name: "search",
  description: "Search YouTube videos",
  domain: "www.youtube.com",
  access: "read",
  strategy: "cookie",
  browser: true,
  args: [
    { name: "query", required: true, positional: true },
    { name: "limit", type: "int", default: 20 },
    { name: "type", default: "", help: "shorts | video | channel | playlist" },
    { name: "upload", default: "", help: "hour | today | week | month | year" },
    { name: "sort", default: "", help: "date | views | rating" },
  ],
  columns: ["rank", "title", "channel", "views", "duration", "published", "url"],
  func: async (page, kwargs) => {
    if (!page) throw new Error("youtube.search: browser required")
    const limit = Math.min(Number(kwargs.limit) || 20, 50)
    const query = encodeURIComponent(String(kwargs.query))
    const spMap: Record<string, string> = {
      shorts: "EgIQCQ%3D%3D",
      video: "EgIQAQ%3D%3D",
      channel: "EgIQAg%3D%3D",
      playlist: "EgIQAw%3D%3D",
      hour: "EgIIAQ%3D%3D",
      today: "EgIIAg%3D%3D",
      week: "EgIIAw%3D%3D",
      month: "EgIIBA%3D%3D",
      year: "EgIIBQ%3D%3D",
    }
    const sortMap: Record<string, string> = {
      date: "CAI%3D",
      views: "CAM%3D",
      rating: "CAE%3D",
    }
    let sp = ""
    const type = String(kwargs.type || "")
    const upload = String(kwargs.upload || "")
    const sort = String(kwargs.sort || "")
    if (type && spMap[type]) sp = spMap[type]!
    else if (upload && spMap[upload]) sp = spMap[upload]!
    else if (sort && sortMap[sort]) sp = sortMap[sort]!
    let url = `https://www.youtube.com/results?search_query=${query}`
    if (sp) url += `&sp=${sp}`
    await page.goto(url)
    await page.wait(3)
    const data = await page.evaluate(`
      (async () => {
        const data = window.ytInitialData;
        if (!data) return {error: 'YouTube data not found'};
        const contents = data.contents?.twoColumnSearchResultsRenderer?.primaryContents?.sectionListRenderer?.contents || [];
        const videos = [];
        const limit = ${limit};
        for (const section of contents) {
          const items = section.itemSectionRenderer?.contents || section.reelShelfRenderer?.items || [];
          for (const item of items) {
            if (videos.length >= limit) break;
            if (item.videoRenderer) {
              const v = item.videoRenderer;
              videos.push({
                rank: videos.length + 1,
                title: v.title?.runs?.[0]?.text || '',
                channel: v.ownerText?.runs?.[0]?.text || '',
                views: v.viewCountText?.simpleText || v.shortViewCountText?.simpleText || '',
                duration: v.lengthText?.simpleText || 'LIVE',
                published: v.publishedTimeText?.simpleText || '',
                url: 'https://www.youtube.com/watch?v=' + v.videoId
              });
            } else if (item.reelItemRenderer) {
              const r = item.reelItemRenderer;
              videos.push({
                rank: videos.length + 1,
                title: r.headline?.simpleText || '',
                channel: '',
                views: r.viewCountText?.simpleText || '',
                duration: 'SHORT',
                published: r.publishedTimeText?.simpleText || '',
                url: 'https://www.youtube.com/shorts/' + r.videoId
              });
            }
          }
        }
        return videos;
      })()
    `)
    if (!Array.isArray(data)) {
      if (data && typeof data === "object" && "error" in data) {
        throw new Error(`youtube.search: ${(data as { error: string }).error}`)
      }
      return []
    }
    return data
  },
})

export const feed = defineCommand({
  site: "youtube",
  name: "feed",
  description: "YouTube homepage recommended videos",
  domain: "www.youtube.com",
  access: "read",
  strategy: "cookie",
  browser: true,
  args: [{ name: "limit", type: "int", default: 20 }],
  columns: ["rank", "title", "channel", "video_id", "views", "duration", "published", "url"],
  func: async (page, kwargs) => {
    if (!page) throw new Error("youtube.feed: browser required")
    const limit = Math.min(Number(kwargs.limit) || 20, 100)
    await page.goto("https://www.youtube.com")
    await page.wait(3)
    const data = await page.evaluate(`
      (async () => {
        const d = window.ytInitialData;
        if (!d) return { error: 'YouTube data not found' };
        const limit = ${limit};
        const videos = [];
        const tabs = d.contents?.twoColumnBrowseResultsRenderer?.tabs || [];
        const contents = tabs[0]?.tabRenderer?.content?.richGridRenderer?.contents || [];
        for (const item of contents) {
          if (videos.length >= limit) break;
          const lvm = item.richItemRenderer?.content?.lockupViewModel;
          if (lvm && lvm.contentType === 'LOCKUP_CONTENT_TYPE_VIDEO') {
            const meta = lvm.metadata?.lockupMetadataViewModel;
            const rows = meta?.metadata?.contentMetadataViewModel?.metadataRows || [];
            const parts = rows.flatMap(r => (r.metadataParts || []).map(p => p.text?.content || '').filter(Boolean));
            let duration = '';
            for (const ov of (lvm.contentImage?.thumbnailViewModel?.overlays || [])) {
              for (const b of (ov.thumbnailBottomOverlayViewModel?.badges || [])) {
                if (b.thumbnailBadgeViewModel?.text) duration = b.thumbnailBadgeViewModel.text;
              }
            }
            videos.push({
              rank: videos.length + 1,
              title: meta?.title?.content || '',
              channel: parts[0] || '',
              video_id: lvm.contentId,
              views: parts[1] || '',
              duration,
              published: parts[2] || '',
              url: 'https://www.youtube.com/watch?v=' + lvm.contentId,
            });
            continue;
          }
          const v = item.richItemRenderer?.content?.videoRenderer || item.videoRenderer;
          if (v?.videoId) {
            videos.push({
              rank: videos.length + 1,
              title: v.title?.runs?.[0]?.text || '',
              channel: v.ownerText?.runs?.[0]?.text || '',
              video_id: v.videoId,
              views: v.viewCountText?.simpleText || v.shortViewCountText?.simpleText || '',
              duration: v.lengthText?.simpleText || '',
              published: v.publishedTimeText?.simpleText || '',
              url: 'https://www.youtube.com/watch?v=' + v.videoId,
            });
          }
        }
        return videos;
      })()
    `)
    if (!Array.isArray(data)) {
      if (data && typeof data === "object" && "error" in data) {
        throw new Error(`youtube.feed: ${(data as { error: string }).error}`)
      }
      return []
    }
    return data
  },
})

export const video = defineCommand({
  site: "youtube",
  name: "video",
  description: "Get YouTube video metadata",
  domain: "www.youtube.com",
  access: "read",
  strategy: "cookie",
  browser: true,
  args: [{ name: "url", required: true, positional: true, help: "Video URL or ID" }],
  columns: ["title", "channel", "views", "likes", "published", "description", "url"],
  func: async (page, kwargs) => {
    if (!page) throw new Error("youtube.video: browser required")
    const videoId = parseVideoId(kwargs.url)
    await page.goto(`https://www.youtube.com/watch?v=${videoId}`)
    await page.wait(3)
    const data = await page.evaluate(`
      (async () => {
        const player = window.ytInitialPlayerResponse;
        if (!player) return { error: 'ytInitialPlayerResponse missing' };
        const details = player.videoDetails || {};
        const micro = player.microformat?.playerMicroformatRenderer || {};
        let likes = '';
        try {
          const contents = window.ytInitialData?.contents?.twoColumnWatchNextResults?.results?.results?.contents || [];
          for (const c of contents) {
            const buttons = c.videoPrimaryInfoRenderer?.videoActions?.menuRenderer?.topLevelButtons;
            if (!buttons) continue;
            for (const b of buttons) {
              const toggle = b.segmentedLikeDislikeButtonViewModel
                ?.likeButtonViewModel?.likeButtonViewModel?.toggleButtonViewModel
                ?.toggleButtonViewModel?.defaultButtonViewModel?.buttonViewModel;
              if (toggle?.title) { likes = toggle.title; break; }
            }
          }
        } catch {}
        return {
          title: details.title || '',
          channel: details.author || '',
          views: details.viewCount || '',
          likes,
          published: micro.publishDate || micro.uploadDate || '',
          description: (details.shortDescription || '').slice(0, 500),
          url: 'https://www.youtube.com/watch?v=' + (details.videoId || ${JSON.stringify(videoId)}),
        };
      })()
    `)
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      throw new Error("youtube.video: failed to parse metadata")
    }
    if ("error" in data) throw new Error(`youtube.video: ${(data as { error: string }).error}`)
    return data
  },
})

export const comments = defineCommand({
  site: "youtube",
  name: "comments",
  description: "Get YouTube video comments (from page bootstrap when available)",
  domain: "www.youtube.com",
  access: "read",
  strategy: "cookie",
  browser: true,
  args: [
    { name: "url", required: true, positional: true },
    { name: "limit", type: "int", default: 20 },
  ],
  columns: ["rank", "author", "text", "likes", "time"],
  func: async (page, kwargs) => {
    if (!page) throw new Error("youtube.comments: browser required")
    const videoId = parseVideoId(kwargs.url)
    const limit = Math.min(Number(kwargs.limit) || 20, 100)
    await page.goto(`https://www.youtube.com/watch?v=${videoId}`)
    await page.wait(4)
    // Scroll to trigger comment load
    await page.evaluate(`window.scrollTo(0, 800)`)
    await page.wait(2)
    const data = await page.evaluate(`
      (async () => {
        const limit = ${limit};
        const cfg = window.ytcfg?.data_ || {};
        const apiKey = cfg.INNERTUBE_API_KEY;
        const context = cfg.INNERTUBE_CONTEXT;
        let continuationToken = null;
        if (window.ytInitialData) {
          const results = window.ytInitialData.contents?.twoColumnWatchNextResults?.results?.results?.contents || [];
          const commentSection = results.find(i => i.itemSectionRenderer?.targetId === 'comments-section'
            || i.itemSectionRenderer?.sectionIdentifier === 'comment-item-section');
          continuationToken = commentSection?.itemSectionRenderer?.contents?.[0]
            ?.continuationItemRenderer?.continuationEndpoint?.continuationCommand?.token;
        }
        const readRenderedComments = () => {
          const nodes = Array.from(document.querySelectorAll('ytd-comment-thread-renderer')).slice(0, limit);
          return nodes.map((n, i) => ({
            rank: i + 1,
            author: n.querySelector('#author-text')?.innerText?.trim() || '',
            text: n.querySelector('#content-text')?.innerText?.trim() || '',
            likes: n.querySelector('#vote-count-middle')?.innerText?.trim() || '0',
            time: n.querySelector('.published-time-text')?.innerText?.trim() || '',
          }));
        };
        if (!continuationToken || !apiKey || !context) return readRenderedComments();
        let resp;
        try {
          resp = await fetch('/youtubei/v1/next?key=' + apiKey + '&prettyPrint=false', {
            method: 'POST', credentials: 'include',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({ context, continuation: continuationToken })
          });
        } catch (e) {
          // The browser client evaluates this under a read-only guard that
          // rejects every non-GET fetch. The comments the page already
          // rendered are still readable, so take those instead of failing.
          return readRenderedComments();
        }
        if (!resp.ok) return readRenderedComments();
        const j = await resp.json();
        const muts = j.onResponseReceivedEndpoints || j.frameworkUpdates || [];
        const comments = [];
        const walk = (obj) => {
          if (!obj || typeof obj !== 'object') return;
          if (obj.commentEntityPayload || obj.commentRenderer) {
            const c = obj.commentRenderer || obj.commentEntityPayload?.properties;
            if (c) {
              comments.push({
                rank: comments.length + 1,
                author: c.authorText?.simpleText || c.author?.displayName || '',
                text: c.contentText?.runs?.map(r => r.text).join('') || c.content?.content || '',
                likes: c.voteCount?.simpleText || c.likeCountLikeButtonLabel || '0',
                time: c.publishedTimeText?.runs?.[0]?.text || '',
              });
            }
          }
          if (Array.isArray(obj)) obj.forEach(walk);
          else Object.values(obj).forEach(walk);
        };
        walk(j);
        return comments.slice(0, limit);
      })()
    `)
    if (!Array.isArray(data)) {
      if (data && typeof data === "object" && "error" in data) {
        throw new Error(`youtube.comments: ${(data as { error: string }).error}`)
      }
      return []
    }
    return data
  },
})
