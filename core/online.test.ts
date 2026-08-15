import { describe, expect, it } from "vitest";
import { MemoryMailboxStore, resolveMailbox } from "./mailbox-store.ts";
import type { Mailbox, MailboxEntry } from "./mailbox.ts";
import { DataChannelTransport } from "./webrtc.ts";
import { advertiseOnline, fetchAnnouncement, matchOnlineSession } from "./online.ts";
import { StreamReceiver, StreamSender } from "./session.ts";
import { arraySource } from "./chunker.ts";
import { initCrypto } from "./crypto.ts";

class FakeDataChannel {
  readonly label: string;
  readyState: "connecting" | "open" | "closing" | "closed" = "connecting";
  binaryType = "blob";
  bufferedAmount = 0;
  onopen: ((ev?: unknown) => void) | null = null;
  onmessage: ((ev: unknown) => void) | null = null;
  onclose: ((ev?: unknown) => void) | null = null;
  onerror: ((ev?: unknown) => void) | null = null;
  private peer: FakeDataChannel | null = null;

  constructor(label: string) {
    this.label = label;
  }

  static pair(label: string): [FakeDataChannel, FakeDataChannel] {
    const a = new FakeDataChannel(label);
    const b = new FakeDataChannel(label);
    a.peer = b;
    b.peer = a;
    return [a, b];
  }

  send(data: ArrayBuffer | ArrayBufferView): void {
    const view = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    const copy = new Uint8Array(view);
    this.bufferedAmount += copy.byteLength;
    queueMicrotask(() => {
      this.bufferedAmount = 0;
      if (this.peer && this.peer.readyState === "open") {
        this.peer.onmessage?.({ data: copy.buffer as ArrayBuffer });
      }
    });
  }

  close(): void {
    if (this.readyState !== "closed") this.readyState = "closed";
  }

  drop(): void {
    if (this.readyState === "closed") return;
    this.readyState = "closed";
    this.onclose?.();
    if (this.peer && this.peer.readyState !== "closed") {
      this.peer.readyState = "closed";
      this.peer.onclose?.();
    }
  }

  open(): void {
    if (this.readyState !== "open") {
      this.readyState = "open";
      this.onopen?.();
    }
  }
}

class FakeIceCandidate {
  constructor(
    private readonly tag: string,
    private readonly mline: number,
  ) {}

  toJSON(): RTCIceCandidateInit {
    return { candidate: this.tag, sdpMid: "0", sdpMLineIndex: this.mline };
  }
}

