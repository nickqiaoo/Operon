import XCTest
@testable import OperonFocusProbe

private func sampleRecord(
    _ elapsed: Double,
    workspace: pid_t? = nil,
    cps: pid_t? = nil,
    keyFocus: pid_t? = nil,
    topWindow: pid_t? = nil
) -> FocusRecord {
    FocusRecord(
        elapsedMilliseconds: elapsed,
        signature: FocusSignature(
            workspaceFrontPID: workspace,
            cpsFrontPID: cps,
            keyFocusPID: keyFocus,
            topWindowPID: topWindow
        )
    )
}

final class FocusProbeReportTests: XCTestCase {
    func testEpisodesSpanUntilTheNextTransition() {
        let records = [
            sampleRecord(0, workspace: 100),
            sampleRecord(250, workspace: 200),
            sampleRecord(400, workspace: 100),
        ]

        let episodes = FocusProbeReport.episodes(
            in: records,
            totalMilliseconds: 1000,
            field: \.workspaceFrontPID
        )

        XCTAssertEqual(episodes, [
            FocusEpisode(pid: 100, startMilliseconds: 0, endMilliseconds: 250),
            FocusEpisode(pid: 200, startMilliseconds: 250, endMilliseconds: 400),
            FocusEpisode(pid: 100, startMilliseconds: 400, endMilliseconds: 1000),
        ])
    }

    func testEpisodesMergeRecordsThatOnlyChangedAnotherField() {
        let records = [
            sampleRecord(0, workspace: 100, keyFocus: 100),
            sampleRecord(100, workspace: 100, keyFocus: 200),
            sampleRecord(200, workspace: 100, keyFocus: 100),
        ]

        let episodes = FocusProbeReport.episodes(
            in: records,
            totalMilliseconds: 500,
            field: \.workspaceFrontPID
        )

        XCTAssertEqual(episodes, [
            FocusEpisode(pid: 100, startMilliseconds: 0, endMilliseconds: 500),
        ])
    }

    func testEmptyTimelineProducesNoEpisodes() {
        XCTAssertTrue(
            FocusProbeReport.episodes(
                in: [],
                totalMilliseconds: 500,
                field: \.workspaceFrontPID
            ).isEmpty
        )
    }

    // Only workspaceFront and topWindow decide the verdict. The other two
    // fields are recorded for diagnosis and must never affect it — asserted
    // here because an earlier draft of the acceptance criteria wrongly treated
    // a cpsFront move as evidence of success.
    func testVerdictIgnoresFieldsOtherThanTheVisibleForeground() {
        let records = [
            sampleRecord(0, workspace: 100, cps: 100, keyFocus: 100, topWindow: 100),
            sampleRecord(120, workspace: 100, cps: 900, keyFocus: 900, topWindow: 100),
            sampleRecord(480, workspace: 100, cps: 100, keyFocus: 100, topWindow: 100),
        ]

        XCTAssertTrue(
            FocusProbeReport.foreignForegroundEpisodes(
                in: records,
                totalMilliseconds: 900,
                baselinePID: 100
            ).isEmpty
        )
    }

    // A 30 ms blip is the exact failure the probe exists to catch, so it must
    // not be smoothed away by any minimum-duration threshold.
    func testBriefForegroundStealIsReported() {
        let records = [
            sampleRecord(0, workspace: 100, topWindow: 100),
            sampleRecord(200, workspace: 900, topWindow: 900),
            sampleRecord(230, workspace: 100, topWindow: 100),
        ]

        let foreign = FocusProbeReport.foreignForegroundEpisodes(
            in: records,
            totalMilliseconds: 800,
            baselinePID: 100
        )

        XCTAssertEqual(foreign.count, 2, "both workspaceFront and topWindow moved")
        XCTAssertEqual(foreign.first?.pid, 900)
        XCTAssertEqual(foreign.first?.durationMilliseconds, 30)
    }

    func testTopWindowStealIsReportedEvenWhenWorkspaceFrontHolds() {
        let records = [
            sampleRecord(0, workspace: 100, topWindow: 100),
            sampleRecord(300, workspace: 100, topWindow: 900),
            sampleRecord(360, workspace: 100, topWindow: 100),
        ]

        let foreign = FocusProbeReport.foreignForegroundEpisodes(
            in: records,
            totalMilliseconds: 700,
            baselinePID: 100
        )

        XCTAssertEqual(foreign.map { $0.pid }, [900])
    }
}

final class FocusProbeCLIArgumentTests: XCTestCase {
    func testParsesEveryFlag() throws {
        let arguments = try FocusProbeCLI.parse([
            "--interval-ms", "5",
            "--duration", "12",
            "--out", "/tmp/probe.jsonl",
            "--baseline", "4242",
            "--all",
        ])

        XCTAssertEqual(arguments.options.intervalMilliseconds, 5)
        XCTAssertEqual(arguments.options.durationSeconds, 12)
        XCTAssertEqual(arguments.outputPath, "/tmp/probe.jsonl")
        XCTAssertEqual(arguments.baselinePID, 4242)
        XCTAssertTrue(arguments.options.emitEverySample)
    }

    func testDefaultsToTenMillisecondTransitionsOnly() throws {
        let arguments = try FocusProbeCLI.parse([])

        XCTAssertEqual(arguments.options.intervalMilliseconds, 10)
        XCTAssertNil(arguments.options.durationSeconds)
        XCTAssertFalse(arguments.options.emitEverySample)
    }

    func testRejectsUnknownAndMalformedFlags() {
        XCTAssertThrowsError(try FocusProbeCLI.parse(["--nope"]))
        XCTAssertThrowsError(try FocusProbeCLI.parse(["--interval-ms"]))
        XCTAssertThrowsError(try FocusProbeCLI.parse(["--interval-ms", "0"]))
        XCTAssertThrowsError(try FocusProbeCLI.parse(["--baseline", "abc"]))
    }
}
