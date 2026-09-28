import { registerGuide } from "../registry.ts"
import { GUIDE } from "./guide.ts"

registerGuide("zhihu", GUIDE)

export { hot } from "./hot.ts"
export {
  user,
  question,
  search,
  recommend,
  following,
  followers,
  userAnswers,
  userArticles,
  pins,
  collections,
  answerDetail,
  answerComments,
} from "./reads.ts"
