import { useState } from "react"
import { Eye, EyeOff } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Switch } from "@/components/ui/switch"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import type { CanvasHttpAuth, CanvasHttpBodyType, CanvasHttpMethod, CanvasHttpNodeData } from "@/types/canvas-workflow"
import { Field, NumberField, TextAreaField, TextField, VARIABLES_HINT, labelClass, selectContentClass, selectTriggerClass } from "./fields"
import { KeyValueList } from "./KeyValueList"

const METHODS: CanvasHttpMethod[] = ["GET", "POST", "PUT", "PATCH", "DELETE"]
const BODY_TYPES: Array<{ id: CanvasHttpBodyType; label: string }> = [
  { id: "none", label: "None" },
  { id: "json", label: "JSON" },
  { id: "text", label: "Text" },
  { id: "form", label: "Form (urlencoded)" },
]

function SecretField({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder?: string }) {
  const [show, setShow] = useState(false)
  return (
    <div className="flex items-center gap-1.5">
      <TextField
        value={value}
        onChange={onChange}
        placeholder={placeholder}
        mono
        className={show ? "flex-1" : "flex-1 [-webkit-text-security:disc]"}
      />
      <Button variant="ghost" size="icon" className="h-7 w-7 shrink-0" onClick={() => setShow((s) => !s)}>
        {show ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
      </Button>
    </div>
  )
}

export function HttpPanel({
  nodeData,
  onUpdate,
}: {
  nodeData: CanvasHttpNodeData
  onUpdate: (updates: Partial<CanvasHttpNodeData>) => void
}) {
  const auth: CanvasHttpAuth = nodeData.auth ?? { type: "none" }
  const method = nodeData.method ?? "GET"
  const bodyType = nodeData.bodyType ?? "none"

  const setAuthType = (type: CanvasHttpAuth["type"]) => {
    if (type === "none") onUpdate({ auth: { type: "none" } })
    else if (type === "bearer") onUpdate({ auth: { type: "bearer", token: "" } })
    else onUpdate({ auth: { type: "basic", username: "", password: "" } })
  }

  return (
    <div className="space-y-4">
      <Field label="Request" hint={VARIABLES_HINT}>
        <div className="flex items-center gap-1.5">
          <Select value={method} onValueChange={(v) => onUpdate({ method: v as CanvasHttpMethod })}>
            <SelectTrigger className={`${selectTriggerClass} w-[96px] shrink-0`}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent className={selectContentClass}>
              {METHODS.map((m) => <SelectItem key={m} value={m}>{m}</SelectItem>)}
            </SelectContent>
          </Select>
          <TextField
            value={nodeData.url || ""}
            onChange={(url) => onUpdate({ url })}
            placeholder="https://api.example.com/items/{{ id }}"
            mono
            className="flex-1"
          />
        </div>
      </Field>

      <div className="space-y-1.5">
        <label className={labelClass}>Auth</label>
        <Select value={auth.type} onValueChange={(v) => setAuthType(v as CanvasHttpAuth["type"])}>
          <SelectTrigger className={selectTriggerClass}><SelectValue /></SelectTrigger>
          <SelectContent className={selectContentClass}>
            <SelectItem value="none">None</SelectItem>
            <SelectItem value="bearer">Bearer token</SelectItem>
            <SelectItem value="basic">Basic</SelectItem>
          </SelectContent>
        </Select>
        {auth.type === "bearer" && (
          <SecretField
            value={auth.token}
            onChange={(token) => onUpdate({ auth: { type: "bearer", token } })}
            placeholder="{{ env.API_TOKEN }}"
          />
        )}
        {auth.type === "basic" && (
          <div className="space-y-1.5">
            <TextField
              value={auth.username}
              onChange={(username) => onUpdate({ auth: { ...auth, username } })}
              placeholder="username"
              mono
            />
            <SecretField
              value={auth.password}
              onChange={(password) => onUpdate({ auth: { ...auth, password } })}
              placeholder="{{ env.API_PASSWORD }}"
            />
          </div>
        )}
        <p className="text-[10px] text-muted-foreground/50">
          Reference secrets as {"{{ env.NAME }}"} (Settings → Environment) so they never sit in the workflow.
        </p>
      </div>

      <div className="space-y-1.5">
        <label className={labelClass}>Headers</label>
        <KeyValueList
          entries={nodeData.headers ?? []}
          onChange={(headers) => onUpdate({ headers })}
          keyPlaceholder="Header"
          valuePlaceholder="value"
          addLabel="Add header"
          valueMono
        />
      </div>

      {method !== "GET" && (
        <div className="space-y-1.5">
          <label className={labelClass}>Body</label>
          <Select value={bodyType} onValueChange={(v) => onUpdate({ bodyType: v as CanvasHttpBodyType })}>
            <SelectTrigger className={selectTriggerClass}><SelectValue /></SelectTrigger>
            <SelectContent className={selectContentClass}>
              {BODY_TYPES.map((b) => <SelectItem key={b.id} value={b.id}>{b.label}</SelectItem>)}
            </SelectContent>
          </Select>
          {bodyType !== "none" && (
            <TextAreaField
              value={nodeData.body || ""}
              onChange={(body) => onUpdate({ body })}
              placeholder={bodyType === "json" ? '{"text": {{ summary | tojson }}}' : "key=value&other={{ x }}"}
              mono
              minHeight="min-h-[100px]"
            />
          )}
          {bodyType === "json" && (
            <p className="text-[10px] text-muted-foreground/50">
              Use {"{{ value | tojson }}"} to embed text safely; the rendered body is checked to be valid JSON before sending.
            </p>
          )}
        </div>
      )}

      <Field label="Timeout (ms)" hint="Default 30000.">
        <NumberField value={nodeData.timeoutMs} onChange={(timeoutMs) => onUpdate({ timeoutMs })} placeholder="30000" />
      </Field>
      <div className="flex items-center justify-between rounded-lg border border-border/40 bg-muted/10 px-3 py-2.5">
        <div>
          <div className="text-xs font-medium">Fail on non-2xx</div>
          <div className="text-[10px] text-muted-foreground/60">Off: the response body is passed on regardless of status.</div>
        </div>
        <Switch
          checked={nodeData.failOnNon2xx ?? true}
          onCheckedChange={(failOnNon2xx) => onUpdate({ failOnNon2xx })}
        />
      </div>
    </div>
  )
}
