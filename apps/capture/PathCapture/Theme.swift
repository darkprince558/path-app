import SwiftUI
import UIKit

// Not 404 design tokens, mirrored from apps/web/DESIGN.md and apps/web/src/index.css.
// Contrast rules carry over from the web: coral is a fill only (never text, never white
// on coral). Coral buttons use ink text, coral-flavored text uses rust, and every 3D or
// camera view sits on night.
enum Brand {
  static let paper = Color(hex: 0xF3EBD0)
  static let surface = Color(hex: 0xFAF5E6)
  static let forest = Color(hex: 0x2F4A3A)
  static let coral = Color(hex: 0xF48057)
  static let rust = Color(hex: 0xA8421F)
  static let night = Color(hex: 0x121C16)
  static let sage = Color(hex: 0xA9C4AE)
  static let ink = Color(hex: 0x15221B)
  static let muted = Color(hex: 0x5E6B60)

  /// Page background: paper in light mode, night in dark mode.
  static let page = Color(light: 0xF3EBD0, dark: 0x121C16)
  /// Cards and sheets on top of the page.
  static let card = Color(light: 0xFAF5E6, dark: 0x1C2A22)
  /// Body text and headings: forest on paper (8.1:1), paper on night.
  static let text = Color(light: 0x2F4A3A, dark: 0xF3EBD0)
  /// Secondary text: muted on paper (4.7:1), soft sage on night.
  static let secondaryText = Color(light: 0x5E6B60, dark: 0x9DB4A3)
  /// Primary controls and active states: forest, or sage in dark mode.
  static let primary = Color(light: 0x2F4A3A, dark: 0xA9C4AE)
  /// Text on a primary control.
  static let onPrimary = Color(light: 0xF3EBD0, dark: 0x121C16)
  /// Coral-flavored text: rust on paper (5.1:1), coral on night (6.7:1).
  static let accentText = Color(light: 0xA8421F, dark: 0xF48057)
  /// Night panels (hero, 3D) lift slightly off a night page in dark mode.
  static let nightPanel = Color(light: 0x121C16, dark: 0x1A2720)
  static let hairline = Color(light: 0x2F4A3A, dark: 0xF3EBD0).opacity(0.12)
}

extension Color {
  init(hex: UInt32, opacity: Double = 1) {
    self.init(
      .sRGB, red: Double((hex >> 16) & 0xFF) / 255, green: Double((hex >> 8) & 0xFF) / 255,
      blue: Double(hex & 0xFF) / 255, opacity: opacity)
  }
  init(light: UInt32, dark: UInt32) {
    self.init(
      UIColor { traits in
        let hex = traits.userInterfaceStyle == .dark ? dark : light
        return UIColor(
          red: CGFloat((hex >> 16) & 0xFF) / 255, green: CGFloat((hex >> 8) & 0xFF) / 255,
          blue: CGFloat(hex & 0xFF) / 255, alpha: 1)
      })
  }
}

extension Font {
  /// Heavy display type for titles, standing in for Overpass. Scales with Dynamic Type.
  static func display(_ style: Font.TextStyle) -> Font {
    .system(style, design: .default, weight: .heavy)
  }
  /// Monospaced type for counts, durations and IDs, standing in for Atkinson Hyperlegible Mono.
  static func data(_ style: Font.TextStyle, weight: Font.Weight = .medium) -> Font {
    .system(style, design: .monospaced, weight: weight)
  }
}

// MARK: - Buttons

struct BrandButtonStyle: ButtonStyle {
  enum Kind { case coral, primary, quiet }
  var kind: Kind
  var fullWidth = true
  @Environment(\.isEnabled) private var enabled

