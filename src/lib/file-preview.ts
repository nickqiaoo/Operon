import { api } from "@/lib/api"

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

export const shouldReadFileContent = (filePath: string): boolean => !isRasterImageFilePath(filePath)

export async function readFileForPreview(filePath: string): Promise<string> {
  if (!shouldReadFileContent(filePath)) {
    return ""
  }

  return api.readFile(filePath)
}
