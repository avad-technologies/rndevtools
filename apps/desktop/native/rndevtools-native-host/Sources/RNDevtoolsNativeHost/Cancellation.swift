import Foundation

protocol CancellationChecking: Sendable {
  func check() throws
}

struct NeverCancelled: CancellationChecking {
  func check() throws {}
}

final class CancellationToken: CancellationChecking, @unchecked Sendable {
  private let lock = NSLock()
  private var cancelled = false

  func cancel() {
    lock.lock()
    cancelled = true
    lock.unlock()
  }

  func check() throws {
    lock.lock()
    let isCancelled = cancelled
    lock.unlock()
    if isCancelled {
      throw NativeHostError(
        code: "cancelled",
        message: "The native-host operation was cancelled before its atomic commit.",
        retryable: true
      )
    }
  }
}
