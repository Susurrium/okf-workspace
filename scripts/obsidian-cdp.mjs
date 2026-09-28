const [port = "9222", expression, timeoutArg = "10000"] = process.argv.slice(2);
if (!expression) {
  console.error("Usage: node scripts/obsidian-cdp.mjs <port> <JavaScript expression>");
  process.exit(2);
}

const targets = await fetch(`http://127.0.0.1:${port}/json`).then((response) => response.json());
const page = targets.find((target) => target.type === "page");
if (!page?.webSocketDebuggerUrl) throw new Error("No Obsidian page target found");

const socket = new WebSocket(page.webSocketDebuggerUrl);
const result = await new Promise((resolve, reject) => {
  const timeoutMs = Number.parseInt(timeoutArg, 10);
  const timer = setTimeout(
    () => reject(new Error("CDP evaluation timed out")),
    Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 10_000,
  );
  socket.addEventListener("open", () => {
    socket.send(JSON.stringify({
      id: 1,
      method: "Runtime.evaluate",
      params: {
        expression,
        awaitPromise: true,
        returnByValue: true,
      },
    }));
  });
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data));
    if (message.id !== 1) return;
    clearTimeout(timer);
    if (message.error) reject(new Error(message.error.message));
    else if (message.result?.exceptionDetails) {
      const details = message.result.exceptionDetails;
      reject(new Error(details.exception?.description ?? details.text));
    } else resolve(message.result?.result?.value);
  });
  socket.addEventListener("error", () => reject(new Error("CDP WebSocket failed")));
});
socket.close();
console.log(JSON.stringify(result, null, 2));
