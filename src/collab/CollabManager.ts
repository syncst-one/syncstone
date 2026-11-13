import { t } from "../i18n/index.js";
import { MarkdownView, Notice, type App, type EventRef, type TFile } from "obsidian";
import {
  COLLAB_MAX_TEXT_LENGTH,
  merge3,
  type CollabClientMessage,
  type CollabPeer,
  type CollabPeersMessage,
  type CollabRelayMessage,
  type CollabRestoredMessage,
  type CollabServerMessage,
} from "@websync/shared";
import type { CryptoService } from "../sync/CryptoService.js";
import type { SyncLog } from "../sync/SyncLog.js";
import { CollabSession } from "./CollabSession.js";
import { bindEditor, canBind, createCollabExtension, getEditorView, replaceEditorText, unbindEditor } from "./editorBinding.js";
import { CollabKind, openCollabMessage, sealCollabMessage } from "./protocol.js";
import type { EditorView } from "@codemirror/view";

/**
 * Cursor colours, indexed by the `colorIndex` the server hands out per room
 * (lowest free index), so every device sees the same colour for the same peer.
 */
export const COLLAB_COLORS = ["#e5484d", "#0091ff", "#30a46c", "#f76b15", "#8e4ec6", "#12a594", "#e93d82", "#a07100"];

const REFRESH_INTERVAL_MS = 4000;
const STATE_REQUEST_TIMEOUT_MS = 4000;
const MAX_STATE_REQUEST_ATTEMPTS = 3;

export interface CollabManagerDeps {
  app: App;
  crypto: CryptoService;
  /** Writes a message to the live socket; false if it isn't open. */
  send: (message: CollabClientMessage) => boolean;
  /** The sync engine's file id for a vault path - null for notes that haven't been uploaded yet (they can't be co-edited until they have an id). */
  getFileId: (path: string) => Promise<string | null>;
  /** True if `text` equals what this device last uploaded/downloaded for `path`, i.e. there are no unsynced local edits in it. */
  isTextSynced: (path: string, text: string) => Promise<boolean>;
  /** The text this device last had in common with the server for `path` (the merge base), or null if unknown. */
  mergeBase: (path: string) => Promise<string | null>;
  isEnabled: () => boolean;
  /** The note's current content on the server (decrypted), or null if it cannot be loaded right now. */
  loadServerText: (fileId: string) => Promise<string | null>;
  log?: SyncLog;
  /**
   * A live session of `file` ended here. While it ran, only the host wrote the note; this device now writes it again
   * itself and compares its text with the server once (nothing is sent when the host already did).
   */
  onLiveEnded?: (file: TFile) => void;
  /** Called whenever who-is-in-which-note may have changed, so the UI (header avatars) can re-read `presenceFor`. */
  onPresenceChange: () => void;
}

export interface CollabPresence {
  name: string;
  color: string;
}

/** One note this device has open (and told the server about). */
interface Room {
  fileId: string;
  /**
   * The note itself. Obsidian keeps the same TFile when a note is renamed or moved, so this - not the path - is what
   * ties an open editor to its room. Looking the id up by path again after a rename could hit another file's index
   * entry for a moment and pour this note's text into that file's room (or that file's text into this editor).
   */
  file: TFile;
  path: string;
  /** The editor a live session is/will be bound to. */
  view: MarkdownView;
  /** This connection's peer id and the current member list (including itself), as last sent by the server. */
  you: string | null;
  peers: CollabPeer[];
  /** Exists only while >= 2 devices are in the room. */
  session: CollabSession | null;
  /** False while a joiner is still waiting for the host's state; true once the editor is bound and in sync. */
  synced: boolean;
  boundEditor: EditorView | null;
  stateRequestAttempts: number;
  stateRequestTimer: ReturnType<typeof window.setTimeout> | null;
}

