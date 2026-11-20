// The external omp boundary only; both web servers and the host daemon are real.
import * as fs from "node:fs";
import * as readline from "node:readline";
if (process.argv.includes("--version")) {
  console.log("18.15.0-multi-server-test");
  process.exit(0);
}
const sessionId = process.env.PI_MULTI_SESSION_ID;
const sessionFile = process.env.PI_MULTI_SESSION_FILE;
const record = (entry) => fs.appendFileSync(process.env.PI_MULTI_LOG, `${JSON.stringify({ pid: process.pid, ...entry })}\n`);
const send = (frame) => process.stdout.write(`${JSON.stringify(frame)}\n`);
const out = (event) => send(event);
const resumed = process.argv.includes("--session");
record({ type: "start", resumed });
let streaming = false;
let messages = [];
let timer;
let promptNumber = 0;
const saved = fs.readFileSync(sessionFile, "utf8").trim().split("\n").map(JSON.parse);
let parentId = saved.findLast((entry) => entry.type !== "session" && entry.id)?.id ?? null;
let entryNumber = 0;
const persist = (message, clientMessageId) => {
  const id = `native-${process.pid}-${++entryNumber}`;
  fs.appendFileSync(sessionFile, `${JSON.stringify({ type: "message", id, parentId, timestamp: new Date().toISOString(), message, ...(clientMessageId ? { clientMessageId } : {}) })}\n`);
  parentId = id;
};
const end = () => {
  streaming = false;
  clearTimeout(timer);
  out({ type: "agent_end", isTerminal: true, messages: [] });
  out({ type: "session_settled" });
};
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const command = JSON.parse(line);
  record({ type: "stdin", command });
  if (command.type === "ui_response") {
    // tau names the dialog by its wire id as a string.
    record({ type: "answer", id: String(command.id) });
    return end();
  }
  const args = command;
  const reply = (data = {}) => send({ type: "response", id: command.id, command: command.type, success: true, data });
  switch (command.type) {
    case "get_state": return reply({ sessionId, sessionFile, cwd: process.cwd(), supportsClientMessageIds: true, isStreaming: streaming, isSettled: !streaming, isCompacting: false, queuedMessages: [], messages });
    case "get_subagents": return reply({ subagents: [] });
    case "get_btw_history": return reply({ records: [] });
    case "clear_queue": return reply({ steering: [], followUp: [] });
    case "abort":
      reply();
      return end();
    case "prompt": {
      reply({ agentInvoked: true });
      streaming = true;
      const n = ++promptNumber;
      const user = { role: "user", content: [{ type: "text", text: args.message }], timestamp: Date.now() };
      messages.push(user);
      out({ type: "agent_start" });
      const correlation = args.clientMessageId ? { clientMessageId: args.clientMessageId } : {};
      out({ type: "message_start", messageId: `u${n}`, message: user, ...correlation });
      persist(user, args.clientMessageId);
      out({ type: "message_end", messageId: `u${n}`, message: user, ...correlation });
      if (args.message === "ask") {
        send({ type: "ui_request", id: n, method: "askDialog", args: [[{ id: "pick", question: "Pick one", options: [{ label: "A" }, { label: "B" }] }]] });
        return;
      }
      const assistant = { role: "assistant", content: [{ type: "text", text: "" }], timestamp: Date.now() };
      out({ type: "message_start", messageId: `a${n}`, message: assistant });
      assistant.content[0].text = "one";
      out({ type: "message_update", messageId: `a${n}`, message: { role: "assistant" },
        assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "one" } });
      out({ type: "tool_execution_start", toolCallId: `t${n}`, toolName: "read", args: { path: "shared.txt" } });
      out({ type: "tool_execution_end", toolCallId: `t${n}`, toolName: "read",
        result: { content: [{ type: "text", text: "one shared result" }],
          ...(args.message === "from B" ? { details: { largeResult: "x".repeat(1_100_000) } } : {}) }, isError: false });
      timer = setInterval(() => {
        if (args.message === "slow" && !fs.existsSync(process.env.PI_MULTI_RELEASE_FILE)) return;
        assistant.content[0].text = "one two";
        out({ type: "message_update", messageId: `a${n}`, message: { role: "assistant" },
          assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: " two" } });
        messages.push(assistant);
        persist(assistant);
        out({ type: "message_end", messageId: `a${n}`, message: assistant });
        end();
      }, args.message === "slow" ? 50 : 300);
      return;
    }
    default: return reply();
  }
});
process.stdin.on("end", () => process.exit(0));
