

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

export interface PostRow {
  rank: number
  id: string | undefined
  title: string | undefined
  subreddit: string | undefined
  score: number | undefined
  comments: number | undefined
  author: string | undefined
  url: string
  created_utc: number | undefined
  selftext: string
  post_hint: string
  url_overridden_by_dest: string
  preview_image_url: string
  gallery_urls: string[]
}

export function toPostRow(item: Record<string, unknown>): Omit<PostRow, "rank"> {
  return {
    id: item.id as string | undefined,
    title: item.title as string | undefined,
    subreddit: item.subreddit as string | undefined,
    score: item.score as number | undefined,
    comments: item.comments as number | undefined,
    author: item.author as string | undefined,
    url: item.url as string,
    created_utc: item.created_utc as number | undefined,
    selftext: item.selftext as string,
    post_hint: item.post_hint as string,
    url_overridden_by_dest: item.url_overridden_by_dest as string,
    preview_image_url: item.preview_image_url as string,
    gallery_urls: item.gallery_urls as string[],
  }
}