/**
 * Presence + live co-editing between devices, layered on top of (not instead
 * of) the normal file sync.
 *
 *  - It tells the server which synced notes this device has open ("rooms").
 *  - As long as this device is alone in a note, nothing else happens: the
 *    note syncs through the regular SyncEngine like any other file.
 *  - As soon as a second device opens the same note, a CollabSession (Yjs)
 *    starts on both. The lowest-`seq` member (the "host") seeds the document
 *    from its editor; the joiner asks the host for its state, aligns its
 *    editor to it and installs the CodeMirror binding, which from then on
 *    exchanges edits and shows the other devices' coloured cursors with their
 *    device names. When only one device is left, the session ends and the
 *    editor content simply carries on through the normal sync.
 *
 * Everything relayed through the server is end-to-end encrypted (protocol.ts).
 *
 * All state changes run through one promise queue (`enqueue`), so socket
 * messages, editor events and timers can never interleave half-way through an
 * async step (decrypting, looking up file ids, ...).
 */
export class CollabManager {
  private readonly rooms = new Map<string, Room>();
  private queue: Promise<void> = Promise.resolve();
  private connected = false;
  private disposed = false;
  private refreshScheduled = false;
  private refreshTimer: ReturnType<typeof window.setInterval> | null = null;
  private readonly workspaceRefs: EventRef[] = [];
  private vaultRenameRef: EventRef | null = null;

  constructor(private readonly deps: CollabManagerDeps) {
    const { workspace, vault } = deps.app;
    const refresh = () => this.requestRefresh();
    // A view that now shows another note must stop feeding the old note's live session right away, not only when the
    // queued refresh gets to it.
    const viewChanged = () => {
      this.detachSwitchedViews();
      this.requestRefresh();
    };
    this.workspaceRefs.push(
      workspace.on("active-leaf-change", viewChanged),
      workspace.on("layout-change", viewChanged),
      workspace.on("file-open", viewChanged),
    );
    this.vaultRenameRef = vault.on("rename", refresh);
    // Safety net for what has no event: a new note getting its file id after
    // its first upload, or an editor being torn down without a layout change.
    this.refreshTimer = window.setInterval(refresh, REFRESH_INTERVAL_MS);
  }

  // ============================================================
  // Entry points (called by main.ts / LiveSyncClient)
  // ============================================================

  /** Read by SyncEngine: while a note is co-edited, its content arrives through the session - downloading the file version on top of it would clobber live edits. */
  isLive(fileId: string): boolean {
    return this.rooms.get(fileId)?.session != null;
  }

  /**
   * Read by SyncEngine: whether this device writes `fileId` to the server. While a note is co-edited, only the session's
   * host does (everybody has the same text, so one write is enough, and two devices never race each other with it).
   */
  isWriter(fileId: string): boolean {
    const room = this.rooms.get(fileId);
    if (!room?.session) return true;
    return room.synced && this.isHost(room);
  }

  /** The other devices co-editing `path` right now (null if that note isn't being co-edited). */
  presenceFor(path: string): CollabPresence[] | null {
    for (const room of this.rooms.values()) {
      if (!room.session || room.path !== path) continue;
      return room.peers
        .filter((peer) => peer.peerId !== room.you)
        .map((peer) => ({ name: peer.deviceName, color: colorFor(peer.colorIndex) }));
    }
    return null;
  }

  /** The socket (re)connected: (re)join the rooms of everything that is open now. */
  handleConnected(): void {
    this.connected = true;
    this.requestRefresh();
  }

  /** The socket dropped: the server has already removed us from every room, so end all sessions (the editors keep their text) and start over on reconnect. */
  handleDisconnected(): void {
    this.connected = false;
    this.enqueue(() => {
      this.teardownRooms();
      this.updateStatus();
    });
  }

  handleServerMessage(message: CollabServerMessage): void {
    this.enqueue(() => {
      if (message.type === "collab_peers") return this.onPeers(message);
      if (message.type === "collab_restored") return this.onRestored(message);
      return this.onRelay(message);
    });
  }

