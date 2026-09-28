import { pickupCodeFromScan } from '@shared/handoff'
import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * Longest edge of the frame handed to the decoder.
 *
 * A phone camera will happily hand over 1920x1080, and decoding that many pixels
 * on the main thread drops the viewfinder to a slideshow. A pickup code is a
 * 21-module symbol held at arm's length, so it is resolvable far below the
 * sensor's resolution.
 */
const DECODE_EDGE_PIXELS = 480

type Phase =
  | { kind: 'idle' }
  | { kind: 'starting' }
  | { kind: 'scanning' }
  | { kind: 'scanned' }
  | { kind: 'refused'; why: string }

/**
 * Why the camera did not open, in the same register as the location notices: say
 * plainly what happened, and say that typing still works.
 *
 * Every branch here ends in the same place on purpose. A refusal is not a
 * dead end — the typed field beside this control is the path the protocol was
 * built on and still is.
 */
function describeCameraFailure(error: unknown): string {
  const name = error instanceof Error ? error.name : ''
  switch (name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return 'Camera access was refused. Read the code off their receipt and type it — it settles exactly the same.'
    case 'NotFoundError':
    case 'OverconstrainedError':
      return 'No camera to open on this device. Read the code off their receipt and type it instead.'
    case 'NotReadableError':
      return 'Something else is using the camera. Read the code off their receipt and type it instead.'
    default:
      return 'The camera did not start. Read the code off their receipt and type it instead.'
  }
}

/**
 * The receiver's camera: read the pickup code off the orderer's screen.
 *
 * Three rules this component exists to keep.
 *
 * **One decode path, not a fast path and a fallback.** `BarcodeDetector` is
 * unavailable on iOS Safari, so a `BarcodeDetector`-first design works on one
 * demo phone and silently falls through on the other — and the fallback then
 * becomes the untested path precisely when it is the one running. A pure-JS
 * decoder runs on both phones, so both phones run what the tests run.
 *
 * **The camera opens on a tap, never on load.** This app deliberately never
 * prompts for location unasked, and a surprise camera prompt would be worse. The
 * stream is stopped on a successful read, on cancelling, and on unmount — a
 * camera left running after a handoff is a battery bug and a privacy bug at once.
 *
 * **A scan fills the field; confirming is still a tap.** `onScan` hands the code
 * to the input the receiver would otherwise have typed into, and nothing is sent
 * to the server until they tap. A scan that settled money the instant a camera
 * caught a reflection would be a worse product, not a slicker one.
 *
 * **Both payload forms, because the receiver must not have to care.**
 * `pickupCodeFromScan` takes a bare code or a handoff link and yields the same
 * six characters, so a receipt printed by an older client and one printed by
 * this one scan identically.
 */
