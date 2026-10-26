// Retained connection epoch 57: optional inbox delivery state preserves existing authoring.
import { defineMcpClientConnection } from "#public/connections/index.js";

export default defineMcpClientConnection({
  description: "Read Bob's calendar.",
  url: "https://calendar.example.com/mcp",
});