  /**
   * Puts `text` into the live session of `fileId` as an edit of this device, so every open editor gets it at once
   * (used when this device restores an older version while the note is co-edited). False if the note is not live here.
   */
  async applyLiveText(fileId: string, text: string): Promise<boolean> {
    if (this.disposed) return false;
    return new Promise<boolean>((resolve) => {
      this.enqueue(() => resolve(this.putIntoSession(fileId, text)));
      // Runs even if the task above threw or was skipped (manager disposed): then nothing was applied.
      this.queue = this.queue.then(() => resolve(false));
    });
  }

  /**
   * Merges `remote` (another device's version, changed from `base`) into the live session of `fileId` through this
   * device's editor, in one step against what the editor shows right now (so nothing being typed is lost). Returns the
   * new text, null when the edits overlap (nothing changed then), false when the note is not live here.
   */
  async mergeIntoLive(fileId: string, base: string, remote: string): Promise<string | null | false> {
    if (this.disposed) return false;
    return new Promise<string | null | false>((resolve) => {
      this.enqueue(() => {
        const room = this.rooms.get(fileId);
        const cm = room?.boundEditor;
        if (!room || !room.session || !room.synced || !cm || !this.showsRoomFile(room)) return resolve(false);
        const merged = merge3(base, cm.state.doc.toString(), remote);
        if (merged === null) return resolve(null);
        if (merged.length > COLLAB_MAX_TEXT_LENGTH) return resolve(false);
        replaceEditorText(cm, merged);
        resolve(merged);
      });
      // Runs even if the task above threw or was skipped (manager disposed): then nothing was applied.
      this.queue = this.queue.then(() => resolve(false));
    });
  }

  /** Re-evaluates which notes are open / whether collaboration is enabled (also called from the settings toggle). */
  requestRefresh(): void {
    if (this.disposed || this.refreshScheduled) return;
    this.refreshScheduled = true;
    this.enqueue(async () => {
      this.refreshScheduled = false;
      await this.refresh();
    });
  }

  dispose(): void {
    this.disposed = true;
    if (this.refreshTimer !== null) window.clearInterval(this.refreshTimer);
    this.refreshTimer = null;
    for (const ref of this.workspaceRefs) this.deps.app.workspace.offref(ref);
    this.workspaceRefs.length = 0;
    if (this.vaultRenameRef) this.deps.app.vault.offref(this.vaultRenameRef);
    this.vaultRenameRef = null;
    this.teardownRooms();
    this.deps.onPresenceChange();
  }

  private enqueue(task: () => void | Promise<void>): void {
    this.queue = this.queue
      .then(() => {
        if (!this.disposed) return task();
      })
      .catch((err) => console.error("Syncstone: Live-Zusammenarbeit fehlgeschlagen", err));
  }

  // ============================================================
  // Rooms = open, synced notes
  // ============================================================

