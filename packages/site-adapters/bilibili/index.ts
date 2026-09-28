import { registerGuide } from "../registry.ts"
import { GUIDE } from "./guide.ts"

registerGuide("bilibili", GUIDE)

export { hot } from "./hot.ts"
export {
  search,
  ranking,
  video,
  me,
  history,
  userVideos,
  following,
  dynamic,
  feed,
} from "./reads.ts"
export type { BilibiliHotOptions, HotVideo } from "../types.ts"
