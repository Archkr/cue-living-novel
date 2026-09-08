/**
 * Tracks which chat currently has the Cue view open, per user. The backend
 * skips automatic planning and image generation for chats whose view is
 * closed, so users only pay for turns they can actually see.
 *
 * One open chat per user: the stage shows a single chat at a time, so opening
 * a chat's view supersedes the previous one. The registry is bookkeeping only;
 * abort side effects (asset controllers, planning queue, scene cache) stay in
 * the controller.
 */
export class ViewRegistry {
  private readonly openChatByUser = new Map<string, string>();

  private userKey(userId: string | undefined): string {
    return userId ?? "owner";
  }

  /**
   * Mark a chat's view open. Returns the previously open chat when opening
   * this one displaced a different chat, otherwise null. Idempotent.
   */
  open(userId: string | undefined, chatId: string): string | null {
    if (!chatId) return null;
    const key = this.userKey(userId);
    const previous = this.openChatByUser.get(key) ?? null;
    this.openChatByUser.set(key, chatId);
    return previous && previous !== chatId ? previous : null;
  }

  /**
   * Mark a chat's view closed. Returns false when that chat was not the open
   * one (idempotent; a stale close for another chat changes nothing).
   */
  close(userId: string | undefined, chatId: string): boolean {
    const key = this.userKey(userId);
    if (this.openChatByUser.get(key) !== chatId) return false;
    this.openChatByUser.delete(key);
    return true;
  }

  isOpen(userId: string | undefined, chatId: string): boolean {
    return Boolean(chatId) && this.openChatByUser.get(this.userKey(userId)) === chatId;
  }

  /** The chat whose view is open for a user, or null. */
  openChat(userId: string | undefined): string | null {
    return this.openChatByUser.get(this.userKey(userId)) ?? null;
  }

  /** Forget every open view (what a restarted backend knows). */
  clear(): void {
    this.openChatByUser.clear();
  }
}
