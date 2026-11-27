import { api as localApi, type Api } from "@/lib/api"

const IMAGE_MEDIA_TYPE_BY_EXTENSION: Record<string, string> = {
  avif: "image/avif",
  bmp: "image/bmp",
  gif: "image/gif",
  ico: "image/x-icon",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  png: "image/png",
  svg: "image/svg+xml",
  tif: "image/tiff",
  tiff: "image/tiff",
  webp: "image/webp",
}

export const IMAGE_EXTENSIONS = Object.keys(IMAGE_MEDIA_TYPE_BY_EXTENSION)

const getFileExtension = (filePath: string): string => {
  const filename = filePath.split(/[/\\]/).pop() ?? filePath
  const dotIndex = filename.lastIndexOf(".")
  if (dotIndex === -1) return ""
  return filename.slice(dotIndex + 1).toLowerCase()
}

export const getImageMediaType = (filePath: string): string | null => {
  const extension = getFileExtension(filePath)
  return IMAGE_MEDIA_TYPE_BY_EXTENSION[extension] ?? null
}

export const isImageFilePath = (filePath: string): boolean => getImageMediaType(filePath) !== null

export const isRasterImageFilePath = (filePath: string): boolean => {
  const mediaType = getImageMediaType(filePath)
  return mediaType !== null && mediaType !== "image/svg+xml"
}

export function filePreviewKind(path: string) {
  const extension = getFileExtension(path)
  if (isRasterImageFilePath(path)) return "image"
  if (extension === "pdf" || extension === "docx") return extension
  if (/^(mp4|m4v|mov|webm|ogv|mkv|avi|wmv)$/.test(extension)) return "video"
  if (/^(csv|tsv|xls[xmb]?|ods|ppt[xms]?|pps[xm]?|odp|doc|zip|gz|bz2|xz|7z|rar|tar|exe|dll|dylib|so|bin|wasm|sqlite3?|db|dmg|mp3|wav|flac|aac)$/.test(extension)) return "unsupported"
  return "text"
}

export const shouldReadFileContent = (filePath: string): boolean => filePreviewKind(filePath) === "text"

export async function readFileForPreview(
  filePath: string,
  /** The machine the file lives on; this one by default. */
  api: Pick<Api, "readFile"> = localApi,
): Promise<string> {
  if (!shouldReadFileContent(filePath)) {
    return ""
  }

  return api.readFile(filePath, true)
}
