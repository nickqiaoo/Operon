export const GUIDE = `# Xiaohongshu guide

## Which function for which task
- Read a note caption and video transcript → xiaohongshu.getNote({ url }).
- Save requested images or video files → xiaohongshu.downloadMedia({ note }).
- Find notes → xiaohongshu.search({ query, browser }).
- Read comments and optional replies → xiaohongshu.getComments({ url, browser }).
- Read an author's notes → xiaohongshu.userNotes({ user, browser }).
- Read the home feed → xiaohongshu.feed({ browser }).

## Inputs
- Note URLs need xsec_token; use the user's shared link or the url from
  search, userNotes or feed. xhslink.com short links also work.
- userNotes accepts a user id or profile URL.
- subtitles accepts source (default), a language code such as en-US, or none.
- search sort: general, latest, mostLiked, mostCommented or mostCollected.
- search noteType: all, video or image; publishTime: any, day, week or halfYear.

## Needs
getNote fetches the mobile note page directly on the host; Chrome is not needed.
Passing browser enables a Chrome fallback when the direct read fails.
downloadMedia uses the returned note and does not need Chrome.
search, getComments, userNotes and feed need browser: globalThis.chrome and
a Chrome login on www.xiaohongshu.com.

## Pitfalls
- text is the author's caption; subtitles.text is what is said in the video.
- Image notes have subtitles: null. Subtitle tracks may be unavailable.
- Subtitle results include language, source/translation kind, text and cues.
- getNote also returns subtitleTracks, media, source, timings and warnings.
- Downloads are a separate call and only appropriate when the user wants files.
- If downloadMedia returns complete: false, call it again with the same note;
  completed files are skipped and partial downloads can resume.
- Read only notes needed for the task. Do not loop over a whole search list.
- On SECURITY_BLOCK, stop and tell the user to wait; do not retry.

## Recipes
\`\`\`js
const note = await siteAdapters.xiaohongshu.getNote({ url });
nodeRepl.write({ caption: note.text, transcript: note.subtitles?.text });
// Only when the user asks to save files:
const saved = await siteAdapters.xiaohongshu.downloadMedia({ note, types: "video" });
if (!saved.complete) {
  const resumed = await siteAdapters.xiaohongshu.downloadMedia({ note, types: "video" });
  nodeRepl.write(resumed);
}
\`\`\`

\`\`\`js
const browser = globalThis.chrome;
const notes = await siteAdapters.xiaohongshu.search({ query: "camping gear", limit: 5, browser });
// Select only a note relevant to the task; keep the returned signed URL.
const note = await siteAdapters.xiaohongshu.getNote({ url: notes[0].url, subtitles: "en-US", browser });
nodeRepl.write(note.subtitles);
\`\`\`

Use siteAdapters.help("xiaohongshu.getNote") for exact defaults and options.
`