export function CodeScanner({ onScan }: { onScan: (code: string) => void }) {
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' })
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const frameRef = useRef<number | null>(null)
  const scratchRef = useRef<HTMLCanvasElement | null>(null)
  /** Trips the in-flight `start`'s `cancelled` flag; see `start` below. */
  const cancelRef = useRef<(() => void) | null>(null)

  const stop = useCallback(() => {
    cancelRef.current?.()
    cancelRef.current = null
    if (frameRef.current !== null) {
      cancelAnimationFrame(frameRef.current)
      frameRef.current = null
    }
    // Every track, unconditionally. `MediaStream.stop()` does not exist; a stream
    // is only released when each of its tracks is.
    for (const track of streamRef.current?.getTracks() ?? []) track.stop()
    streamRef.current = null
    const video = videoRef.current
    if (video !== null) video.srcObject = null
  }, [])

  // The unmount half of the promise above. The receipt is replaced wholesale when
  // a match settles, is disputed, or the buyer walks away, and not one of those
  // paths goes through the cancel button.
  useEffect(() => stop, [stop])

  const start = useCallback(async () => {
    // Set by the cleanup below if this component goes away mid-`await`. Every
    // `await` in here is a point at which the receipt can be replaced — a match
    // settles, is disputed, or the buyer walks away — and `stop()` would then
    // run *before* the rest of this function resumed and armed a frame loop on
    // an unmounted element. The camera was still handed back, so the privacy
    // invariant held, but the loop rescheduled itself forever against a video
    // that would never have a frame. Checked after each await instead.
    let cancelled = false
    cancelRef.current = () => {
      cancelled = true
    }

    // Annotated wider than the DOM lib types it: on an insecure origin, and in
    // some in-app browsers, `mediaDevices` is simply absent.
    const camera: MediaDevices | undefined = navigator.mediaDevices
    if (camera === undefined || typeof camera.getUserMedia !== 'function') {
      setPhase({
        kind: 'refused',
        why: 'This browser will not open a camera here. Read the code off their receipt and type it instead.',
      })
      return
    }

    setPhase({ kind: 'starting' })

    // Fetched on the tap, not with the app. The decoder is ~55 kB gzipped and is
    // wanted by exactly one person in one moment — the receiver, standing in front
    // of the orderer — so making every visitor download it to look at a nugget
    // deal would be the wrong trade. Still one decode path: this is the only
    // decoder, and a chunk that will not load is reported like any other reason
    // the camera did not open, which leaves the typed field exactly as it was.
    let decodeQr: typeof import('jsqr').default
    try {
      decodeQr = (await import('jsqr')).default
    } catch {
      if (cancelled) return
      setPhase({
        kind: 'refused',
        why: 'Could not load the scanner. Read the code off their receipt and type it instead.',
      })
      return
    }
    if (cancelled) return

    let stream: MediaStream
    try {
      // The back camera, because the thing being read is somebody else's screen.
      // A device with only one camera ignores the hint rather than failing.
      stream = await camera.getUserMedia({ video: { facingMode: 'environment' } })
    } catch (error) {
      if (cancelled) return
      setPhase({ kind: 'refused', why: describeCameraFailure(error) })
      return
    }
    if (cancelled) {
      // Gone while the permission prompt was open. Hand the camera back here as
      // well as below: `stop()` has already run and has no reference to this
      // stream, so nothing else ever would.
      for (const track of stream.getTracks()) track.stop()
      return
    }

    const video = videoRef.current
    if (video === null) {
      // Unmounted while the permission prompt was open. Hand the camera back.
      for (const track of stream.getTracks()) track.stop()
      return
    }

    streamRef.current = stream
    video.srcObject = stream
    // Set on the element as well as in JSX: an unmuted autoplaying video is
    // blocked, and React does not reflect `muted` onto the DOM property.
    video.muted = true
    try {
      await video.play()
    } catch {
      // Some browsers resolve the stream but refuse to start playback. The frame
      // loop below reads `readyState`, so it simply waits rather than throwing.
    }
    // The narrow one this flag exists for: unmounting *during* `play()` ran
    // `stop()`, which released the tracks and cancelled nothing, because there
    // was no frame loop yet. Arming one here would leave it rescheduling against
    // `readyState 0` for the life of the page.
    if (cancelled) {
      stop()
      return
    }
    setPhase({ kind: 'scanning' })

    scratchRef.current ??= document.createElement('canvas')

    const readFrame = () => {
      frameRef.current = requestAnimationFrame(readFrame)
      const scratch = scratchRef.current
      if (scratch === null || video.readyState < video.HAVE_CURRENT_DATA) return
      if (video.videoWidth === 0 || video.videoHeight === 0) return

      const longest = Math.max(video.videoWidth, video.videoHeight)
      const scale = Math.min(1, DECODE_EDGE_PIXELS / longest)
      const width = Math.max(1, Math.round(video.videoWidth * scale))
      const height = Math.max(1, Math.round(video.videoHeight * scale))
      if (scratch.width !== width) scratch.width = width
      if (scratch.height !== height) scratch.height = height
      const context = scratch.getContext('2d', { willReadFrequently: true })
      if (context === null) return

      context.drawImage(video, 0, 0, width, height)
      const found = decodeQr(context.getImageData(0, 0, width, height).data, width, height, {
        // A pickup QR is printed dark-on-light by `PickupQr`, in both themes, so
        // there is no inverted symbol to look for and no reason to pay for the
        // second pass on every frame.
        inversionAttempts: 'dontInvert',
      })
      if (found === null) return

      // A bare code or a handoff link, indifferently. Anything else in frame — a
      // merchant's promo QR, a wifi card taped to the counter — is neither, so
      // keep looking rather than filling the field with it.
      const code = pickupCodeFromScan(found.data)
      if (code === null) return

      stop()
      setPhase({ kind: 'scanned' })
      onScan(code)
    }

    frameRef.current = requestAnimationFrame(readFrame)
  }, [onScan, stop])

  const cancel = useCallback(() => {
    stop()
    setPhase({ kind: 'idle' })
  }, [stop])

  const live = phase.kind === 'starting' || phase.kind === 'scanning'

  return (
    <div className="mt-4">
      {/* Mounted whatever the phase, so `start` always has an element to attach
          the stream to rather than racing the render that would create one. */}
      {/* No caption track and no label: a live viewfinder has no audio and no
          transcript, and what it finds is announced in the status line below. */}
      <video
        ref={videoRef}
        muted
        playsInline
        className={
          live ? 'block aspect-square w-full border-2 border-ink bg-ink object-cover' : 'hidden'
        }
      />

      {live ? (
        <button
          type="button"
          onClick={cancel}
          className="mt-2 w-full border-2 border-ink px-4 py-3 font-display text-[0.7rem] font-bold tracking-[0.15em] uppercase"
        >
          Stop the camera
        </button>
      ) : (
        <button
          type="button"
          onClick={start}
          className="w-full border-2 border-ink px-4 py-3 font-display text-[0.7rem] font-bold tracking-[0.15em] uppercase"
        >
          Scan their code
        </button>
      )}

      <p className="mt-2 font-body text-sm leading-snug text-faded" aria-live="polite">
        {phase.kind === 'starting'
          ? 'Opening the camera.'
          : phase.kind === 'scanning'
            ? 'Point it at the QR on their receipt.'
            : phase.kind === 'scanned'
              ? 'Scanned. Check it reads right, then tap below — nothing settles until you do.'
              : phase.kind === 'refused'
                ? phase.why
                : 'Or point your camera at the QR on their receipt.'}
      </p>
    </div>
  )
}
