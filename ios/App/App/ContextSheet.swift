import SwiftUI
import UIKit

/// The project → workspace picker as a system sheet (`UISheetPresentationController`,
/// sized to its content, grabber; a floating glass card on iOS 26).
///
/// This is the one web bottom sheet redone natively, as the pilot: its content
/// is a plain two-level list with no inputs and no async state, so the SwiftUI
/// copy is small. The web `MobileContextSwitcher` stays for Android and the
/// browser; both write the pick back through the same store action.
///
/// Layout: grouped grey ground, one white card per project. The card's first
/// row is the project (folder glyph on a brand-tinted tile, bold name), the
/// workspaces follow as indented rows; the active one is the only row in
/// primary text and carries a brand-colored check. Deliberately not the stock
/// `List`: with a single project the "Settings" look (section header + one
/// grey inset row on a white ground) had no depth, and `Button` labels came
/// out link-blue.
///
/// Data comes in over the plugin (`presentContextSheet`), the pick goes back
/// as a `contextPicked` event. See `src/lib/native.ts`.
struct ContextSheetProject: Identifiable {
    struct Workspace: Identifiable {
        let id: Int
        let name: String
    }
    let id: Int
    let name: String
    let workspaces: [Workspace]
}

/// `--color-brand` from globals.css (light / dark).
let brand = Color(UIColor { trait in
    trait.userInterfaceStyle == .dark
        ? UIColor(red: 0x8B / 255, green: 0x7D / 255, blue: 0xF0 / 255, alpha: 1)
        : UIColor(red: 0x63 / 255, green: 0x58 / 255, blue: 0xDC / 255, alpha: 1)
})

struct ContextSheetView: View {
    let title: String
    let emptyText: String
    let projects: [ContextSheetProject]
    let activeProjectId: Int?
    let activeWorkspaceId: Int?
    /// `(projectId, workspaceId)`; `workspaceId` is nil for a project with no workspaces.
    let onPick: (Int, Int?) -> Void

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                Text(title)
                    .font(.title3.weight(.semibold))
                    .padding(.horizontal, 4)
                    .padding(.top, 4)

                if projects.isEmpty {
                    Text(emptyText)
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 28)
                } else {
                    ForEach(projects) { project in
                        projectCard(project)
                    }
                }
            }
            .padding(.horizontal, 16)
            .padding(.top, 20)
            .padding(.bottom, 16)
        }
        .background(Color(.systemGroupedBackground))
    }

    private func projectCard(_ project: ContextSheetProject) -> some View {
        VStack(spacing: 0) {
            Button {
                onPick(project.id, project.workspaces.first?.id)
            } label: {
                HStack(spacing: 12) {
                    Image(systemName: "folder.fill")
                        .font(.system(size: 13, weight: .semibold))
                        .foregroundStyle(brand)
                        .frame(width: 28, height: 28)
                        .background(brand.opacity(0.12), in: RoundedRectangle(cornerRadius: 8, style: .continuous))
                    Text(project.name)
                        .font(.body.weight(.semibold))
                        .foregroundStyle(.primary)
                        .lineLimit(1)
                    Spacer(minLength: 0)
                    if project.workspaces.isEmpty, project.id == activeProjectId {
                        check
                    }
                }
                .padding(.horizontal, 14)
                .padding(.vertical, 11)
                .contentShape(Rectangle())
            }
            .buttonStyle(RowButtonStyle())

            ForEach(project.workspaces) { workspace in
                let active = workspace.id == activeWorkspaceId
                Divider().padding(.leading, 54)
                Button {
                    onPick(project.id, workspace.id)
                } label: {
                    HStack(spacing: 12) {
                        Text(workspace.name)
                            .font(.body)
                            .foregroundStyle(active ? Color.primary : Color.secondary)
                            .lineLimit(1)
                        Spacer(minLength: 0)
                        if active { check }
                    }
                    .padding(.leading, 54)
                    .padding(.trailing, 14)
                    .padding(.vertical, 11)
                    .contentShape(Rectangle())
                }
                .buttonStyle(RowButtonStyle())
            }
        }
        .background(Color(.secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
    }

    private var check: some View {
        Image(systemName: "checkmark")
            .font(.system(size: 13, weight: .bold))
            .foregroundStyle(brand)
    }
}

/// Press feedback like a table row: a quiet fill, no link tint.
struct RowButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .background(configuration.isPressed ? Color(.systemFill) : Color.clear)
    }
}