  private async refresh(): Promise<void> {
    if (!this.connected || !this.deps.isEnabled()) {
      this.teardownRooms();
      this.updateStatus();
      return;
    }

    const { workspace } = this.deps.app;
    const activeView = workspace.getActiveViewOfType(MarkdownView);
    const open = new Map<string, { file: TFile; path: string; views: MarkdownView[] }>();
    for (const leaf of workspace.getLeavesOfType("markdown")) {
      const view = leaf.view;
      // Background tabs Obsidian hasn't loaded yet are DeferredViews - no editor, so not "open" yet.
      if (!(view instanceof MarkdownView) || !view.file || view.file.extension !== "md") continue;
      const file = view.file;
      const path = file.path;
      // A note that already has a room keeps its id, whatever happens to its name.
      let fileId = this.roomOf(file)?.fileId ?? null;
      if (!fileId) {
        fileId = await this.deps.getFileId(path);
        // Renamed or switched while we were looking: the answer may belong to the old name. The rename event brings
        // another refresh.
        if (view.file !== file || file.path !== path) continue;
      }
      if (!fileId) continue;
      const known = open.get(fileId);
      if (known && known.file !== file) continue; // two notes claim one id: never mix them, wait until it is clear
      const entry = known ?? { file, path, views: [] };
      entry.views.push(view);
      open.set(fileId, entry);
    }
    if (this.disposed) return;

    for (const room of [...this.rooms.values()]) {
      const entry = open.get(room.fileId);
      if (!entry || entry.file !== room.file) this.leaveRoom(room);
    }
    for (const [fileId, { file, path, views }] of open) {
      const preferred = activeView && views.includes(activeView) ? activeView : views[0];
      const room = this.rooms.get(fileId);
      if (!room) {
        this.joinRoom(fileId, file, path, preferred);
        continue;
      }
      room.path = path;
      if (!views.includes(room.view) || room.view.file !== room.file) this.moveView(room, preferred);
    }
    this.updateStatus();
  }

  private roomOf(file: TFile): Room | undefined {
    for (const room of this.rooms.values()) if (room.file === file) return room;
    return undefined;
  }

  /** True while `room.view` still shows the room's own note - nothing may be written into the editor otherwise. */
  private showsRoomFile(room: Room, view: MarkdownView = room.view): boolean {
    return view.file === room.file;
  }

  /** Synchronous part of a view change: unbind every live editor whose view now shows a different note. */
  private detachSwitchedViews(): void {
    for (const room of this.rooms.values()) {
      if (room.boundEditor && !this.showsRoomFile(room)) this.unbind(room);
    }
  }

  private joinRoom(fileId: string, file: TFile, path: string, view: MarkdownView): void {
    this.rooms.set(fileId, {
      fileId,
      file,
      path,
      view,
      you: null,
      peers: [],
      session: null,
      synced: false,
      boundEditor: null,
      stateRequestAttempts: 0,
      stateRequestTimer: null,
    });
    this.deps.send({ type: "collab_join", fileId });
  }

  private leaveRoom(room: Room): void {
    this.stopSession(room);
    this.rooms.delete(room.fileId);
    this.deps.send({ type: "collab_leave", fileId: room.fileId });
  }

  /** Drops every room locally, without telling the server (used when the socket is gone or we're shutting down). */
  private teardownRooms(): void {
    for (const room of this.rooms.values()) this.stopSession(room);
    this.rooms.clear();
  }

  /** The editor a room was bound to went away, but the same note is still open somewhere else - carry the session over. */
  private moveView(room: Room, view: MarkdownView): void {
    const session = room.session;
    if (session && room.synced) {
      this.unbind(room);
      const cm = getEditorView(view);
      if (!cm || !canBind(cm) || !this.showsRoomFile(room, view)) {
        this.stopSession(room);
      } else {
        replaceEditorText(cm, session.text());
        this.bind(room, cm);
      }
    }
    room.view = view;
  }

  // ============================================================
  // Server messages
  // ============================================================

  private async onPeers(message: CollabPeersMessage): Promise<void> {
    const room = this.rooms.get(message.fileId);
    if (!room) return; // stale: we already closed that note

    const before = new Set(room.peers.map((peer) => peer.peerId));
    const now = new Set(message.peers.map((peer) => peer.peerId));
    room.you = message.you;
    room.peers = message.peers;

    if (message.peers.length < 2) {
      // Alone in the note again - back to plain file sync.
      this.stopSession(room);
    } else if (!room.session) {
      await this.startSession(room, false);
    } else {
      const me = message.peers.find((peer) => peer.peerId === message.you);
      if (me) room.session.setUserName(me.deviceName);
      for (const peerId of before) if (!now.has(peerId)) room.session.forgetPeer(peerId);
      // A newcomer hasn't seen our cursor yet.
      for (const peerId of now) {
        if (!before.has(peerId)) {
          room.session.announce();
          break;
        }
      }
    }
    this.updateStatus();
  }

