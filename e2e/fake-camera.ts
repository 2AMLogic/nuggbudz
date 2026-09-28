import { mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

/**
 * A synthetic camera for Chromium, fed a picture taken off another browser's
 * screen.
 *
 * This exists so `e2e/scan.spec.ts` can prove the thing that actually matters —
 * that the code reaching `confirm_pickup` came off a *camera* — rather than
 * calling the decoder directly and reporting the feature as covered. This repo
 * has four defects of that shape already (`isDealOffered`, `isDemoUserId`, the
 * OAuth `nonce`, an unreachable refund branch), and each one had a green unit
 * test on a path nothing called.
 *
 * Chromium's `--use-file-for-fake-video-capture` makes `getUserMedia` play a Y4M
 * file instead of a sensor. The file is opened when the capture device starts,
 * not when the browser launches, so the frames can be written *after* the server
 * has issued a pickup code — which it has to be, because the code is random and
 * unknowable until the match exists.
 *
 * Deliberately not an image library: Y4M is a text header and raw planes, and a
 * dependency that decodes PNG would be a dependency added for a test.
 */

/** 4:2:0 wants even dimensions; VGA is what a fake device would report anyway. */
const FRAME_WIDTH = 640
const FRAME_HEIGHT = 480

/** Enough frames that a decode loop is never racing the file's end. */
const FRAME_COUNT = 30

/** Mid-grey chroma: the picture is a QR, so every pixel is on the luma axis. */
const NEUTRAL_CHROMA = 128

/**
 * The one file the fake device reads.
 *
 * Fixed rather than per-test because the path has to be known at browser launch,
 * and each scenario rewrites its contents before the scan it is about.
 */
export const FAKE_CAMERA_FILE = join(tmpdir(), 'nuggbudz-e2e-camera', 'viewfinder.y4m')

/**
 * Flags the fake device needs.
 *
 * `--use-fake-ui-for-media-stream` is here because Playwright's
 * `permissions: ['camera']` grant is not enough on its own: without it headless
 * Chromium answers `getUserMedia` with `NotSupportedError` however the context is
 * permissioned. It auto-accepts the prompt, which is why the refused-camera
 * scenario has to reject `getUserMedia` in the page rather than by withholding
 * a permission.
 */
export const FAKE_CAMERA_ARGS = [
  '--use-fake-device-for-media-stream',
  '--use-fake-ui-for-media-stream',
  `--use-file-for-fake-video-capture=${FAKE_CAMERA_FILE}`,
]

/** A greyscale picture: one byte per pixel, row-major. */
export interface GreyscaleImage {
  width: number
  height: number
  /** Base64, because this crosses `page.evaluate`'s JSON boundary. */
  luma: string
}

/**
 * Centre `image` in a VGA frame, scaled up by the largest whole factor that
 * fits.
 *
 * Whole factors only: a fractional resample of a QR is how you manufacture a
 * moiré pattern and then blame the decoder for it. A 232-pixel symbol doubles to
 * 464, which leaves the modules 12 device pixels across by the time the scanner
 * has downsampled the frame.
 */
function paintFrame(image: GreyscaleImage): Uint8Array {
  const source = Buffer.from(image.luma, 'base64')
  if (source.length < image.width * image.height) {
    throw new Error(`greyscale image is ${source.length} bytes, short of its own dimensions`)
  }
  const longest = Math.max(image.width, image.height)
  const scale = Math.max(1, Math.floor(Math.min(FRAME_WIDTH, FRAME_HEIGHT) / longest))
  const drawnWidth = image.width * scale
  const drawnHeight = image.height * scale
  const left = Math.floor((FRAME_WIDTH - drawnWidth) / 2)
  const top = Math.floor((FRAME_HEIGHT - drawnHeight) / 2)

  // White surround, so the quiet zone the symbol carries is never the only
  // margin a decoder has to find an edge against.
  const frame = new Uint8Array(FRAME_WIDTH * FRAME_HEIGHT).fill(255)
  for (let y = 0; y < drawnHeight; y += 1) {
    const frameY = top + y
    if (frameY < 0 || frameY >= FRAME_HEIGHT) continue
    const sourceRow = Math.floor(y / scale) * image.width
    for (let x = 0; x < drawnWidth; x += 1) {
      const frameX = left + x
      if (frameX < 0 || frameX >= FRAME_WIDTH) continue
      frame[frameY * FRAME_WIDTH + frameX] = source[sourceRow + Math.floor(x / scale)]
    }
  }
  return frame
}

/** Point the fake camera at this picture, from the next `getUserMedia` onward. */
export function showToFakeCamera(image: GreyscaleImage): void {
  mkdirSync(dirname(FAKE_CAMERA_FILE), { recursive: true })
  const luma = Buffer.from(paintFrame(image))
  const chroma = Buffer.alloc((FRAME_WIDTH / 2) * (FRAME_HEIGHT / 2), NEUTRAL_CHROMA)
  const parts: Buffer[] = [
    Buffer.from(`YUV4MPEG2 W${FRAME_WIDTH} H${FRAME_HEIGHT} F30:1 Ip A1:1 C420mpeg2\n`),
  ]
  for (let frame = 0; frame < FRAME_COUNT; frame += 1) {
    parts.push(Buffer.from('FRAME\n'), luma, chroma, chroma)
  }
  writeFileSync(FAKE_CAMERA_FILE, Buffer.concat(parts))
}
