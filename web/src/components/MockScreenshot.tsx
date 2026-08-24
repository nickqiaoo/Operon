/**
 * A mock product screenshot that resembles a code editor / AI coding tool.
 */
export function MockScreenshot() {
  return (
    <div className="w-full rounded-2xl overflow-hidden bg-[#0d1117] border border-white/[0.08] shadow-2xl">
      {/* Title bar */}
      <div className="flex items-center gap-2 px-4 py-3 bg-[#161b22] border-b border-white/[0.06]">
        <div className="flex gap-1.5">
          <div className="w-3 h-3 rounded-full bg-[#ff5f57]" />
          <div className="w-3 h-3 rounded-full bg-[#febc2e]" />
          <div className="w-3 h-3 rounded-full bg-[#28c840]" />
        </div>
        <div className="flex-1 text-center text-xs text-white/30 font-medium tracking-wide">
          Operon
        </div>
      </div>

      {/* Content area */}
      <div className="flex h-[340px] sm:h-[400px] md:h-[480px]">
        {/* Sidebar */}
        <div className="w-48 border-r border-white/[0.06] p-3 hidden sm:block">
          <div className="space-y-2">
            <div className="h-3 w-20 bg-white/[0.06] rounded" />
            <div className="ml-3 space-y-1.5">
              <div className="h-2.5 w-24 bg-white/[0.04] rounded" />
              <div className="h-2.5 w-16 bg-white/[0.04] rounded" />
              <div className="h-2.5 w-28 bg-indigo-500/20 rounded" />
              <div className="h-2.5 w-20 bg-white/[0.04] rounded" />
            </div>
            <div className="h-3 w-16 bg-white/[0.06] rounded mt-4" />
            <div className="ml-3 space-y-1.5">
              <div className="h-2.5 w-20 bg-white/[0.04] rounded" />
              <div className="h-2.5 w-24 bg-white/[0.04] rounded" />
            </div>
          </div>
        </div>

        {/* Editor */}
        <div className="flex-1 p-4 font-mono text-[11px] sm:text-xs leading-relaxed">
          <div className="space-y-1">
            <div className="flex">
              <span className="w-6 text-white/20 select-none">1</span>
              <span className="text-purple-400">import</span>
              <span className="text-white/60 mx-1">{'{'}</span>
              <span className="text-yellow-300">useState</span>
              <span className="text-white/60 mx-1">{'}'}</span>
              <span className="text-purple-400 mx-1">from</span>
              <span className="text-green-400">'react'</span>
            </div>
            <div className="flex">
              <span className="w-6 text-white/20 select-none">2</span>
            </div>
            <div className="flex">
              <span className="w-6 text-white/20 select-none">3</span>
              <span className="text-purple-400">export function</span>
              <span className="text-blue-400 ml-1">App</span>
              <span className="text-white/60">() {'{'}</span>
            </div>
            <div className="flex">
              <span className="w-6 text-white/20 select-none">4</span>
              <span className="text-white/40 ml-4">const</span>
              <span className="text-white/80 ml-1">[data, setData]</span>
              <span className="text-white/40 mx-1">=</span>
              <span className="text-yellow-300">useState</span>
              <span className="text-white/60">([])</span>
            </div>
            <div className="flex">
              <span className="w-6 text-white/20 select-none">5</span>
            </div>
            <div className="flex items-center">
              <span className="w-6 text-white/20 select-none">6</span>
              <span className="ml-4 text-white/80">
                <span className="inline-block w-1.5 h-4 bg-indigo-400 animate-pulse mr-0.5" />
              </span>
            </div>
          </div>

          {/* AI suggestion overlay */}
          <div className="mt-6 mx-2 p-3 rounded-lg bg-indigo-500/[0.08] border border-indigo-500/20">
            <div className="flex items-center gap-2 mb-2">
              <div className="w-4 h-4 rounded-full bg-gradient-to-br from-indigo-400 to-purple-500" />
              <span className="text-[10px] sm:text-xs text-indigo-300/80 font-medium">AI Suggestion</span>
            </div>
            <div className="space-y-1 text-green-400/60">
              <div className="h-2.5 w-3/4 bg-green-400/10 rounded" />
              <div className="h-2.5 w-1/2 bg-green-400/10 rounded" />
              <div className="h-2.5 w-2/3 bg-green-400/10 rounded" />
            </div>
          </div>
        </div>

        {/* Chat panel */}
        <div className="w-56 border-l border-white/[0.06] p-3 hidden md:flex flex-col">
          <div className="text-[10px] text-white/30 uppercase tracking-wider mb-3 font-medium">Chat</div>
          <div className="space-y-3 flex-1">
            <div className="bg-white/[0.04] rounded-lg p-2">
              <div className="h-2 w-full bg-white/[0.06] rounded mb-1" />
              <div className="h-2 w-2/3 bg-white/[0.06] rounded" />
            </div>
            <div className="bg-indigo-500/[0.08] rounded-lg p-2 ml-4">
              <div className="h-2 w-full bg-indigo-400/10 rounded mb-1" />
              <div className="h-2 w-3/4 bg-indigo-400/10 rounded mb-1" />
              <div className="h-2 w-1/2 bg-indigo-400/10 rounded" />
            </div>
          </div>
          <div className="mt-auto pt-2">
            <div className="h-8 rounded-lg bg-white/[0.04] border border-white/[0.06]" />
          </div>
        </div>
      </div>
    </div>
  )
}
