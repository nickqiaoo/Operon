import { registerGuide } from "../registry.ts"
import { GUIDE } from "./guide.ts"

registerGuide("reddit", GUIDE)

export {
  hot,
  frontpage,
  popular,
  subreddit,
  search,
  userPosts,
  userComments,
  user,
  whoami,
  home,
  subredditInfo,
  saved,
  upvoted,
  subscribed,
} from "./reads.ts"
