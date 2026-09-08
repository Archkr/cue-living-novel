import type { SpeechStatus } from "./controller.js";

/**
 * Minimal speech dock: Play/Pause + Stop + a truthful status line for the
 * current assistant paragraph. Mounted by the host controller into the overlay
 * root as its own element (no VnStage changes), shown only while the overlay is
 * active AND speech is enabled. Errors/blocked autoplay are displayed here and
 * never thrown into the reading flow.
 */
export type SpeechDockOptions = {
  mount: HTMLElement;
  onPlay: () => void;
  onPause: () => void;
  onStop: () => void;
};

const DOCK_CSS = `
/* Top pill: positioned to the left of the exit button on narrow screens, or centered when ample space exists.
   Never overlaps the bottom dialogue box, the reading controls (Next/Previous/Skip live on the dialogue),
   or the top-right exit button. Top offset respects the notch/safe-area inset. */
:host {
  position: absolute;
  top: max(0.75rem, env(safe-area-inset-top));
  left: 50%;
  transform: translateX(-50%);
  z-index: 40;
  max-width: calc(100% - 9rem);
  font: 13px/1.4 var(--lumiverse-font-family, system-ui, sans-serif);
}
[data-dock] { display: flex; align-items: center; gap: .45rem; padding: .35rem .6rem; border-radius: 999px; border: 1px solid var(--lumiverse-border, rgba(255,255,255,.25)); background: rgba(10, 10, 18, .78); color: var(--lumiverse-text, #f5f5f7); backdrop-filter: blur(6px); max-width: 100%; }
button { min-width: 2rem; min-height: 2rem; flex: none; border-radius: 999px; border: 1px solid var(--lumiverse-border, rgba(255,255,255,.25)); background: var(--lumiverse-fill-medium, rgba(255,255,255,.12)); color: inherit; font: inherit; cursor: pointer; }
button:disabled { opacity: .5; cursor: default; }
[data-status] { max-width: 16rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--lumiverse-text-muted, rgba(255,255,255,.72)); }
[data-status][data-tone="error"] { color: var(--lumiverse-danger, #ff8ca0); white-space: normal; }
@media (max-width: 640px) {
  :host {
    left: auto;
    right: calc(max(0.75rem, env(safe-area-inset-right)) + 7.5rem);
    transform: none;
    max-width: calc(100% - 13.5rem);
  }
  [data-status] { max-width: 4rem; }
}`;

export class SpeechDock {
  private readonly host: HTMLElement;
  private readonly playButton: HTMLButtonElement;
  private readonly stopButton: HTMLButtonElement;
  private readonly statusEl: HTMLElement;
  private enabled = false;
  private overlayActive = false;
  private playing = false;

  constructor(private readonly options: SpeechDockOptions) {
    this.host = document.createElement("div");
    this.host.className = "vn-speech-dock";
    const shadow = this.host.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = DOCK_CSS;
    const dock = document.createElement("div");
    dock.setAttribute("data-dock", "");
    dock.setAttribute("role", "group");
    dock.setAttribute("aria-label", "Paragraph speech");
    this.playButton = document.createElement("button");
    this.playButton.type = "button";
    this.playButton.addEventListener("click", () => {
      if (this.playing) this.options.onPause();
      else this.options.onPlay();
    });
    this.stopButton = document.createElement("button");
    this.stopButton.type = "button";
    this.stopButton.textContent = "■";
    this.stopButton.setAttribute("aria-label", "Stop speech");
    this.stopButton.addEventListener("click", () => this.options.onStop());
    this.statusEl = document.createElement("span");
    this.statusEl.setAttribute("data-status", "");
    this.statusEl.setAttribute("role", "status");
    this.statusEl.setAttribute("aria-live", "polite");
    dock.append(this.playButton, this.stopButton, this.statusEl);
    shadow.append(style, dock);
    this.setStatus({ kind: "off" });
    this.sync();
    options.mount.appendChild(this.host);
  }

  /** Enabled = the speech setting; the dock stays hidden while speech is off. */
  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    this.sync();
  }

  setOverlayActive(active: boolean): void {
    this.overlayActive = active;
    this.sync();
  }

  setStatus(status: SpeechStatus): void {
    this.playing = status.kind === "playing";
    this.playButton.textContent = this.playing ? "❚❚" : "▶";
    this.playButton.setAttribute("aria-label", this.playing ? "Pause speech" : "Play this paragraph");
    this.playButton.disabled = status.kind === "loading";
    this.stopButton.disabled = status.kind === "off" || status.kind === "idle";
    const tone = status.kind === "error" || status.kind === "blocked" || status.kind === "unconfigured" ? "error" : "info";
    this.statusEl.setAttribute("data-tone", tone);
    this.statusEl.textContent = describeStatus(status);
  }

  destroy(): void {
    this.host.remove();
  }

  private sync(): void {
    this.host.style.display = this.enabled && this.overlayActive ? "" : "none";
  }
}

export function describeStatus(status: SpeechStatus): string {
  switch (status.kind) {
    case "off": return "";
    case "idle": return status.speaker ? `Speech ready — ${status.speaker}` : "Speech ready";
    case "loading": return "Fetching audio…";
    case "playing": return status.speaker ? `Speaking — ${status.speaker}` : "Speaking";
    case "paused": return "Paused";
    case "blocked": return status.message;
    case "unconfigured": return status.message;
    case "error": return status.message;
  }
}
