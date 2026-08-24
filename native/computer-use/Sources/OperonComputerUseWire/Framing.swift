import Foundation

/// The frame protocol: a 4-byte little-endian length prefix followed by UTF-8 JSON, 8MB per frame
/// at most. Matches encodeMessageFrame / decodeMessageFrames in @oai/sky's native-pipe.js.
public enum Framing {
    public static let maxFrameBytes = 8 * 1024 * 1024 // 8388608

    public enum Error: Swift.Error, Equatable {
        case frameTooLarge(Int)
    }

    /// payload → [4B LE length][payload]
    public static func encode(_ payload: Data) throws -> Data {
        let n = payload.count
        if n > maxFrameBytes { throw Error.frameTooLarge(n) }
        var out = Data(capacity: 4 + n)
        out.append(UInt8(n & 0xff))
        out.append(UInt8((n >> 8) & 0xff))
        out.append(UInt8((n >> 16) & 0xff))
        out.append(UInt8((n >> 24) & 0xff))
        out.append(payload)
        return out
    }

    /// Cuts every complete frame out of the accumulated buffer and returns the incomplete
    /// remainder.
    public static func decode(_ buffer: Data) throws -> (messages: [Data], remaining: Data) {
        let bytes = [UInt8](buffer)
        var messages: [Data] = []
        var i = 0
        while bytes.count - i >= 4 {
            let len = Int(UInt32(bytes[i])
                | (UInt32(bytes[i + 1]) << 8)
                | (UInt32(bytes[i + 2]) << 16)
                | (UInt32(bytes[i + 3]) << 24))
            if len > maxFrameBytes { throw Error.frameTooLarge(len) }
            let total = 4 + len
            if bytes.count - i < total { break }
            messages.append(Data(bytes[(i + 4)..<(i + total)]))
            i += total
        }
        return (messages, Data(bytes[i...]))
    }
}