  /**
   * Another device restored an older version of a note that is co-edited here. The session still holds the text from
   * before and would save it over the restore with the next keystroke, so the host (one device per room) loads the
   * restored content and puts it into the session; everybody else gets it from there.
   */
  private async onRestored(message: CollabRestoredMessage): Promise<void> {
    const room = this.rooms.get(message.fileId);
    if (!room || !room.session || !room.synced || !this.isHost(room)) return;
    const session = room.session;
    const text = await this.deps.loadServerText(room.fileId);
    if (text === null || this.rooms.get(message.fileId) !== room || room.session !== session) return;
    this.putIntoSession(room.fileId, text);
  }

  /** Replaces the session's text with `text` through this device's bound editor (the binding sends it to the peers). */
  private putIntoSession(fileId: string, text: string): boolean {
    const room = this.rooms.get(fileId);
    const cm = room?.boundEditor;
    if (!room || !room.session || !room.synced || !cm || !this.showsRoomFile(room)) return false;
    if (text.length > COLLAB_MAX_TEXT_LENGTH) return false;
    replaceEditorText(cm, text);
    return true;
  }

  private isHost(room: Room): boolean {
    const lowest = [...room.peers].sort((a, b) => a.seq - b.seq)[0];
    return lowest !== undefined && lowest.peerId === room.you;
  }

  private async onRelay(message: CollabRelayMessage): Promise<void> {
    const room = this.rooms.get(message.fileId);
    if (!room) return;

    const opened = await openCollabMessage(this.deps.crypto, room.fileId, message.data);
    if (!opened || this.rooms.get(message.fileId) !== room) return;

    switch (opened.kind) {
      case CollabKind.StateRequest:
        await this.answerStateRequest(room, message.from, opened.payload);
        break;
      case CollabKind.StateReply:
        await this.applyStateReply(room, opened.payload);
        break;
      case CollabKind.Update:
        room.session?.applyRemoteUpdate(opened.payload);
        break;
      case CollabKind.Awareness:
        room.session?.applyRemoteAwareness(message.from, opened.payload);
        break;
    }
  }

  // ============================================================
  // Sessions
  // ============================================================

  /**
   * Starts co-editing for a room that now has >= 2 members. The member with
   * the lowest `seq` is the host and seeds the document from its editor
   * (`forceHost`: we were asked for state before we knew we should start);
   * everybody else is a joiner and fetches the host's state first.
   */
  private async startSession(room: Room, forceHost: boolean): Promise<void> {
    const cm = getEditorView(room.view);
    if (!cm || !canBind(cm) || !this.showsRoomFile(room)) return;
    const text = cm.state.doc.toString();
    if (text.length > COLLAB_MAX_TEXT_LENGTH) return; // too big for live editing - stays on plain file sync

    const me = room.peers.find((peer) => peer.peerId === room.you);
    if (!me) return;
    const lowestSeq = [...room.peers].sort((a, b) => a.seq - b.seq)[0];

    const session = new CollabSession((kind, payload, to) => this.relay(room, kind, payload, to), {
      name: me.deviceName,
      color: colorFor(me.colorIndex),
    });
    room.session = session;
    room.synced = false;
    room.stateRequestAttempts = 0;

    if (forceHost || lowestSeq.peerId === room.you) {
      // The host's text becomes everybody's. This editor may be behind (a phone that was in the background has not
      // fetched the latest edits yet), so the session starts from the server's current version, with what was typed here
      // and not sent yet merged on top. Without the server's version there is no live session; plain sync carries on.
      const seed = await this.hostSeed(room, text);
      const latestCm = getEditorView(room.view);
      if (seed === null || room.session !== session || this.rooms.get(room.fileId) !== room || !latestCm || !this.showsRoomFile(room)) {
        if (room.session === session) {
          session.destroy();
          room.session = null;
        }
        return;
      }
      replaceEditorText(latestCm, seed);
      session.seed(seed);
      this.bind(room, latestCm);
      room.synced = true;
    } else {
      this.requestState(room);
    }
  }

