import { e2eModel } from "@eve-e2e/config";
import { defineCompaction, fixedTail } from "eve/compaction";

const summarized = fixedTail({ model: e2eModel() });

export default defineCompaction({
  compact: (history, context) => summarized.compact(history, context),
});
