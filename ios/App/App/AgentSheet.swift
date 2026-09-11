import SwiftUI
import UIKit

/// "New chat" agent picker as a system sheet: one card, one row per agent
/// with its logo. Same layout language as `ContextSheetView`.
///
/// Logos are the `ProviderLogos` imagesets in the asset catalog — the same
/// SVGs the web ships, named by `providerLogoName` on the JS side. All but
/// one are template images, so they take the label color in both themes.
struct AgentSheetAgent: Identifiable {
    let id: String
    let label: String
    /// Imageset name; nil or unknown draws a neutral placeholder tile.
    let logo: String?
}

struct AgentSheetView: View {
    let title: String
    let emptyText: String
    let agents: [AgentSheetAgent]
    let onPick: (String) -> Void

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                Text(title)
                    .font(.title3.weight(.semibold))
                    .padding(.horizontal, 4)
                    .padding(.top, 4)

                if agents.isEmpty {
                    Text(emptyText)
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 28)
                } else {
                    VStack(spacing: 0) {
                        ForEach(Array(agents.enumerated()), id: \.element.id) { index, agent in
                            if index > 0 { Divider().padding(.leading, 54) }
                            Button { onPick(agent.id) } label: {
                                HStack(spacing: 12) {
                                    logo(agent.logo)
                                    Text(agent.label)
                                        .font(.body)
                                        .foregroundStyle(.primary)
                                        .lineLimit(1)
                                    Spacer(minLength: 0)
                                }
                                .padding(.horizontal, 14)
                                .padding(.vertical, 11)
                                .contentShape(Rectangle())
                            }
                            .buttonStyle(RowButtonStyle())
                        }
                    }
                    .background(Color(.secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                }
            }
            .padding(.horizontal, 16)
            .padding(.top, 20)
            .padding(.bottom, 16)
        }
        .background(Color(.systemGroupedBackground))
    }

    @ViewBuilder
    private func logo(_ name: String?) -> some View {
        if let name, let image = UIImage(named: name) {
            Image(uiImage: image)
                .resizable()
                .scaledToFit()
                .frame(width: 18, height: 18)
                .foregroundStyle(.primary)
                .frame(width: 28, height: 28)
                .background(Color(.tertiarySystemFill), in: RoundedRectangle(cornerRadius: 8, style: .continuous))
        } else {
            RoundedRectangle(cornerRadius: 8, style: .continuous)
                .fill(Color(.tertiarySystemFill))
                .frame(width: 28, height: 28)
        }
    }
}

extension AgentSheetView {
    static func present(
        from presenter: UIViewController,
        title: String,
        emptyText: String,
        agents: [AgentSheetAgent],
        onPick: @escaping (String) -> Void,
        onDismiss: @escaping () -> Void
    ) {
        let dismisser = SheetDismisser()
        let view = AgentSheetView(title: title, emptyText: emptyText, agents: agents) { id in
            onPick(id)
            dismisser.dismiss()
        }
        let height = NativeSheet.titleHeight + CGFloat(agents.count) * NativeSheet.rowHeight + (agents.isEmpty ? 76 : 0)
        NativeSheet.present(from: presenter, content: view, contentHeight: height, dismisser: dismisser, onDismiss: onDismiss)
    }
}
