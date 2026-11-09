import { describe, expect, it } from "vitest"
import { extractLocalImagePaths, linkLocalMarkdownImages } from "./reply-images"

describe("extractLocalImagePaths", () => {
  it("finds paths that take up a whole list item", () => {
    expect(extractLocalImagePaths("Screenshots:\n\n- /tmp/a/1-card.png\n- /tmp/a/3-dispatched.png\n")).toEqual([
      "/tmp/a/1-card.png",
      "/tmp/a/3-dispatched.png",
    ])
  })

  it("keeps a whole-line path with spaces together", () => {
    expect(extractLocalImagePaths("1. /Users/me/My Shots/final shot.jpeg")).toEqual(["/Users/me/My Shots/final shot.jpeg"])
  })

  it("finds paths in a sentence, including against CJK text and punctuation", () => {
    expect(extractLocalImagePaths("截图在/tmp/截图/a.png，另一张是 /tmp/b.webp。See (/tmp/c.gif).")).toEqual([
      "/tmp/截图/a.png",
      "/tmp/b.webp",
      "/tmp/c.gif",
    ])
  })

  it("reads every way of writing a path, in reading order", () => {
    const text = "[shot](/tmp/b%20c.png) then `/tmp/a.png` then ![x](</tmp/d e.png>) then 【F:/tmp/f.jpg†L1】"
    expect(extractLocalImagePaths(text)).toEqual(["/tmp/b c.png", "/tmp/a.png", "/tmp/d e.png", "/tmp/f.jpg"])
  })

  it("removes duplicates", () => {
    expect(extractLocalImagePaths("/tmp/a.png\n\nagain: /tmp/a.png")).toEqual(["/tmp/a.png"])
  })

  it.each([
    ["a fenced block", "```bash\nopen /tmp/a.png\n```"],
    ["an unterminated fence", "~~~\n/tmp/a.png"],
    ["a command in inline code", "Run `open /tmp/a.png` now"],
    ["a URL", "https://example.com/a/b.png and [x](https://example.com/c.png)"],
    ["a protocol-relative URL", "![x](//cdn.example.com/a.png)"],
    ["a relative path", "Changed public/logo.png and ./a/b.png and ~/c.png and @/d.png"],
    ["a path that continues past the extension", "/tmp/a.png.bak and /tmp/b.pngx"],
    ["a non-image file", "/tmp/a.txt"],
    ["a relative citation", "【F:public/logo.png†L1】"],
  ])("ignores %s", (_name, text) => {
    expect(extractLocalImagePaths(text)).toEqual([])
  })

  it("does not merge two paths on one line into one with spaces", () => {
    expect(extractLocalImagePaths("/tmp/a.png and /tmp/b.png")).toEqual(["/tmp/a.png", "/tmp/b.png"])
  })
})

describe("linkLocalMarkdownImages", () => {
  it("links a local image, labelled by its alt text or file name", () => {
    expect(linkLocalMarkdownImages("![Card](/tmp/a.png)")).toBe("[Card](/tmp/a.png)")
    expect(linkLocalMarkdownImages("See ![](/tmp/a.png) here")).toBe("See [a.png](/tmp/a.png) here")
    expect(linkLocalMarkdownImages('![](</tmp/d e.png> "title")')).toBe("[d e.png](</tmp/d e.png>)")
  })

  it("leaves remote images and code alone", () => {
    const text = "![x](https://example.com/a.png)\n`![x](/tmp/a.png)`\n```\n![x](/tmp/b.png)\n```"
    expect(linkLocalMarkdownImages(text)).toBe(text)
  })
})