class FakePeerConnection {
  localDescription: RTCSessionDescriptionInit | null = null;
  remoteDescription: RTCSessionDescriptionInit | null = null;
  connectionState: RTCPeerConnectionState = "new";
  onicecandidate: ((ev: { candidate: FakeIceCandidate | null }) => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;
  ondatachannel: ((ev: { channel: FakeDataChannel }) => void) | null = null;
  iceReceived: RTCIceCandidateInit[] = [];
  restartCount = 0;
  private peer: FakePeerConnection | null = null;
  private a: FakeDataChannel | null = null;
  private b: FakeDataChannel | null = null;
  private offerSeq = 0;

  constructor(private readonly tag: string) {}

  static makePair(): [FakePeerConnection, FakePeerConnection] {
    const a = new FakePeerConnection("pcA");
    const b = new FakePeerConnection("pcB");
    a.peer = b;
    b.peer = a;
    return [a, b];
  }

  createDataChannel(label: string): FakeDataChannel {
    const [a, b] = FakeDataChannel.pair(label);
    this.a = a;
    this.b = b;
    return a;
  }

  async createOffer(): Promise<RTCSessionDescriptionInit> {
    return { type: "offer", sdp: `offer-${++this.offerSeq}-${Date.now()}-${Math.random()}` };
  }

  async createAnswer(): Promise<RTCSessionDescriptionInit> {
    return { type: "answer", sdp: `answer-${Date.now()}-${Math.random()}` };
  }

  async setLocalDescription(desc: RTCSessionDescriptionInit): Promise<void> {
    this.localDescription = desc;
    queueMicrotask(() => {
      if (this.onicecandidate) {
        this.onicecandidate({ candidate: new FakeIceCandidate(`${this.tag}-host-cand`, 0) });
        this.onicecandidate({ candidate: new FakeIceCandidate(`${this.tag}-srflx-cand`, 0) });
        this.onicecandidate({ candidate: null });
      }
    });
  }

  async setRemoteDescription(desc: RTCSessionDescriptionInit): Promise<void> {
    this.remoteDescription = desc;
    if (desc.type === "offer" && this.peer) {
      queueMicrotask(() => {
        if (this.peer?.b) this.ondatachannel?.({ channel: this.peer.b as FakeDataChannel });
      });
    } else if (desc.type === "answer" && this.peer) {
      queueMicrotask(() => {
        this.peer?.openChannels();
      });
    }
  }

  async addIceCandidate(candidate: RTCIceCandidateInit): Promise<void> {
    this.iceReceived.push(candidate);
  }

  restartIce(): void {
    this.restartCount++;
  }

  close(): void {
    if (this.connectionState !== "closed") {
      this.connectionState = "closed";
      this.onconnectionstatechange?.();
    }
  }

  failAndDrop(): void {
    if (this.connectionState !== "failed") {
      this.connectionState = "failed";
      this.onconnectionstatechange?.();
    }
    if (this.peer?.connectionState !== "failed") {
      if (this.peer) {
        this.peer.connectionState = "failed";
        this.peer.onconnectionstatechange?.();
      }
    }
    this.a?.drop();
    this.b?.drop();
    this.peer?.a?.drop();
    this.peer?.b?.drop();
  }

  private openChannels(): void {
    if (this.connectionState !== "connected") {
      this.connectionState = "connected";
      this.onconnectionstatechange?.();
    }
    if (this.peer?.connectionState !== "connected" && this.peer) {
      this.peer.connectionState = "connected";
      this.peer.onconnectionstatechange?.();
    }
    this.a?.open();
    this.b?.open();
    this.peer?.a?.open();
    this.peer?.b?.open();
  }
}

function storeMailbox(store: MemoryMailboxStore): (sessionId: string) => Mailbox {
  return (sessionId) => {
    const box = {} as Mailbox;
    box.put = async (kind, payload) => {
      const res = await resolveMailbox(store, { route: [sessionId, kind], method: "POST", since: null, payload });
      if (res.status !== 200) throw new Error(`put failed (${res.status})`);
      return (res.json as { i: number }).i;
    };
    box.get = async (kind, since = 0) => {
      const res = await resolveMailbox(store, { route: [sessionId, kind], method: "GET", since, payload: null });
      if (res.status !== 200) throw new Error(`get failed (${res.status})`);
      return res.json as { entries: MailboxEntry[]; now: number; ttlSeconds: number | null };
    };
    return box;
  };
}

const quick = { iceServers: [] as RTCIceServer[], pollMs: 5 };

describe("DataChannelTransport", () => {
  it("buffers frames until the channel opens, then flushes in order", async () => {
    const [a, b] = FakeDataChannel.pair("data");
    const ta = new DataChannelTransport();
    const tb = new DataChannelTransport();
    const received: string[] = [];
    tb.onMessage((f) => received.push(new TextDecoder().decode(f)));
    ta.attach(a);
    tb.attach(b);
    ta.send(new TextEncoder().encode("one"));
    ta.send(new TextEncoder().encode("two"));
    expect(received).toEqual([]);
    a.open();
    b.open();
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 1));
    expect(received).toEqual(["one", "two"]);
    a.drop();
    expect(ta.peerClosed).toBe(true);
  });

  it("flags peer closure and keeps queuing frames instead of throwing", async () => {
    const [a, b] = FakeDataChannel.pair("data");
    const ta = new DataChannelTransport();
    const tb = new DataChannelTransport();
    ta.attach(a);
    tb.attach(b);
    a.open();
    expect(ta.peerClosed).toBe(false);
    a.drop();
    expect(ta.peerClosed).toBe(true);
    expect(() => ta.send(new Uint8Array(1))).not.toThrow();
    b.drop();
    expect(() => tb.send(new Uint8Array(1))).not.toThrow();
  });
});