  /**
   * What the host starts a live session with: the server's current text, plus this device's edits that were not sent
   * yet (merged on top of it). Null when the server's version cannot be loaded right now.
   */
  private async hostSeed(room: Room, editorText: string): Promise<string | null> {
    const server = await this.deps.loadServerText(room.fileId);
    if (server === null) return null;
    if (server === editorText) return editorText;
    // Nothing typed here since the last sync: this editor is only behind, the server's text is the current one.
    if (await this.deps.isTextSynced(room.path, editorText)) return server;
    const base = await this.deps.mergeBase(room.path);
    const merged = base === null ? null : merge3(base, editorText, server);
    // Edits here that overlap with other changes: the session keeps this device's text, and the next write is refused by
    // the server as outdated, which merges it with the server's version or keeps that one as a copy.
    return merged ?? editorText;
  }

  private stopSession(room: Room): void {
    if (room.stateRequestTimer !== null) window.clearTimeout(room.stateRequestTimer);
    room.stateRequestTimer = null;
    this.unbind(room);
    room.session?.destroy();
    room.session = null;
    if (room.synced) {
      this.deps.log?.add({ kind: "live-leave", path: room.path });
      if (!this.disposed) this.deps.onLiveEnded?.(room.file);
    }
    room.synced = false;
  }

  /** Joiner: ask the host (lowest `seq` among the others) for everything we're missing; retried if it doesn't answer. */
  private requestState(room: Room): void {
    const session = room.session;
    if (!session) return;
    const host = room.peers.filter((peer) => peer.peerId !== room.you).sort((a, b) => a.seq - b.seq)[0];
    if (!host) return;

    this.relay(room, CollabKind.StateRequest, session.encodeStateVector(), host.peerId);

    if (room.stateRequestTimer !== null) window.clearTimeout(room.stateRequestTimer);
    room.stateRequestTimer = window.setTimeout(() => {
      room.stateRequestTimer = null;
      this.enqueue(() => {
        if (this.rooms.get(room.fileId) !== room || !room.session || room.synced) return;
        if (++room.stateRequestAttempts >= MAX_STATE_REQUEST_ATTEMPTS) {
          console.warn(`Syncstone: kein Live-Zustand für "${room.path}" erhalten - bleibt beim normalen Sync.`);
          this.stopSession(room);
          this.updateStatus();
          return;
        }
        this.requestState(room);
      });
    }, STATE_REQUEST_TIMEOUT_MS);
  }

  /** Host: send a joiner everything it is missing. */
  private async answerStateRequest(room: Room, from: string, stateVector: Uint8Array): Promise<void> {
    if (!room.session) {
      if (room.peers.length < 2) return;
      await this.startSession(room, true);
    }
    const session = room.session;
    if (!session || !room.synced) return; // we are still waiting for state ourselves
    this.relay(room, CollabKind.StateReply, session.encodeStateSince(stateVector), from);
    session.announce();
  }