extension ContextSheetView {
    /// Present from `presenter`, sized to the content. `onDismiss` fires
    /// whether the user picked or swiped it away.
    static func present(
        from presenter: UIViewController,
        title: String,
        emptyText: String,
        projects: [ContextSheetProject],
        activeProjectId: Int?,
        activeWorkspaceId: Int?,
        onPick: @escaping (Int, Int?) -> Void,
        onDismiss: @escaping () -> Void
    ) {
        let dismisser = SheetDismisser()
        let view = ContextSheetView(
            title: title,
            emptyText: emptyText,
            projects: projects,
            activeProjectId: activeProjectId,
            activeWorkspaceId: activeWorkspaceId,
            onPick: { projectId, workspaceId in
                onPick(projectId, workspaceId)
                dismisser.dismiss()
            }
        )
        // Title + per-project card (row + workspaces), plus paddings.
        let rows = projects.reduce(0) { $0 + 1 + $1.workspaces.count }
        let height = NativeSheet.titleHeight + CGFloat(rows) * NativeSheet.rowHeight
            + CGFloat(max(projects.count - 1, 0)) * 12 + (projects.isEmpty ? 76 : 0)
        NativeSheet.present(from: presenter, content: view, contentHeight: height, dismisser: dismisser, onDismiss: onDismiss)
    }
}

/// Lets SwiftUI content close the sheet it lives in.
final class SheetDismisser {
    weak var host: UIViewController?
    func dismiss() { host?.dismiss(animated: true) }
}

/// Shared presentation for the native bottom sheets: grouped-grey ground,
/// sized to the content (custom detent on iOS 16+, capped at 60% of the
/// screen; iOS 15 falls back to the medium detent), expandable to full.
enum NativeSheet {
    /// Title block: top padding + title + gap.
    static let titleHeight: CGFloat = 20 + 30 + 12
    /// One card row (label + vertical padding).
    static let rowHeight: CGFloat = 44
    /// Bottom padding + a little slack.
    private static let footer: CGFloat = 16 + 8

    static func present<Content: View>(
        from presenter: UIViewController,
        content: Content,
        contentHeight: CGFloat,
        dismisser: SheetDismisser,
        onDismiss: @escaping () -> Void
    ) {
        let host = SheetHostingController(rootView: AnyView(content))
        host.onDidDismiss = onDismiss
        host.view.backgroundColor = .systemGroupedBackground
        dismisser.host = host
        if let sheet = host.sheetPresentationController {
            if #available(iOS 16.0, *) {
                // The detent value excludes the bottom safe area (measured: a
                // 217pt detent made a 245pt sheet on a 34pt home indicator).
                let estimated = contentHeight + footer
                let fitted = UISheetPresentationController.Detent.custom { context in
                    min(estimated, context.maximumDetentValue * 0.6)
                }
                sheet.detents = [fitted, .large()]
            } else {
                sheet.detents = [.medium(), .large()]
            }
            sheet.prefersGrabberVisible = true
            sheet.prefersScrollingExpandsWhenScrolledToEdge = true
        }
        presenter.present(host, animated: true)
    }
}

/// Reports every way the sheet can go away (pick, swipe, tap outside) once.
private final class SheetHostingController: UIHostingController<AnyView> {
    var onDidDismiss: (() -> Void)?

    override func viewDidDisappear(_ animated: Bool) {
        super.viewDidDisappear(animated)
        if isBeingDismissed || presentingViewController == nil {
            onDidDismiss?()
            onDidDismiss = nil
        }
    }
}
