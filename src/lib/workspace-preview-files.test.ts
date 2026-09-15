import { describe, expect, it } from "vitest"
import { closePreviewFile, openPreviewFile, previewFilesOf } from "./workspace-preview-files"

describe("workspace preview files", () => {
  it("seeds the strip from a payload that only has selectedPath", () => {
    expect(previewFilesOf({ selectedPath: "/a" })).toEqual({ openPaths: ["/a"], recentPaths: ["/a"] })
    expect(previewFilesOf({ selectedPath: null })).toEqual({ openPaths: [], recentPaths: [] })
  })

  it("appends new files and keeps display order when revisiting", () => {
    let files = previewFilesOf({ selectedPath: "/a" })
    files = openPreviewFile(files, "/b")
    files = openPreviewFile(files, "/a")
    expect(files.openPaths).toEqual(["/a", "/b"])
    expect(files.recentPaths).toEqual(["/b", "/a"])
  })

  it("evicts the least recently viewed file, not the leftmost", () => {
    let files = previewFilesOf({ selectedPath: "/a" })
    files = openPreviewFile(files, "/b", 3)
    files = openPreviewFile(files, "/c", 3)
    files = openPreviewFile(files, "/a", 3)
    files = openPreviewFile(files, "/d", 3)
    expect(files.openPaths).toEqual(["/a", "/c", "/d"])
    expect(files.recentPaths).toEqual(["/c", "/a", "/d"])
  })

  it("falls back to the most recent remaining file when closing the active one", () => {
    let files = previewFilesOf({ selectedPath: "/a" })
    files = openPreviewFile(files, "/b")
    files = openPreviewFile(files, "/c")
    files = openPreviewFile(files, "/b")
    expect(closePreviewFile(files, "/b", "/b")).toEqual({
      openPaths: ["/a", "/c"],
      recentPaths: ["/a", "/c"],
      selectedPath: "/c",
    })
    expect(closePreviewFile(files, "/a", "/b").selectedPath).toBe("/b")
    expect(closePreviewFile({ openPaths: ["/a"], recentPaths: ["/a"] }, "/a", "/a").selectedPath).toBeNull()
  })
})
