export class LocalEventService {
  constructor() {
    this.channels = new Map();
    this.lastProgress = null;
  }

  channel(name) {
    if (!this.channels.has(name)) this.channels.set(name, new Set());

    return this.channels.get(name);
  }

  emit(channelName, type, payload = {}) {
    const eventPayload = {
      ...payload,
      emittedAt: new Date().toISOString(),
    };
    const frame =
      type === "message"
        ? `data: ${JSON.stringify(eventPayload)}\n\n`
        : `event: ${type}\ndata: ${JSON.stringify(eventPayload)}\n\n`;

    if (channelName === "progress") this.lastProgress = eventPayload;

    this.channel(channelName).forEach((client) => {
      client.write(frame);
    });

    return eventPayload;
  }

  progress(payload = {}) {
    return this.emit("progress", "message", payload);
  }

  cache(type, payload = {}) {
    return this.emit("cache", type, payload);
  }

  stream(channelName, req, res) {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-store",
      Connection: "keep-alive",
      "Access-Control-Allow-Origin": "*",
    });
    res.write(": connected\n\n");

    if (channelName === "progress" && this.lastProgress) {
      res.write(`data: ${JSON.stringify(this.lastProgress)}\n\n`);
    }

    const clients = this.channel(channelName);

    clients.add(res);

    req.on("close", () => {
      clients.delete(res);
    });
  }
}
