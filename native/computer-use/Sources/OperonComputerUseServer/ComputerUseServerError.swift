import Foundation

protocol ComputerUseJSONRPCError: Error {
    var jsonRPCCode: Int { get }
    var message: String { get }
}

enum ComputerUseSessionError: ComputerUseJSONRPCError, LocalizedError, CustomStringConvertible {
    case stoppedByUser
    case userIntervened(String)
    case screenLocked

    var jsonRPCCode: Int {
        switch self {
        case .stoppedByUser:
            return -10012
        case .userIntervened:
            return -10016
        case .screenLocked:
            return -10020
        }
    }

    var message: String {
        switch self {
        case .stoppedByUser:
            return "This application session has been explicitly stopped by the user for this turn. Stop your work and send a final message noting they stopped the session and you're ready to continue if they want you to. Computer Use can be used again in the next assistant turn."
        case .userIntervened(let message):
            return message
        case .screenLocked:
            return "Computer Use is unavailable while the Mac is locked. Ask the user to unlock the Mac, then try again."
        }
    }

    var errorDescription: String? { message }
    var description: String { message }
}

struct JSONRPCErrorDescriptor: Equatable {
    let code: Int
    let message: String
}

func jsonRPCErrorDescriptor(for error: Error) -> JSONRPCErrorDescriptor {
    if let coded = error as? ComputerUseJSONRPCError {
        return JSONRPCErrorDescriptor(code: coded.jsonRPCCode, message: coded.message)
    }
    return JSONRPCErrorDescriptor(code: -32000, message: String(describing: error))
}
