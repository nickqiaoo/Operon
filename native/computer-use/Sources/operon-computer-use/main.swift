import Foundation
import OperonComputerUseWire
import OperonComputerUseServer
import OperonFocusProbe

// operon Computer Use Service — the codex-compatible domain socket engine entrypoint.
//   Usage: operon-computer-use [socketPath]
//          operon-computer-use focus-probe|focus-spi|focus-events   // background focus diagnostics
//   socketPath precedence: argv[1] > env SKY_CUA_NATIVE_PIPE_PATH > a default under the temp dir.
let arguments = Array(CommandLine.arguments.dropFirst())

switch arguments.first {
case "focus-probe":
    exit(FocusProbeCLI.run(Array(arguments.dropFirst())))
case "focus-spi":
    exit(FocusSPICLI.run(Array(arguments.dropFirst())))
case "focus-endtoend":
    exit(FocusEndToEndCLI.run(Array(arguments.dropFirst())))
case "focus-enforce":
    exit(FocusEnforceCLI.run(Array(arguments.dropFirst())))
case "focus-synthesize":
    exit(FocusSynthesizeCLI.run(Array(arguments.dropFirst())))
case "focus-experiment":
    exit(FocusExperimentCLI.run(Array(arguments.dropFirst())))
case "focus-events":
    exit(FocusEventsCLI.run(Array(arguments.dropFirst())))
case "focus-raise-isolate":
    exit(FocusRaiseIsolateCLI.run(Array(arguments.dropFirst())))
default:
    break
}

let env = ProcessInfo.processInfo.environment
let socketPath = arguments.first
    ?? env[WirePaths.socketPathEnvKey]
    ?? (NSTemporaryDirectory() + "operon-computer-use.sock")

// The startup token for operon's own authentication. ComputerUseService injects it through the
// process env; unset means authentication is disabled. The literal must match CU_AUTH_TOKEN_ENV
// in ComputerUseService.ts.
let expectedToken = env["OPERON_CU_AUTH_TOKEN"].flatMap { $0.isEmpty ? nil : $0 }

let server = UnixSocketServer(path: socketPath, router: WireRouter(), expectedToken: expectedToken)
do {
    try server.run()
} catch {
    FileHandle.standardError.write(Data("[operon-cu] fatal: \(error)\n".utf8))
    exit(1)
}
