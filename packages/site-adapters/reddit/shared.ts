/** Shared JS snippets inlined into Reddit page.evaluate sources. */

export const REDDIT_MEDIA_HELPERS = `
  function decodeHtml(s) {
    if (typeof s !== 'string' || !s) return '';
    return s
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#x27;/gi, "'")
      .replace(/&#39;/g, "'");
  }
  function extractRedditMedia(d) {
    const post_hint = d?.post_hint || '';
    const url_overridden_by_dest = d?.url_overridden_by_dest || '';
    const preview_image_url = decodeHtml(d?.preview?.images?.[0]?.source?.url || '');
    const gallery_urls = [];
    const items = d?.gallery_data?.items;
    const meta = d?.media_metadata;
    if (Array.isArray(items) && meta) {
      for (const it of items) {
        const m = it && meta[it.media_id];
        const u = m?.s?.u;
        if (u) gallery_urls.push(decodeHtml(u));
      }
    }
    return { post_hint, url_overridden_by_dest, preview_image_url, gallery_urls };
  }
`

export const POST_COLUMNS = [
  "rank",
  "id",
  "title",
  "subreddit",
  "score",
  "comments",
  "author",
  "url",
  "created_utc",
  "selftext",
  "post_hint",
  "url_overridden_by_dest",
  "preview_image_url",
  "gallery_urls",
] as const

export const POST_MAP = {
  rank: "${{ index + 1 }}",
  id: "${{ item.id }}",
  title: "${{ item.title }}",
  subreddit: "${{ item.subreddit }}",
  score: "${{ item.score }}",
  comments: "${{ item.comments }}",
  author: "${{ item.author }}",
  url: "${{ item.url }}",
  created_utc: "${{ item.created_utc }}",
  selftext: "${{ item.selftext }}",
  post_hint: "${{ item.post_hint }}",
  url_overridden_by_dest: "${{ item.url_overridden_by_dest }}",
  preview_image_url: "${{ item.preview_image_url }}",
  gallery_urls: "${{ item.gallery_urls }}",
} as const
