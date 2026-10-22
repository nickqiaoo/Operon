import SwiftUI
import UIKit

/// The project → workspace picker as a system sheet (`UISheetPresentationController`,
/// sized to its content, grabber; a floating glass card on iOS 26).
/// Spec rows select a context; conversations appear on the Chats page.
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
    struct Spec: Identifiable {
        let id: Int
        let name: String
    }
    let workspaces: [Workspace]
    let specs: [Spec]
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
    let activeSpecId: Int?
    /// `(projectId, workspaceId, specId)`; selecting a Spec opens its Chats list.
    let onPick: (Int, Int?, Int?) -> Void

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
                onPick(project.id, project.workspaces.first?.id, nil)
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
                    if activeSpecId == nil, project.workspaces.isEmpty, project.id == activeProjectId {
                        check
                    }
                }
                .padding(.horizontal, 14)
                .padding(.vertical, 11)
                .contentShape(Rectangle())
            }
            .buttonStyle(RowButtonStyle())

            ForEach(project.workspaces) { workspace in
                let active = activeSpecId == nil && workspace.id == activeWorkspaceId
                Divider().padding(.leading, 54)
                Button {
                    onPick(project.id, workspace.id, nil)
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
            ForEach(project.specs) { spec in
                Divider().padding(.leading, 54)
                Button {
                    onPick(project.id, nil, spec.id)
                } label: {
                    HStack(spacing: 10) {
                        Image(systemName: "doc.text")
                            .foregroundStyle(brand)
                        Text(spec.name)
                            .foregroundStyle(.primary)
                            .lineLimit(2)
                        Spacer(minLength: 0)
                        if activeSpecId == spec.id { check }
                    }
                    .padding(.leading, 30)
                    .padding(.trailing, 14)
                    .padding(.vertical, 12)
                    .contentShape(Rectangle())
                }
                .buttonStyle(RowButtonStyle())
                .accessibilityAddTraits(activeSpecId == spec.id ? .isSelected : [])
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
        activeSpecId: Int?,
        onPick: @escaping (Int, Int?, Int?) -> Void,
        onDismiss: @escaping () -> Void
    ) {
        let dismisser = SheetDismisser()
        let view = ContextSheetView(
            title: title,
            emptyText: emptyText,
            projects: projects,
            activeProjectId: activeProjectId,
            activeWorkspaceId: activeWorkspaceId,
            activeSpecId: activeSpecId,
            onPick: { projectId, workspaceId, specId in
                onPick(projectId, workspaceId, specId)
                dismisser.dismiss()
            }
        )
        // Title + per-project card (row + workspaces), plus paddings.
        let rows = projects.reduce(0) { $0 + 1 + $1.workspaces.count + $1.specs.count }
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
