/** First-party MCP App resource. All task data arrives over the MCP Apps bridge. */
export const SCHEDULE_APP_URI = 'ui://schedule/task.html'
export const SCHEDULE_APP_MIME_TYPE = 'text/html;profile=mcp-app'

export const SCHEDULE_APP_HTML = String.raw`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; form-action 'none'; base-uri 'none'">
<style>
*{box-sizing:border-box;scrollbar-width:thin;scrollbar-color:var(--scrollbar-thumb,#8884) transparent}
*::-webkit-scrollbar{width:6px;height:6px}*::-webkit-scrollbar-track{background:transparent}
*::-webkit-scrollbar-thumb{background:var(--scrollbar-thumb,#8884);border:1.5px solid transparent;border-radius:999px;background-clip:padding-box}
*::-webkit-scrollbar-corner{background:transparent}
body{margin:0;font:13px/1.5 var(--font-sans,system-ui,sans-serif);color:var(--foreground,#333)}
.card{border:1px solid color-mix(in srgb,var(--border,#e8e8ec) 50%,transparent);border-radius:12px;background:var(--card,#fff);overflow:hidden}
header{display:flex;align-items:center;gap:10px;padding:16px 16px 12px}
.icon{display:grid;place-items:center;width:32px;height:32px;border-radius:8px;background:color-mix(in srgb,var(--muted,#f4f4f6) 30%,transparent);color:var(--muted-foreground,#777)}
.heading{flex:1}.eyebrow{font-size:11px;color:var(--muted-foreground,#777)}h2{font-size:14px;font-weight:600;margin:1px 0}
.badge{font-size:11px;background:var(--muted,#f4f4f6);border-radius:20px;padding:3px 9px;color:var(--muted-foreground,#777)}
form{margin:0}fieldset{border:0;margin:0;padding:0 16px 14px;min-width:0;display:grid;gap:12px}
label,.label{display:grid;gap:6px;font-size:12px;color:var(--muted-foreground,#777)}
input,textarea,button{font:inherit}input:not([type=checkbox]),textarea{width:100%;min-width:0;border:1px solid transparent;border-radius:8px;background:color-mix(in srgb,var(--muted,#f4f4f6) 30%,transparent);color:var(--foreground,#333);padding:8px 10px;outline:none;transition:background .15s,border-color .15s}
input:not([type=checkbox]):hover,textarea:hover{background:var(--row-hover,#8881)}
input:not([type=checkbox]):focus,textarea:focus{background:var(--background,#fff);border-color:color-mix(in srgb,var(--tint,#888) 20%,transparent)}
input:focus-visible,textarea:focus-visible,button:focus-visible{outline:2px solid color-mix(in srgb,var(--ring,#999) 40%,transparent);outline-offset:2px}
textarea{resize:none;field-sizing:content;min-height:96px;max-height:240px;overflow-y:auto;line-height:1.65}
button{cursor:pointer;border:0;transition:background .15s,color .15s}button:disabled{cursor:default;opacity:.45}
.row{display:flex;align-items:end;gap:12px;flex-wrap:wrap}.time{width:125px}.days{display:flex;gap:5px;flex-wrap:wrap}
.day{display:grid;place-items:center;width:30px;height:30px;border-radius:7px;color:var(--muted-foreground,#777);background:transparent;font-size:11px}
.day:hover{background:var(--row-hover,#8881)}
.day[aria-pressed=true]{color:var(--foreground,#333);background:color-mix(in srgb,var(--tint,#888) 14%,transparent)}
.toggle{display:flex;align-items:center;justify-content:space-between;gap:12px;cursor:pointer}
.toggle input{appearance:none;position:relative;flex-shrink:0;width:32px;height:18px;margin:0;border:1px solid transparent;border-radius:999px;background:color-mix(in srgb,var(--muted-foreground,#777) 30%,transparent);transition:background .15s;cursor:pointer}
.toggle input::before{content:'';position:absolute;width:14px;height:14px;top:1px;left:1px;border-radius:50%;background:white;transition:transform .15s;box-shadow:0 1px 2px #0002}
.toggle input:checked{background:var(--accent-green,#3db87a)}.toggle input:checked::before{transform:translateX(14px)}
.repeat{display:flex;gap:10px;align-items:center;flex-wrap:wrap}.repeat input[type=number]{width:74px}.repeat input[type=time]{width:125px}
footer{padding:10px 16px;border-top:1px solid color-mix(in srgb,var(--border,#e8e8ec) 40%,transparent);display:flex;align-items:center;gap:10px}
.status{flex:1;font-size:11px;color:var(--muted-foreground,#777)}.status[data-error=true]{color:var(--destructive,#b42318)}
.save{border-radius:8px;background:var(--secondary,#f0f0f3);color:var(--secondary-foreground,#333);padding:7px 12px;font-size:12px;font-weight:500}
.save:not(:disabled):hover{background:var(--row-hover,#8881)}
.meta{font-size:11px;color:var(--muted-foreground,#777)}[hidden]{display:none!important}
@media(max-width:420px){header{padding:14px 14px 12px}fieldset{padding:0 14px 14px}footer{padding:12px 14px}}
</style></head><body>
<section class="card" aria-label="Scheduled task">
<header><div class="icon"><svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><rect x="3" y="5" width="18" height="16" rx="3"/><path d="M16 3v4M8 3v4M3 11h18M8 16h3"/></svg></div><div class="heading"><div class="eyebrow">Scheduled task</div><h2 id="title">Loading task…</h2></div><span id="badge" class="badge">Loading</span></header>
<form id="form"><fieldset id="fields" disabled>
<label>Name<input id="name" required maxlength="200" autocomplete="off"></label>
<div class="row"><label class="time">Run at<input id="time" type="time" required></label><div class="label">Repeat on<div id="days" class="days" role="group" aria-label="Days of week"></div></div></div>
<label class="toggle">Repeat within day<input id="repeat" type="checkbox" role="switch"></label>
<div id="intervalFields" class="repeat" hidden><label>Every (minutes)<input id="interval" type="number" min="1" max="1440" value="60"></label><label>Until<input id="endTime" type="time" value="18:00"></label></div>
<label id="promptLabel">Instructions<textarea id="prompt" rows="3" required></textarea></label>
<label class="toggle">Enabled<input id="enabled" type="checkbox" role="switch"></label><span id="meta" class="meta"></span>
</fieldset><footer><span id="status" class="status" role="status" aria-live="polite">Connecting…</span><button id="save" class="save" disabled type="button">Save changes</button></footer></form>
</section>
<script>
(function(){
  var parentWindow=window.parent,seq=0,pending=new Map(),task=null,dirty=false;
  var $=function(id){return document.getElementById(id)},days=[1,2,3,4,5,6,0],labels=['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  function post(value){parentWindow.postMessage(Object.assign({jsonrpc:'2.0'},value),'*')}
  function notify(method,params){post({method:method,params:params})}
  function request(method,params){return new Promise(function(resolve,reject){var id=++seq;var timeout=setTimeout(function(){pending.delete(id);reject(new Error('Connection timed out. Please try again.'))},30000);pending.set(id,{resolve:resolve,reject:reject,timeout:timeout});post({id:id,method:method,params:params})})}
  function status(text,error){$('status').textContent=text;$('status').dataset.error=String(!!error)}
  function changed(){dirty=true;$('save').disabled=false;status('Unsaved changes')}
  days.forEach(function(day){var b=document.createElement('button');b.type='button';b.className='day';b.textContent=labels[day].slice(0,2);b.setAttribute('aria-label',labels[day]);b.setAttribute('aria-pressed','false');b.dataset.day=String(day);b.onclick=function(){b.setAttribute('aria-pressed',String(b.getAttribute('aria-pressed')!=='true'));changed()};$('days').appendChild(b)});
  function resultTask(result){if(result.isError)throw new Error((result.content||[]).map(function(c){return c.text||''}).join('\n')||'Could not load task');var data=result.structuredContent;if(!data){var block=(result.content||[]).find(function(c){return c.type==='text'});if(block)data=JSON.parse(block.text)}return data&&data.task}
  function render(next){
    if(!next)return;task=next;dirty=false;
    $('title').textContent=next.name;$('name').value=next.name;$('time').value=next.schedule.time;
    $('enabled').checked=next.enabled;$('badge').textContent=next.enabled?'Active':'Paused';
    $('prompt').value=next.prompt||'';var chat=next.type==='chat';$('promptLabel').hidden=!chat;$('prompt').required=chat;
    var selected=next.schedule.days.length?next.schedule.days:[1,2,3,4,5];
    document.querySelectorAll('.day').forEach(function(b){b.setAttribute('aria-pressed',String(selected.includes(Number(b.dataset.day))))});
    $('repeat').checked=!!next.schedule.intervalMinutes;$('intervalFields').hidden=!$('repeat').checked;
    $('interval').value=next.schedule.intervalMinutes||60;$('endTime').value=next.schedule.endTime||'18:00';
    $('meta').textContent=[next.provider_id,Intl.DateTimeFormat().resolvedOptions().timeZone].filter(Boolean).join(' · ');
    $('fields').disabled=false;$('save').disabled=true;status('Saved');
  }
  window.addEventListener('message',function(event){
    if(event.source!==parentWindow)return;var data=event.data;if(!data||data.jsonrpc!=='2.0')return;
    if(data.id!==undefined&&pending.has(data.id)){var p=pending.get(data.id);pending.delete(data.id);clearTimeout(p.timeout);if(data.error)p.reject(new Error(data.error.message));else p.resolve(data.result);return}
    if(data.method==='ui/notifications/tool-result'&&!dirty){try{render(resultTask(data.params))}catch(error){status(error.message,true)}}
    if(data.method==='ui/resource-teardown'&&data.id!==undefined)post({id:data.id,result:{}});
  });
  $('form').addEventListener('input',function(){if(!task)return;$('intervalFields').hidden=!$('repeat').checked;changed()});
  $('form').addEventListener('keydown',function(event){if(event.key==='Enter'&&event.target.tagName==='INPUT'){event.preventDefault();$('save').click()}});
  $('save').addEventListener('click',async function(event){
    event.preventDefault();if(!task||!dirty||$('fields').disabled)return;
    var selected=Array.from(document.querySelectorAll('.day[aria-pressed=true]')).map(function(b){return Number(b.dataset.day)});
    if(!selected.length){status('Select at least one day.',true);return}
    if(!$('name').value.trim()||(!$('promptLabel').hidden&&!$('prompt').value.trim())){status('Name and instructions cannot be empty.',true);return}
    var schedule={time:$('time').value,days:selected};
    if($('repeat').checked){schedule.intervalMinutes=Number($('interval').value);schedule.endTime=$('endTime').value;if(!Number.isInteger(schedule.intervalMinutes)||schedule.intervalMinutes<1||schedule.intervalMinutes>1440){status('Interval must be between 1 and 1440 minutes.',true);return}if(!schedule.endTime||schedule.endTime<=schedule.time){status('End time must be later than start time.',true);return}}
    var args={id:task.id,name:$('name').value.trim(),schedule:schedule,enabled:$('enabled').checked};if(task.type==='chat')args.prompt=$('prompt').value.trim();
    $('fields').disabled=true;$('save').disabled=true;status('Saving…');
    try{var result=await request('tools/call',{name:'schedule_update',arguments:args});render(resultTask(result))}catch(error){status(error.message,true);$('fields').disabled=false;$('save').disabled=false}
  });
  new ResizeObserver(function(){notify('ui/notifications/size-changed',{height:document.documentElement.getBoundingClientRect().height})}).observe(document.documentElement);
  request('ui/initialize',{appInfo:{name:'Operon Schedule',version:'1.0.0'},appCapabilities:{availableDisplayModes:['inline']},protocolVersion:'2026-01-26'}).then(function(){notify('ui/notifications/initialized',{})}).catch(function(error){status(error.message,true)});
})();
</script></body></html>`
