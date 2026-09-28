import { registerGuide } from "../registry.ts"
import { GUIDE } from "./guide.ts"

registerGuide("hackernews", GUIDE)

export { top, newest, best, ask, show, jobs } from "./stories.ts"
export { search } from "./search.ts"
export { user } from "./user.ts"
