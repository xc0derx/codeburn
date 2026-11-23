/// Shared session-count phrasing. Keep in lockstep with `src/session-count-label.ts`.
enum SessionCountLabel {
    static var help: String { L("Older session logs may be unavailable.") }
    /// Combined-scope counts are a per-device sum: devices keep separate session
    /// logs, so it is exact unless one device's logs are synced to another.
    static var combinedHelp: String { L("Summed across devices. A session synced to more than one device counts once per device.") }
    static var combinedText: String { L("Session count unavailable") }

    static func isExact(_ basis: String?) -> Bool {
        basis == "identity"
    }

    static func text(sessions: Int, basis: String?) -> String {
        if !isExact(basis) {
            if sessions <= 0 { return combinedText }
            return sessions == 1 ? L("At least 1 session") : L("At least %lld sessions", sessions)
        }
        return sessions == 1 ? L("1 session") : L("%lld sessions", sessions)
    }

    static func compact(sessions: Int, basis: String?) -> String {
        if !isExact(basis) {
            if sessions <= 0 { return L("Unavailable") }
            return L("≥%lld sess", sessions)
        }
        return L("%lld sess", sessions)
    }

    static func averageText(_ value: Double?, basis: String?, format: (Double) -> String) -> String {
        guard isExact(basis), let value, value.isFinite else { return "—" }
        return format(value)
    }

    static func helpText(combined: Bool, basis: String?) -> String {
        if combined { return isExact(basis) ? combinedHelp : "\(combinedHelp)\n\(help)" }
        return isExact(basis) ? "" : help
    }
}
