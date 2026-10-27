import { e2eModel } from "@eve-e2e/config";
import { type CompactionStrategy, fixedTail } from "eve/compaction";

const compaction: CompactionStrategy = fixedTail({ model: e2eModel() });

export default compaction;
