// Execution/ownership/repair policies only. Business verdicts belong to the rules Mod.
import source0 from "./policy-sources/hooks-command_executable"
import source1 from "./policy-sources/hooks-compile_command_policy"
import source2 from "./policy-sources/hooks-plan_write_ownership"
import source3 from "./policy-sources/hooks-performance_rules"
import source4 from "./policy-sources/hooks-utest_repair_contract"
import source5 from "./policy-sources/repair"
import source6 from "./policy-sources/performance"
import source7 from "./policy-sources/safe_paths"

export const rules = {
  "hooks/command_executable.py": source0,
  "hooks/compile_command_policy.py": source1,
  "hooks/plan_write_ownership.py": source2,
  "hooks/performance_rules.py": source3,
  "hooks/utest_repair_contract.py": source4,
  "repair.py": source5,
  "performance.py": source6,
  "safe_paths.py": source7
}