  func makeBody(configuration: Configuration) -> some View {
    configuration.label
      .font(.headline)
      .labelStyle(BrandButtonLabelStyle())
      .foregroundStyle(foreground)
      .padding(.horizontal, 18)
      .frame(maxWidth: fullWidth ? .infinity : nil, minHeight: 52)
      .background(background, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
      .overlay {
        if kind == .quiet {
          RoundedRectangle(cornerRadius: 16, style: .continuous).strokeBorder(Brand.hairline)
        }
      }
      .contentShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
      .opacity(enabled ? 1 : 0.45)
      .scaleEffect(configuration.isPressed ? 0.97 : 1)
      .brightness(configuration.isPressed ? -0.04 : 0)
      .animation(.spring(response: 0.25, dampingFraction: 0.7), value: configuration.isPressed)
  }
  private var foreground: Color {
    switch kind {
    case .coral: Brand.ink
    case .primary: Brand.onPrimary
    case .quiet: Brand.text
    }
  }
  private var background: Color {
    switch kind {
    case .coral: Brand.coral
    case .primary: Brand.primary
    case .quiet: Brand.card
    }
  }
}

private struct BrandButtonLabelStyle: LabelStyle {
  func makeBody(configuration: Configuration) -> some View {
    HStack(spacing: 8) {
      configuration.icon.imageScale(.medium)
      configuration.title
    }
  }
}

extension ButtonStyle where Self == BrandButtonStyle {
  static var coral: BrandButtonStyle { BrandButtonStyle(kind: .coral) }
  static var brandPrimary: BrandButtonStyle { BrandButtonStyle(kind: .primary) }
  static var quiet: BrandButtonStyle { BrandButtonStyle(kind: .quiet) }
}

// MARK: - Surfaces

extension View {
  /// A rounded card on the page background.
  func card(padding: CGFloat = 18) -> some View {
    self.padding(padding)
      .frame(maxWidth: .infinity, alignment: .leading)
      .background(Brand.card, in: RoundedRectangle(cornerRadius: 22, style: .continuous))
      .overlay(RoundedRectangle(cornerRadius: 22, style: .continuous).strokeBorder(Brand.hairline))
  }
}

/// A small capsule label, such as a capture mode or a "Shared" badge.
struct Chip: View {
  let text: String
  var systemImage: String?
  var tint: Color = Brand.primary
  var body: some View {
    HStack(spacing: 5) {
      if let systemImage { Image(systemName: systemImage).imageScale(.small) }
      Text(text)
    }
    .font(.caption.weight(.semibold))
    .foregroundStyle(tint)
    .padding(.horizontal, 10)
    .padding(.vertical, 5)
    .background(tint.opacity(0.14), in: Capsule())
  }
}

/// A heading above a group of cards.
struct SectionHeading: View {
  let title: String
  var detail: String?
  var body: some View {
    HStack(alignment: .firstTextBaseline) {
      Text(title).font(.display(.title3)).foregroundStyle(Brand.text)
      Spacer()
      if let detail { Text(detail).font(.data(.subheadline)).foregroundStyle(Brand.secondaryText) }
    }
    .accessibilityElement(children: .combine)
    .accessibilityAddTraits(.isHeader)
  }
}

// MARK: - Brand mark

/// The coral "you are here" ring: the 0 in the not404 logo and the favicon.
struct PinZero: View {
  var color: Color = Brand.coral
  var body: some View {
    GeometryReader { geo in
      let side = min(geo.size.width, geo.size.height)
      ZStack {
        Circle().strokeBorder(color, lineWidth: side * 0.19)
        Circle().fill(color).frame(width: side * 0.26, height: side * 0.26)
      }
      .frame(width: side, height: side)
      .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
    .aspectRatio(1, contentMode: .fit)
    .accessibilityHidden(true)
  }
}

/// The not404 wordmark. Screen readers hear "Not 404".
struct Wordmark: View {
  var size: CGFloat = 22
  var body: some View {
    HStack(spacing: size * 0.04) {
      Text("not4")
      PinZero().frame(width: size * 0.74, height: size * 0.74)
      Text("4")
    }
    .font(.system(size: size, weight: .black))
    .tracking(-0.5)
    .foregroundStyle(Brand.text)
    .accessibilityElement(children: .ignore)
    .accessibilityLabel("Not 404")
  }
}

// MARK: - Formatting

extension ScanRecord {
  /// "Today, 3:42 PM", "Yesterday, 9:10 AM" or "Nov 18, 3:42 PM".
  var title: String {
    let time = created.formatted(date: .omitted, time: .shortened)
    let calendar = Calendar.current
    if calendar.isDateInToday(created) { return "Today, " + time }
    if calendar.isDateInYesterday(created) { return "Yesterday, " + time }
    return created.formatted(.dateTime.month(.abbreviated).day()) + ", " + time
  }
  var durationText: String {
    Duration.seconds(duration.rounded()).formatted(.time(pattern: .minuteSecond))
  }
  var modeSymbol: String {
    if triangles > 0 { return "cube.transparent" }
    if pointCount > 0 { return "circle.grid.3x3" }
    return "video"
  }
  var isShared: Bool { guestURL != nil || videoGuestURL != nil || hostedLinks?.isEmpty == false }
}
