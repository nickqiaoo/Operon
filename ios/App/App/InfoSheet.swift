import SwiftUI
import UIKit

/// Read-only stats as a system sheet — the context-window breakdown and the
/// Claude subscription quotas both render through this. One card per
/// section: an optional header line (label + value) with a progress bar, then
/// plain rows (label / value / percent, an optional color swatch), then an
/// optional footer line.
struct InfoSheetSection: Identifiable {
    struct Row: Identifiable {
        let id = UUID()
        let label: String
        let value: String?
        let detail: String?
        /// `#rrggbb`, drawn as a swatch before the label.
        let color: String?
        let indent: Bool
    }
    enum Tone: String { case normal, warn, error }
    /// Bar fill level, separate from `tone` so a bar can go green → orange → red
    /// while its label stays quiet until the limit is close.
    enum BarTone: String { case ok, warn, error }

    let id = UUID()
    let header: String?
    let value: String?
    /// 0…1
    let progress: Double?
    let tone: Tone
    /// nil: the bar follows `tone`.
    let barTone: BarTone?
    let footer: String?
    let rows: [Row]
}

struct InfoSheetView: View {
    let title: String
    let caption: String?
    let sections: [InfoSheetSection]

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(title)
                        .font(.title3.weight(.semibold))
                    if let caption {
                        Text(caption)
                            .font(.caption.weight(.medium))
                            .foregroundStyle(.secondary)
                            .textCase(.uppercase)
                    }
                }
                .padding(.horizontal, 4)
                .padding(.top, 4)

                ForEach(sections) { section in
                    VStack(alignment: .leading, spacing: 8) {
                        if section.header != nil || section.value != nil {
                            HStack(alignment: .firstTextBaseline) {
                                Text(section.header ?? "")
                                    .font(.subheadline.weight(.medium))
                                Spacer(minLength: 8)
                                if let value = section.value {
                                    Text(value)
                                        .font(.system(.footnote, design: .monospaced))
                                        .foregroundStyle(tint(for: section))
                                }
                            }
                        }
                        if let progress = section.progress {
                            ProgressView(value: min(max(progress, 0), 1))
                                .tint(barTint(for: section))
                        }
                        if !section.rows.isEmpty {
                            VStack(spacing: 6) {
                                ForEach(section.rows) { row in
                                    HStack(spacing: 8) {
                                        if let hex = row.color, let color = Color(hex: hex) {
                                            RoundedRectangle(cornerRadius: 2).fill(color).frame(width: 8, height: 8)
                                        }
                                        Text(row.label)
                                            .font(.footnote)
                                            .foregroundStyle(row.indent ? Color.secondary.opacity(0.8) : Color.secondary)
                                            .padding(.leading, row.indent ? 12 : 0)
                                            .lineLimit(1)
                                        Spacer(minLength: 8)
                                        if let value = row.value {
                                            Text(value)
                                                .font(.system(.footnote, design: .monospaced))
                                                .foregroundStyle(row.indent ? Color.secondary : Color.primary)
                                        }
                                        if let detail = row.detail {
                                            Text(detail)
                                                .font(.system(.footnote, design: .monospaced))
                                                .foregroundStyle(.secondary)
                                                .frame(minWidth: 44, alignment: .trailing)
                                        }
                                    }
                                }
                            }
                            .padding(.top, section.header == nil && section.progress == nil ? 0 : 2)
                        }
                        if let footer = section.footer {
                            HStack {
                                Spacer()
                                Text(footer)
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                        }
                    }
                    .padding(.horizontal, 14)
                    .padding(.vertical, 12)
                    .background(Color(.secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                }
            }
            .padding(.horizontal, 16)
            .padding(.top, 20)
            .padding(.bottom, 16)
        }
        .background(Color(.systemGroupedBackground))
    }

    private func tint(for section: InfoSheetSection) -> Color {
        switch section.tone {
        case .normal: return .primary
        case .warn: return .orange
        case .error: return .red
        }
    }

    private func barTint(for section: InfoSheetSection) -> Color {
        if let barTone = section.barTone {
            switch barTone {
            case .ok: return fillOk
            case .warn: return fillWarn
            case .error: return fillError
            }
        }
        switch section.tone {
        case .normal: return brand
        case .warn: return .orange
        case .error: return .red
        }
    }
}

/// Fill tokens from globals.css (light / dark): `--color-accent-green`,
/// `--color-accent-warm`, `--color-destructive` — the colors the web bars use.
private func dynamicFill(light: UInt32, dark: UInt32) -> Color {
    func color(_ hex: UInt32) -> UIColor {
        UIColor(red: CGFloat((hex >> 16) & 0xFF) / 255,
                green: CGFloat((hex >> 8) & 0xFF) / 255,
                blue: CGFloat(hex & 0xFF) / 255,
                alpha: 1)
    }
    return Color(UIColor { trait in trait.userInterfaceStyle == .dark ? color(dark) : color(light) })
}

private let fillOk = dynamicFill(light: 0x3DB87A, dark: 0x4FCC8E)
private let fillWarn = dynamicFill(light: 0xE5845C, dark: 0xF09570)
private let fillError = dynamicFill(light: 0xEF4444, dark: 0x991B1B)

extension Color {
    /// `#rrggbb` / `#rgb`; nil for anything else (CSS variables, hsl()…).
    init?(hex: String) {
        var s = hex.trimmingCharacters(in: .whitespaces)
        guard s.hasPrefix("#") else { return nil }
        s.removeFirst()
        if s.count == 3 { s = s.map { "\($0)\($0)" }.joined() }
        guard s.count == 6, let v = UInt32(s, radix: 16) else { return nil }
        self.init(
            red: Double((v >> 16) & 0xFF) / 255,
            green: Double((v >> 8) & 0xFF) / 255,
            blue: Double(v & 0xFF) / 255
        )
    }
}

extension InfoSheetView {
    static func present(from presenter: UIViewController, title: String, caption: String?, sections: [InfoSheetSection], onDismiss: @escaping () -> Void) {
        let view = InfoSheetView(title: title, caption: caption, sections: sections)
        let height: CGFloat = NativeSheet.titleHeight + (caption == nil ? 0 : 18) + sections.reduce(0) { acc, s in
            acc + 24 + (s.header != nil || s.value != nil ? 22 : 0) + (s.progress != nil ? 12 : 0)
                + CGFloat(s.rows.count) * 24 + (s.footer != nil ? 20 : 0) + 12
        }
        NativeSheet.present(from: presenter, content: view, contentHeight: height, dismisser: SheetDismisser(), onDismiss: onDismiss)
    }
}
