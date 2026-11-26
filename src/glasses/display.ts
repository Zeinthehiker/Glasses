import {
  CreateStartUpPageContainer,
  ImageContainerProperty,
  ImageRawDataUpdate,
  MenuContainerProperty,
  MenuItemProperty,
  RebuildPageContainer,
  StartUpPageCreateResult,
  TextContainerProperty,
  TextContainerUpgrade,
  type EvenAppBridge,
} from '@evenrealities/even_hub_sdk'
import { hasUnsupportedGlyphs, tailThatFits } from './fit'
import { BAND_H, TILE_W, renderCaptionTiles } from './render-image'

// Layout (576 x 288 display, 27 px firmware line height):
//
//   text mode                     image mode
//   +--------------------------+  +--------------------------+
//   | status            (32px) |  | status            (32px) |
//   | captions, 9 lines        |  | (empty)                  |
//   |                          |  |--------------------------|
//   |                          |  | captions as 2 PNG tiles  |
//   +--------------------------+  +--------------------------+
//
// Text mode uses the glasses' native font and is the fastest to update.
// Image mode is used only when the caption contains characters that font
// cannot draw, because every update sends two images over Bluetooth.

export type RenderMode = 'auto' | 'text' | 'image'

const W = 576
const H = 288
const STATUS_H = 32
const PAD = 4
const CAPTION_LINES = Math.floor((H - STATUS_H - PAD * 2) / 27)

const ID = { status: 1, captions: 2, tileL: 3, tileR: 4 } as const
const NAME = { status: 'status', captions: 'captions', tileL: 'tile-l', tileR: 'tile-r' } as const

export const MENU = { togglePause: 1, clear: 2 } as const

function menuObject(paused: boolean): MenuContainerProperty {
  return new MenuContainerProperty({
    menuItems: [
      new MenuItemProperty({ itemID: MENU.togglePause, itemName: paused ? 'Resume' : 'Pause' }),
      new MenuItemProperty({ itemID: MENU.clear, itemName: 'Clear captions' }),
    ],
  })
}

function statusContainer(content: string, eventCapture: boolean) {
  return new TextContainerProperty({
    xPosition: 0,
    yPosition: 0,
    width: W,
    height: STATUS_H,
    borderWidth: 0,
    paddingLength: 2,
    containerID: ID.status,
    containerName: NAME.status,
    content,
    textColor: 2,
    isEventCapture: eventCapture ? 1 : 0,
    zOrderIndex: 1,
  })
}

export class GlassesDisplay {
  private layout: 'text' | 'image' | null = null
  private status = ''
  private caption = ''
  private paused = false
  private pending = false
  private flushing: Promise<void> = Promise.resolve()
  private lastSent = { caption: '', status: '' }
  private lastFlushAt = 0

  constructor(
    private readonly bridge: EvenAppBridge,
    private mode: RenderMode = 'auto',
    private readonly minIntervalMs = 150,
  ) {}

  /** Must run before the glasses microphone can be opened. */
  async init(status: string): Promise<boolean> {
    this.status = status
    const page = this.page('text')
    const result = await this.bridge.createStartUpPageContainer(new CreateStartUpPageContainer(page))
    if (result !== StartUpPageCreateResult.success) {
      console.error('createStartUpPageContainer failed:', result)
      return false
    }
    this.layout = 'text'
    this.lastSent = { caption: '', status }
    return true
  }

  setMode(mode: RenderMode): void {
    this.mode = mode
    this.schedule()
  }

  setPaused(paused: boolean): void {
    if (this.paused === paused) return
    this.paused = paused
    this.layout = null // force a rebuild so the menu label flips
    this.schedule()
  }

  setStatus(status: string): void {
    this.status = status
    this.schedule()
  }

  setCaption(text: string): void {
    this.caption = text
    this.schedule()
  }

  private wantedLayout(): 'text' | 'image' {
    if (this.mode !== 'auto') return this.mode
    // Only look at what would actually be on screen, so one Arabic word
    // from minutes ago doesn't pin us in the slower image mode.
    const visible = tailThatFits(this.caption, W - PAD * 2, CAPTION_LINES)
    return hasUnsupportedGlyphs(visible) ? 'image' : 'text'
  }

  private page(layout: 'text' | 'image') {
    if (layout === 'text') {
      return {
        containerTotalNum: 2,
        textObject: [
          statusContainer(this.status, false),
          new TextContainerProperty({
            xPosition: 0,
            yPosition: STATUS_H,
            width: W,
            height: H - STATUS_H,
            borderWidth: 0,
            paddingLength: PAD,
            containerID: ID.captions,
            containerName: NAME.captions,
            content: tailThatFits(this.caption, W - PAD * 2, CAPTION_LINES) || ' ',
            isEventCapture: 1,
            zOrderIndex: 2,
          }),
        ],
        menuObject: menuObject(this.paused),
      }
    }
    return {
      containerTotalNum: 3,
      textObject: [statusContainer(this.status, true)],
      imageObject: [
        new ImageContainerProperty({
          xPosition: 0,
          yPosition: H - BAND_H,
          width: TILE_W,
          height: BAND_H,
          containerID: ID.tileL,
          containerName: NAME.tileL,
          zOrderIndex: 2,
        }),
        new ImageContainerProperty({
          xPosition: TILE_W,
          yPosition: H - BAND_H,
          width: TILE_W,
          height: BAND_H,
          containerID: ID.tileR,
          containerName: NAME.tileR,
          zOrderIndex: 3,
        }),
      ],
      menuObject: menuObject(this.paused),
    }
  }

  /** Coalesce updates: at most one in flight, always ending on the newest state. */
  private schedule(): void {
    if (this.pending) return
    this.pending = true
    this.flushing = this.flushing.then(async () => {
      const wait = this.minIntervalMs - (Date.now() - this.lastFlushAt)
      if (wait > 0) await new Promise((r) => setTimeout(r, wait))
      this.pending = false
      this.lastFlushAt = Date.now()
      try {
        await this.flush()
      } catch (err) {
        console.error('glasses update failed', err)
      }
    })
  }

  private async flush(): Promise<void> {
    const want = this.wantedLayout()
    if (this.layout !== want) {
      const ok = await this.bridge.rebuildPageContainer(new RebuildPageContainer(this.page(want)))
      if (!ok) return
      this.layout = want
      this.lastSent = { caption: want === 'text' ? this.caption : '', status: this.status }
      if (want === 'text') return
    }

    if (this.status !== this.lastSent.status) {
      this.lastSent.status = this.status
      await this.bridge.textContainerUpgrade(
        new TextContainerUpgrade({ containerID: ID.status, containerName: NAME.status, content: this.status }),
      )
    }

    if (this.caption === this.lastSent.caption) return
    const caption = this.caption
    this.lastSent.caption = caption

    if (want === 'text') {
      await this.bridge.textContainerUpgrade(
        new TextContainerUpgrade({
          containerID: ID.captions,
          containerName: NAME.captions,
          content: tailThatFits(caption, W - PAD * 2, CAPTION_LINES) || ' ',
        }),
      )
    } else {
      const [left, right] = await renderCaptionTiles(caption)
      // Image updates must be sequential.
      await this.bridge.updateImageRawData(
        new ImageRawDataUpdate({ containerID: ID.tileL, containerName: NAME.tileL, imageData: left }),
      )
      await this.bridge.updateImageRawData(
        new ImageRawDataUpdate({ containerID: ID.tileR, containerName: NAME.tileR, imageData: right }),
      )
    }
  }

  async close(): Promise<void> {
    await this.bridge.shutDownPageContainer(0)
  }
}
