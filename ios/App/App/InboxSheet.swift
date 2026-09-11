import SwiftUI
import UIKit

/// The notification inbox as a system sheet. Unlike the other sheets this one
/// is live: JS pushes a fresh `InboxSheetState` on every store change while
/// the sheet is up (`updateInboxSheet`), and every control here is a plain
/// intent sent back (`inboxAction`) — the store stays the single owner.
struct InboxSheetItem: Identifiable {
    let id: Int
    let title: String
    let body: String?
    /// Already relative ("3m", "2d"), formatted by JS.
    let time: String
    /// Notification kind → SF Symbol.
    let symbol: String
    let action: Bool
    let unread: Bool
}

struct InboxSheetState {
    let filter: String
    let items: [InboxSheetItem]
    let loading: Bool
    let loadingMore: Bool
    let hasMore: Bool
    let unreadCount: Int
}

struct InboxSheetLabels {
    let title: String
    let filters: [(id: String, label: String)]
    let markAllRead: String
    let empty: String
    let loading: String
    let loadMore: String
}

final class InboxSheetModel: ObservableObject {
    @Published var state: InboxSheetState
    init(state: InboxSheetState) { self.state = state }
}

struct InboxSheetView: View {
    let labels: InboxSheetLabels
    @ObservedObject var model: InboxSheetModel
    /// `("open", id)`, `("archive", id)`, `("markAllRead", nil)`, `("filter", filterId)`, `("loadMore", nil)`
    let onAction: (String, String?) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .firstTextBaseline) {
                Text(labels.title)
                    .font(.title3.weight(.semibold))
                Spacer()
                Button {
                    onAction("markAllRead", nil)
                } label: {
                    Label(labels.markAllRead, systemImage: "checkmark.circle")
                        .font(.footnote)
                }
                .disabled(model.state.unreadCount == 0)
                .tint(brand)
            }
            .padding(.horizontal, 20)
            .padding(.top, 24)

            Picker("", selection: Binding(
                get: { model.state.filter },
                set: { onAction("filter", $0) }
            )) {
                ForEach(labels.filters, id: \.id) { filter in
                    Text(filter.label).tag(filter.id)
                }
            }
            .pickerStyle(.segmented)
            .padding(.horizontal, 16)

            list
        }
        .background(Color(.systemGroupedBackground))
    }

    @ViewBuilder
    private var list: some View {
        let state = model.state
        if state.loading && state.items.isEmpty {
            Text(labels.loading)
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else if state.items.isEmpty && !state.hasMore {
            VStack(spacing: 8) {
                Image(systemName: "tray")
                    .font(.title2)
                    .foregroundStyle(.tertiary)
                Text(labels.empty)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else {
            List {
                ForEach(state.items) { item in
                    Button { onAction("open", String(item.id)) } label: {
                        HStack(alignment: .top, spacing: 12) {
                            Image(systemName: item.symbol)
                                .font(.system(size: 15, weight: .medium))
                                .foregroundStyle(item.action ? Color.orange : Color.secondary)
                                .frame(width: 20)
                                .padding(.top, 2)
                            VStack(alignment: .leading, spacing: 2) {
                                HStack(spacing: 6) {
                                    if item.unread {
                                        Circle()
                                            .fill(item.action ? Color.orange : brand)
                                            .frame(width: 6, height: 6)
                                    }
                                    Text(item.title)
                                        .font(item.unread ? .subheadline.weight(.medium) : .subheadline)
                                        .foregroundStyle(item.unread ? Color.primary : Color.secondary)
                                        .lineLimit(1)
                                }
                                if let body = item.body, !body.isEmpty {
                                    Text(body)
                                        .font(.footnote)
                                        .foregroundStyle(.secondary)
                                        .lineLimit(2)
                                }
                            }
                            Spacer(minLength: 8)
                            Text(item.time)
                                .font(.caption)
                                .foregroundStyle(.tertiary)
                                .monospacedDigit()
                                .padding(.top, 2)
                        }
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .listRowBackground(Color(.secondarySystemGroupedBackground))
                    .swipeActions(edge: .trailing, allowsFullSwipe: true) {
                        Button(role: .destructive) { onAction("archive", String(item.id)) } label: {
                            Label("Dismiss", systemImage: "xmark")
                        }
                    }
                    .onAppear {
                        if item.id == state.items.last?.id, state.hasMore, !state.loadingMore {
                            onAction("loadMore", nil)
                        }
                    }
                }
                if state.hasMore {
                    HStack {
                        Spacer()
                        if state.loadingMore {
                            ProgressView()
                        } else {
                            Button(labels.loadMore) { onAction("loadMore", nil) }
                                .font(.footnote)
                                .tint(brand)
                        }
                        Spacer()
                    }
                    .listRowBackground(Color.clear)
                }
            }
            .listStyle(.insetGrouped)
            .modifier(HiddenScrollBackground())
        }
    }
}

/// `scrollContentBackground(.hidden)` is iOS 16+; below that the list keeps
/// the grouped background, which is the same color anyway.
private struct HiddenScrollBackground: ViewModifier {
    func body(content: Content) -> some View {
        if #available(iOS 16.0, *) {
            content.scrollContentBackground(.hidden)
        } else {
            content
        }
    }
}

extension InboxSheetView {
    /// Returns the model so the plugin can push updates and dismiss.
    @discardableResult
    static func present(
        from presenter: UIViewController,
        labels: InboxSheetLabels,
        state: InboxSheetState,
        onAction: @escaping (String, String?) -> Void,
        onDismiss: @escaping () -> Void
    ) -> (model: InboxSheetModel, dismisser: SheetDismisser) {
        let model = InboxSheetModel(state: state)
        let dismisser = SheetDismisser()
        let view = InboxSheetView(labels: labels, model: model, onAction: onAction)
        // A feed, not a menu: open tall, expandable to full.
        NativeSheet.present(from: presenter, content: view, contentHeight: 10_000, dismisser: dismisser, onDismiss: onDismiss)
        return (model, dismisser)
    }
}