  /** Joiner: the host's state arrived - take it over into the editor and go live. */
  private async applyStateReply(room: Room, update: Uint8Array): Promise<void> {
    const session = room.session;
    if (!session || room.synced) return;
    session.applyRemoteUpdate(update);
    const hostText = session.text();

    const cm = getEditorView(room.view);
    if (!cm || !canBind(cm) || !this.showsRoomFile(room)) {
      this.stopSession(room);
      return;
    }

    const before = cm.state.doc.toString();
    if (before !== hostText) {
      // Our editor differs from the host's. If those are just older synced contents, taking the
      // host's is right. But if this device has edits that never made it to the server (e.g. it
      // was offline), keep a copy of them instead of silently overwriting.
      const wasSynced = await this.deps.isTextSynced(room.path, before);
      const base = wasSynced ? null : await this.deps.mergeBase(room.path);
      if (this.rooms.get(room.fileId) !== room || room.session !== session) return;
      const latestCm = getEditorView(room.view);
      if (!latestCm || !this.showsRoomFile(room)) return;
      const now = latestCm.state.doc.toString();
      const hasOwnEdits = now !== hostText && (!wasSynced || now !== before);
      // Edits made here while the host did something else usually merge cleanly; only a real overlap needs a copy.
      const merged = hasOwnEdits && base !== null ? merge3(base, now, hostText) : null;
      if (hasOwnEdits && merged === null) await this.saveConflictCopy(room, now);
      if (merged !== null) this.deps.log?.add({ kind: "merged", path: room.path });
      replaceEditorText(latestCm, hostText);
      this.finishJoin(room, session, latestCm);
      if (merged !== null && merged !== hostText) {
        // After binding, so the merged result goes out to the other devices as an ordinary edit.
        const boundCm = getEditorView(room.view);
        if (boundCm && room.session === session) replaceEditorText(boundCm, merged);
      }
      return;
    }
    this.finishJoin(room, session, cm);
  }

  private finishJoin(room: Room, session: CollabSession, cm: EditorView): void {
    if (room.session !== session) return;
    if (room.stateRequestTimer !== null) window.clearTimeout(room.stateRequestTimer);
    room.stateRequestTimer = null;
    this.bind(room, cm);
    room.synced = true;
    this.deps.log?.add({ kind: "live-join", path: room.path });
    session.announce();
    this.updateStatus();
  }

  private bind(room: Room, cm: EditorView): void {
    const session = room.session;
    if (!session || !this.showsRoomFile(room)) return;
    bindEditor(cm, createCollabExtension(session.ytext, session.awareness));
    room.boundEditor = cm;
  }

  private unbind(room: Room): void {
    const cm = room.boundEditor;
    room.boundEditor = null;
    if (!cm) return;
    try {
      unbindEditor(cm);
    } catch {
      // The editor was already destroyed (tab closed) - nothing left to unbind.
    }
  }

  private relay(room: Room, kind: CollabKind, payload: Uint8Array, to?: string): void {
    sealCollabMessage(this.deps.crypto, room.fileId, kind, payload)
      .then((data) => {
        if (this.disposed || this.rooms.get(room.fileId) !== room) return;
        this.deps.send({ type: "collab_relay", fileId: room.fileId, ...(to ? { to } : {}), data });
      })
      .catch((err) => console.error("Syncstone: Live-Nachricht konnte nicht verschlüsselt werden", err));
  }

  /** Puts edits this device never uploaded next to the note before the host's version replaces them. */
  private async saveConflictCopy(room: Room, text: string): Promise<void> {
    const { vault } = this.deps.app;
    const base = room.file.path.replace(/\.md$/i, "");
    const stamp = new Date().toISOString().slice(0, 16).replace("T", " ").replace(":", "-");
    let candidate = `${base} (Konflikt ${stamp}).md`;
    for (let counter = 2; vault.getAbstractFileByPath(candidate); counter++) {
      candidate = `${base} (Konflikt ${stamp} ${counter}).md`;
    }
    try {
      await vault.create(candidate, text);
      new Notice(
        t("p.collab.conflictCopy", { from: room.path, to: candidate }),
        10_000,
      );
      this.deps.log?.add({ kind: "conflict", path: room.path, args: [candidate] });
    } catch (err) {
      console.error("Syncstone: Sicherungskopie konnte nicht erstellt werden", err);
    }
  }

  private updateStatus(): void {
    this.deps.onPresenceChange();
  }
}

function colorFor(colorIndex: number): string {
  return COLLAB_COLORS[colorIndex % COLLAB_COLORS.length];
}
