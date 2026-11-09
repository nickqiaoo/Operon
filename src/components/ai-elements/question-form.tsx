import { useState, type FormEvent } from "react"
import { FormattedMessage } from "react-intl"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { cn } from "@/lib/utils"

export interface Question {
  title: string
  /** Empty: the question is answered in the user's own words. */
  options: readonly string[]
}

interface QuestionFormProps {
  questions: readonly Question[]
  /** What the message says above the form, so a title already there isn't shown twice. */
  body: string
  /** What the user answered; unset while the question is open. */
  answer?: string
  disabled: boolean
  /** Sends the answer as the user's next message. */
  onSubmit: (text: string) => void
}

/** Long options wrap instead of stretching the row. */
const OPTION_CLASS = "h-auto min-h-8 whitespace-normal py-1.5 text-left"

/** What a question the agent asked needs under its message, by how it can be answered. */
export function QuestionForm({ questions, body, answer, disabled, onSubmit }: QuestionFormProps) {
  if (questions.length > 1) return <MultipleQuestions questions={questions} answer={answer} disabled={disabled} onSubmit={onSubmit} />
  const [question] = questions
  if (question.options.length === 0) {
    return question.title === body ? null : <p className="px-1 pt-1 text-xs text-muted-foreground">{question.title}</p>
  }
  return (
    <div className="flex flex-wrap gap-1.5 pt-1">
      {question.options.map((option) => (
        <Button
          key={option}
          type="button"
          size="sm"
          variant="secondary"
          disabled={disabled}
          className={cn(OPTION_CLASS, option === answer && "disabled:opacity-100")}
          onClick={() => onSubmit(option)}
        >
          {option}
        </Button>
      ))}
    </div>
  )
}

const answerLine = (title: string, value: string) => `${title}: ${value}`

/** One question's value back out of the message the form sent. */
function answeredValue(title: string, answer: string): string {
  const prefix = answerLine(title, "")
  return answer.split("\n").find((line) => line.startsWith(prefix))?.slice(prefix.length) ?? ""
}

function MultipleQuestions({ questions, answer, disabled, onSubmit }: Omit<QuestionFormProps, "body">) {
  const [drafts, setDrafts] = useState<string[]>(() => questions.map(() => ""))
  const answered = answer !== undefined
  const locked = disabled || answered
  const values = questions.map((question, i) => (answered ? answeredValue(question.title, answer) : drafts[i] ?? ""))
  const setValue = (index: number, value: string) => setDrafts((current) => current.map((old, i) => (i === index ? value : old)))

  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (locked || values.some((value) => !value.trim())) return
    onSubmit(questions.map((question, i) => answerLine(question.title, values[i].trim())).join("\n"))
  }

  return (
    <form onSubmit={submit} className="mt-1 flex w-full flex-col gap-3 rounded-xl border border-border/60 bg-popover p-3 shadow-card dark:border-border/35">
      {questions.map((question, i) => (
        <div key={question.title} className="flex flex-col gap-1.5">
          <p className="text-sm font-medium">{question.title}</p>
          {question.options.length > 0 ? (
            <div className="flex flex-wrap gap-1.5">
              {question.options.map((option) => {
                const selected = values[i] === option
                return (
                  <Button
                    key={option}
                    type="button"
                    size="sm"
                    variant={selected ? "secondary" : "ghost"}
                    aria-pressed={selected}
                    disabled={locked}
                    className={cn(OPTION_CLASS, selected ? "disabled:opacity-100" : "border border-border/50 dark:border-border/35")}
                    onClick={() => setValue(i, option)}
                  >
                    {option}
                  </Button>
                )
              })}
            </div>
          ) : (
            <Input
              aria-label={question.title}
              value={values[i]}
              disabled={locked}
              onChange={(event) => setValue(i, event.target.value)}
              className="h-8 rounded-lg border-border/50 text-sm dark:border-border/35"
            />
          )}
        </div>
      ))}
      {!answered && (
        <Button type="submit" size="sm" variant="secondary" className="h-8 self-end" disabled={locked || values.some((value) => !value.trim())}>
          <FormattedMessage id="chat.question.submit" defaultMessage="Submit" />
        </Button>
      )}
    </form>
  )
}
