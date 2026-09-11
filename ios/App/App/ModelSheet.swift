import SwiftUI
import UIKit

/// Model picker as a system sheet: a search field, then one card per model
/// group (provider logo + group name as the card's first row, models below,
/// the selected one checked). Mirrors the web `ModelSelectorPanel` list.
struct ModelSheetModel: Identifiable {
    let id: String
    let label: String
    let group: String
    /// Imageset name in `ProviderLogos`.
    let logo: String?
}

struct ModelSheetView: View {
    let title: String
    let searchPlaceholder: String
    let emptyText: String
    let models: [ModelSheetModel]
    let selectedId: String?
    let onPick: (String) -> Void

    @State private var query = ""

    private var groups: [(name: String, logo: String?, items: [ModelSheetModel])] {
        let q = query.trimmingCharacters(in: .whitespaces).lowercased()
        let filtered = q.isEmpty ? models : models.filter {
            $0.label.lowercased().contains(q) || $0.id.lowercased().contains(q)
        }
        var order: [String] = []
        var byGroup: [String: [ModelSheetModel]] = [:]
        for model in filtered {
            if byGroup[model.group] == nil { order.append(model.group) }
            byGroup[model.group, default: []].append(model)
        }
        return order.map { (name: $0, logo: byGroup[$0]?.first?.logo, items: byGroup[$0] ?? []) }
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                Text(title)
                    .font(.title3.weight(.semibold))
                    .padding(.horizontal, 4)
                    .padding(.top, 4)

                HStack(spacing: 8) {
                    Image(systemName: "magnifyingglass")
                        .foregroundStyle(.secondary)
                    TextField(searchPlaceholder, text: $query)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                }
                .padding(.horizontal, 12)
                .padding(.vertical, 9)
                .background(Color(.tertiarySystemFill), in: RoundedRectangle(cornerRadius: 10, style: .continuous))

                if groups.isEmpty {
                    Text(emptyText)
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 28)
                } else {
                    ForEach(groups, id: \.name) { group in
                        VStack(spacing: 0) {
                            HStack(spacing: 12) {
                                ProviderLogoTile(name: group.logo)
                                Text(group.name)
                                    .font(.body.weight(.semibold))
                                    .foregroundStyle(.primary)
                                    .lineLimit(1)
                                Spacer(minLength: 0)
                            }
                            .padding(.horizontal, 14)
                            .padding(.vertical, 11)

                            ForEach(group.items) { model in
                                let active = model.id == selectedId
                                Divider().padding(.leading, 54)
                                Button { onPick(model.id) } label: {
                                    HStack(spacing: 12) {
                                        Text(model.label)
                                            .font(.body)
                                            .foregroundStyle(active ? Color.primary : Color.secondary)
                                            .lineLimit(1)
                                        Spacer(minLength: 0)
                                        if active {
                                            Image(systemName: "checkmark")
                                                .font(.system(size: 13, weight: .bold))
                                                .foregroundStyle(brand)
                                        }
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
                }
            }
            .padding(.horizontal, 16)
            .padding(.top, 20)
            .padding(.bottom, 16)
        }
        .background(Color(.systemGroupedBackground))
    }
}

/// A provider logo on a quiet tile; a blank tile when the name is unknown.
struct ProviderLogoTile: View {
    let name: String?

    var body: some View {
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

extension ModelSheetView {
    static func present(
        from presenter: UIViewController,
        title: String,
        searchPlaceholder: String,
        emptyText: String,
        models: [ModelSheetModel],
        selectedId: String?,
        onPick: @escaping (String) -> Void,
        onDismiss: @escaping () -> Void
    ) {
        let dismisser = SheetDismisser()
        let view = ModelSheetView(title: title, searchPlaceholder: searchPlaceholder, emptyText: emptyText, models: models, selectedId: selectedId) { id in
            onPick(id)
            dismisser.dismiss()
        }
        let groupCount = Set(models.map(\.group)).count
        let height = NativeSheet.titleHeight + 40 + 12 + CGFloat(models.count + groupCount) * NativeSheet.rowHeight
            + CGFloat(max(groupCount - 1, 0)) * 12 + (models.isEmpty ? 76 : 0)
        NativeSheet.present(from: presenter, content: view, contentHeight: height, dismisser: dismisser, onDismiss: onDismiss)
    }
}
