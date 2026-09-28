import { registerGuide } from "../registry.ts"
import { GUIDE } from "./guide.ts"

registerGuide("twitter", GUIDE)

export { trending } from "./trending.ts"
export { profile, timeline, tweets, search, thread } from "./reads.ts"
