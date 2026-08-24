// swift-tools-version: 6.2
import PackageDescription

// operon Computer Use — the codex-compatible implementation behind the mac Window(v1) path.
//
//   OperonComputerUseWire   : the codex-compatible wire contract (framing / JSON-RPC / action
//                             Codable, §11).
//   OpenComputerUseKit      : vendored from iFurySt/open-codex-computer-use (MIT; see
//                             vendor/…/NOTICE.md).
//   OperonComputerUseServer : the socket server plus the bridge mapping codex requestType onto
//                             the engine dispatcher.
//   operon-computer-use     : the executable entrypoint (the Unix domain socket service).
let package = Package(
    name: "OperonComputerUse",
    platforms: [
        .macOS(.v14),
    ],
    products: [
        .library(name: "OperonComputerUseWire", targets: ["OperonComputerUseWire"]),
        .library(name: "OpenComputerUseKit", targets: ["OpenComputerUseKit"]),
        .library(name: "OperonComputerUseServer", targets: ["OperonComputerUseServer"]),
        .library(name: "OperonSystemSoftware", targets: ["OperonSystemSoftware"]),
        .library(name: "OperonAccessibilitySupport", targets: ["OperonAccessibilitySupport"]),
        .library(name: "OperonFocusProbe", targets: ["OperonFocusProbe"]),
        .executable(name: "operon-computer-use", targets: ["operon-computer-use"]),
        .executable(name: "operon-cua-appkit-fixture", targets: ["operon-cua-appkit-fixture"]),
    ],
    targets: [
        .target(name: "OperonComputerUseWire"),
        .target(name: "OperonSystemSoftware"),
        .target(
            name: "OperonAccessibilitySupport",
            dependencies: ["OperonSystemSoftware"]
        ),
        .target(
            name: "OpenComputerUseKit",
            dependencies: ["OperonAccessibilitySupport"],
            path: "vendor/OpenComputerUseKit/Sources"
        ),
        .target(
            name: "OperonComputerUseServer",
            dependencies: [
                "OperonComputerUseWire",
                "OpenComputerUseKit",
                "OperonAccessibilitySupport",
            ],
            // Security: PeerAuth.swift uses SecCode to read the codesign identity from the peer's
            // audit token.
            linkerSettings: [.linkedFramework("Security")]
        ),
        .target(
            name: "OperonFocusProbe",
            dependencies: [
                "OperonSystemSoftware",
                "OperonAccessibilitySupport",
                // Diagnostics need to drive the real engine path, not a
                // reimplementation of it — that is the only way a reproduction
                // means anything.
                "OperonComputerUseServer",
                "OpenComputerUseKit",
            ]
        ),
        .executableTarget(
            name: "operon-computer-use",
            dependencies: ["OperonComputerUseServer", "OperonComputerUseWire", "OperonFocusProbe"]
        ),
        .executableTarget(name: "operon-cua-appkit-fixture"),
        .testTarget(
            name: "OperonComputerUseWireTests",
            dependencies: ["OperonComputerUseWire"]
        ),
        .testTarget(
            name: "OperonFocusProbeTests",
            dependencies: ["OperonFocusProbe"]
        ),
        .testTarget(
            name: "OperonSystemSoftwareTests",
            dependencies: ["OperonSystemSoftware"]
        ),
        .testTarget(
            name: "OperonAccessibilitySupportTests",
            dependencies: ["OperonAccessibilitySupport", "OperonSystemSoftware"]
        ),
        .testTarget(
            name: "OperonComputerUseServerTests",
            dependencies: ["OperonComputerUseServer", "OperonComputerUseWire", "OpenComputerUseKit"]
        ),
    ]
)
