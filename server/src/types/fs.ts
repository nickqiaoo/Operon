export interface FileInfo {
  name: string
  path: string
  isDirectory: boolean
}

export interface FileStat {
  isDirectory: boolean
  isFile: boolean
  size: number
  mtime: string
}
