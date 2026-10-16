import type { ReactNode } from 'react'
import { Reveal } from './Reveal'
import { Code } from './AssistantSection'
import { AgentAvatar, FeatureList, Lead, Muted, Section, Split, Title, Window } from './ui'
import { cn } from '../lib/styles'

const FEATURES = [
  {
    title: 'Two sign-offs',
    desc: 'Dispatch approves the spec and plan and starts the work; Done accepts the result. Nothing in between waits on you.',
  },
  {
    title: 'The design lives in git',
    desc: 'spec.md, plan.md and acceptance.md sit on the task’s branch, so the design lands in the same diff as the code.',
  },
  {
    title: 'Split and dispatch',
    desc: 'A large change splits into child tasks, each on its own branch with the agent best suited to it. Finished children merge back on their own.',
  },
  {
    title: 'Checked independently',
    desc: 'A separate verifier agent can check the work against the acceptance criteria before you sign it off.',
  },
]

export function SddSection() {
  return (
    <Section id="sdd" tone="sidebar">
      <Reveal>
        <Split
          copy={
            <>
              <Title>
                Align first. <Muted>Then build.</Muted>
              </Title>
              <Lead>
                Spec-driven development turns a one-line task into a reviewable change: a spec, a technical plan
                and acceptance criteria. Start it from any chat or task when a change is too big to vibe-code.
              </Lead>
              <div className="mt-8">
                <FeatureList items={FEATURES} />
              </div>
            </>
          }
          visual={<SpecMock />}
        />
      </Reveal>
    </Section>
  )
}

function SpecMock() {
  return (
    <Window title="OPR-152 · Team invitations">
      <div className="grid md:grid-cols-[minmax(0,1fr)_180px]">
        <div className="min-w-0 p-4 md:p-5">
          <div className="flex gap-4 border-b border-border/50 text-[13px]">
            {['Spec', 'Plan', 'Acceptance'].map((tab, i) => (
              <span
                key={tab}
                className={cn(
                  '-mb-px border-b pb-2',
                  i === 0 ? 'border-foreground font-medium text-foreground' : 'border-transparent text-muted-foreground',
                )}
              >
                {tab}
              </span>
            ))}
          </div>
          <div className="mt-4 flex items-center justify-between gap-3">
            <span className="rounded bg-status-ok/10 px-1.5 py-0.5 text-[11px] font-medium text-status-ok">Ready</span>
            <span className="truncate font-mono text-[11px] text-muted-foreground">.operon/changes/opr-152/spec.md</span>
          </div>
          <div className="mt-4 text-[15px] font-semibold text-foreground">Invite teammates by email</div>
          <p className="mt-2 text-[12.5px] leading-[1.65] text-muted-foreground">
            Owners can invite people to a workspace. An invite expires after 7 days and can be revoked at any time.
          </p>
          <div className="mt-4 space-y-2">
            {['Invite link works once', 'Expired invites are refused', 'Revoking removes pending access'].map((ac) => (
              <div key={ac} className="flex items-center gap-2 text-[12.5px] text-foreground">
                <span className="h-3.5 w-3.5 shrink-0 rounded border border-border" />
                {ac}
              </div>
            ))}
          </div>
        </div>
        <div className="space-y-3 border-t border-border/50 bg-sidebar p-4 md:border-t-0 md:border-l">
          <Field label="Status">Todo</Field>
          <Field label="Assignee">
            <span className="inline-flex items-center gap-1.5">
              <AgentAvatar name="Codex" size={16} />
              Codex
            </span>
          </Field>
          <Field label="Branch">
            <Code>operon/opr-152</Code>
          </Field>
          <div className="flex h-8 items-center justify-center rounded-lg bg-foreground text-[12.5px] font-medium text-background">
            Dispatch
          </div>
        </div>
      </div>
    </Window>
  )
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <div className="text-[11px] text-muted-foreground">{label}</div>
      <div className="mt-1 text-[12.5px] text-foreground">{children}</div>
    </div>
  )
}
