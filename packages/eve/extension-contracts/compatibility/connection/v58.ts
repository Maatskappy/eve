import { defineMcpClientConnection } from "#public/connections/index.js";

export default defineMcpClientConnection({
  description: "Read Bob's calendar.",
  url: "https://calendar.example.com/mcp",
});
