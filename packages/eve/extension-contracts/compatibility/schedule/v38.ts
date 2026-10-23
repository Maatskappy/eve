import { defineChannel } from "#public/channels/index.js";
import { defineSchedule } from "#public/schedules/index.js";

const reports = defineChannel({
  routes: [],
  receive(input, { from }) {
    return from("reports").send(input.message, { auth: input.auth });
  },
});

export default defineSchedule({
  cron: "0 2 * * *",
  async run({ to, appAuth }) {
    await to(reports, {}).send("Prepare Alice's report.", { auth: appAuth });
  },
});