describe("online pairing and transfer", () => {
  it("fetchAnnouncement rejects unknown or expired sessions", async () => {
    await initCrypto();
    const store = new MemoryMailboxStore();
    const mailboxFor = storeMailbox(store);
    await expect(fetchAnnouncement("0123456789abcdef", mailboxFor)).rejects.toThrow("expired");
  });

  it("runs the full handshake and moves real bytes over a fake datachannel", async () => {
    await initCrypto();
    const store = new MemoryMailboxStore();
    const mailboxFor = storeMailbox(store);
    const [pcA, pcB] = FakePeerConnection.makePair();

    const sender = advertiseOnline({ name: "doc.bin", size: 300_000 }, mailboxFor, {
      ...quick,
      pcFactory: () => pcA as unknown as RTCPeerConnection,
    });

    const announce = await fetchAnnouncement(sender.sessionId, mailboxFor);
    expect(announce.wordPair).toBe(sender.wordPair);
    expect(announce.file).toEqual({ name: "doc.bin", size: 300_000 });

    const receiver = matchOnlineSession(announce, mailboxFor, {
      ...quick,
      pcFactory: () => pcB as unknown as RTCPeerConnection,
    });
    expect(receiver.pin).toBeNull();

    const payload = new Uint8Array(300_000);
    for (let i = 0; i < payload.length; i++) payload[i] = (i * 31 + 7) & 0xff;

    const senderStates: string[] = [];
    sender.onState((s) => senderStates.push(s));
    const receiverStates: string[] = [];
    receiver.onState((s) => receiverStates.push(s));

    let receiverFp = "";
    sender.onMatch((peer) => {
      receiverFp = peer.receiverFingerprint;
      sender.notifyGo();
    });
    sender.onFailure((m) => {
      throw new Error(m);
    });

    const senderDone = new Promise<void>((resolve, reject) => {
      sender.start((room) => {
        expect(room.receiverFingerprint).toBe(receiverFp);
        const stream = new StreamSender(room.sessionId, room.sessionKey, arraySource(payload, "doc.bin", "application/octet-stream"), {
          onEvent: (e) => {
            if (e.type === "done") resolve();
            if (e.type === "error") reject(new Error(e.message));
          },
        });
        stream.run(room.channel);
      });
    });

    const receiverDone = new Promise<void>((resolve, reject) => {
      receiver.onGo(() => {
        receiver.postReady();
        const pin = receiver.pin;
        if (!pin) {
          reject(new Error("no pin after go"));
          return;
        }
        const stream = new StreamReceiver(pin.sessionId, pin.sessionKey, (e) => {
          if (e.type === "error") reject(new Error(e.message));
        });
        stream.onComplete((res) => {
          if (!res.ok) {
            reject(new Error(res.message));
            return;
          }
          expect(res.header.filename).toBe("doc.bin");
          expect(res.header.originalSize).toBe(payload.length);
          expect(res.data).toEqual(payload);
          resolve();
        });
        stream.start(pin.channel);
      });
      receiver.onFailure((m) => reject(new Error(m)));
    });

    receiver.confirm();
    await Promise.all([senderDone, receiverDone]);

    expect(receiverStates).toContain("open");
    expect(senderStates).toContain("open");
    const receivedOnA = pcA.iceReceived.map((c) => (c.candidate ?? "").split("-")[0]);
    const receivedOnB = pcB.iceReceived.map((c) => (c.candidate ?? "").split("-")[0]);
    expect(receivedOnB).toContain("pcA");
    expect(receivedOnA).toContain("pcB");
    expect(receivedOnA).not.toContain("pcA");
    expect(receivedOnB).not.toContain("pcB");

    sender.stop();
    receiver.cancel();
  });

  it("recovers once after a dropped connection via ICE restart", async () => {
    await initCrypto();
    const store = new MemoryMailboxStore();
    const mailboxFor = storeMailbox(store);
    const [pcA, pcB] = FakePeerConnection.makePair();

    const sender = advertiseOnline(null, mailboxFor, {
      ...quick,
      pcFactory: () => pcA as unknown as RTCPeerConnection,
    });
    const announce = await fetchAnnouncement(sender.sessionId, mailboxFor);
    const receiver = matchOnlineSession(announce, mailboxFor, {
      ...quick,
      pcFactory: () => pcB as unknown as RTCPeerConnection,
    });

    const senderStates: string[] = [];
    sender.onState((s) => senderStates.push(s));
    const receiverStates: string[] = [];
    receiver.onState((s) => receiverStates.push(s));

    sender.onMatch(() => sender.notifyGo());
    const senderReady = new Promise<void>((resolve, reject) => {
      sender.start(() => resolve());
      sender.onFailure((m) => reject(new Error(m)));
    });
    const receiverReady = new Promise<void>((resolve, reject) => {
      receiver.onGo(() => {
        receiver.postReady();
        resolve();
      });
      receiver.onFailure((m) => reject(new Error(m)));
    });
    receiver.confirm();
    await Promise.all([senderReady, receiverReady]);

    await new Promise((r) => setTimeout(r, 30));
    expect(senderStates).toContain("open");
    expect(receiverStates).toContain("open");

    pcB.failAndDrop();
    await new Promise((r) => setTimeout(r, 150));

    expect(senderStates).toContain("reconnecting");
    expect(receiverStates).toContain("reconnecting");
    expect(pcB.restartCount).toBeGreaterThanOrEqual(1);
    await new Promise((r) => setTimeout(r, 150));
    expect(senderStates.includes("open") && senderStates.lastIndexOf("open") > senderStates.indexOf("reconnecting")).toBe(true);
    expect(receiverStates.includes("open") && receiverStates.lastIndexOf("open") > receiverStates.indexOf("reconnecting")).toBe(true);

    sender.stop();
    receiver.cancel();
  });
});