import AppKit
import Foundation

/// Watches which application is really frontmost.
///
/// The enforcer needs this to tell "the target genuinely is active" from "the
/// target only believes it is". Those two cases need different handling and
/// conflating them is what makes an implementation either send redundant events
/// forever or stop sending them when it still should.
///
/// Backed by `NSWorkspace.didActivateApplicationNotification`, so the host must
/// be running a run loop. A caller that never pumps its run loop will see a
/// frozen value — the same trap that made the first focus probe report success
/// unconditionally.
public final class SystemFrontmostApplicationTracker {
    public final class Observer: Hashable {
        fileprivate let handler: (NSRunningApplication) -> Void

        fileprivate init(handler: @escaping (NSRunningApplication) -> Void) {
            self.handler = handler
        }

        public static func == (
            lhs: Observer,
            rhs: Observer
        ) -> Bool {
            lhs === rhs
        }

        public func hash(into hasher: inout Hasher) {
            hasher.combine(ObjectIdentifier(self))
        }
    }

    public let excludeCurrentApp: Bool

    private let lock = NSLock()
    private var observers: [Observer] = []
    private var notificationObserver: NSObjectProtocol?

    public init(excludeCurrentApp: Bool = false) {
        self.excludeCurrentApp = excludeCurrentApp
        notificationObserver = NSWorkspace.shared.notificationCenter.addObserver(
            forName: NSWorkspace.didActivateApplicationNotification,
            object: nil,
            queue: nil
        ) { [weak self] notification in
            guard let self,
                  let application = notification.userInfo?[
                      NSWorkspace.applicationUserInfoKey
                  ] as? NSRunningApplication
            else {
                return
            }
            if excludeCurrentApp,
               application.processIdentifier == ProcessInfo.processInfo.processIdentifier {
                return
            }
            for observer in self.currentObservers {
                observer.handler(application)
            }
        }
    }

    deinit {
        if let notificationObserver {
            NSWorkspace.shared.notificationCenter.removeObserver(notificationObserver)
        }
    }

    public var frontmostApp: NSRunningApplication? {
        NSWorkspace.shared.frontmostApplication
    }

    public func isFrontmost(pid: pid_t) -> Bool {
        frontmostApp?.processIdentifier == pid
    }

    @discardableResult
    public func addObserver(
        _ handler: @escaping (NSRunningApplication) -> Void
    ) -> Observer {
        let observer = Observer(handler: handler)
        lock.withLock { observers.append(observer) }
        return observer
    }

    public func removeObserver(_ observer: Observer) {
        lock.withLock { observers.removeAll { $0 === observer } }
    }

    private var currentObservers: [Observer] {
        lock.withLock { observers }
    }
}
