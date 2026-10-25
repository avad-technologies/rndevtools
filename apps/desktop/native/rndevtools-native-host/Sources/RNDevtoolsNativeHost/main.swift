import Darwin
import Dispatch
import Foundation

let processCancellation = CancellationToken()
let cancellationQueue = DispatchQueue(
  label: "io.github.adalloul0928.rndevtools.native-host.signals")
let cancellationSources = [SIGINT, SIGTERM].map { signalNumber in
  Darwin.signal(signalNumber, SIG_IGN)
  let source = DispatchSource.makeSignalSource(signal: signalNumber, queue: cancellationQueue)
  source.setEventHandler { processCancellation.cancel() }
  source.resume()
  return source
}

let input: Data
do {
  input = try readBoundedInput()
} catch {
  input = Data()
}

let response = withExtendedLifetime(cancellationSources) {
  NativeHost().process(
    arguments: CommandLine.arguments,
    input: input,
    cancellation: processCancellation
  )
}
FileHandle.standardOutput.write(response.data)
FileHandle.standardOutput.write(Data([0x0A]))
exit(response.exitCode)

private func readBoundedInput() throws -> Data {
  var input = Data()
  while input.count <= NativeProtocol.maximumRequestBytes {
    let remaining = NativeProtocol.maximumRequestBytes + 1 - input.count
    guard
      let chunk = try FileHandle.standardInput.read(
        upToCount: min(8 * 1024, remaining)
      ),
      !chunk.isEmpty
    else {
      break
    }
    input.append(chunk)
  }
  return input
}
