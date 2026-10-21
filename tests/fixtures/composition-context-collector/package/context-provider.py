"""Collect real declared business facts using only Python's standard library."""
import argparse
import json
import os
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument("--devclaw-operation", required=True, choices=["session-context"])
operation, arguments = parser.parse_known_args()
if arguments != ["--", "--collect"]:
    raise ValueError("Unexpected collector invocation")

knowledge = Path(os.environ["DEVCLAW_KNOWLEDGE_ROOT"]).resolve(strict=True)
if os.environ["DEVCLAW_KNOWLEDGE_READONLY"] != "1":
    raise ValueError("Business knowledge must have an explicit read-only binding")
configuration = json.loads(Path(os.environ["DEVCLAW_RUNTIME_CONFIG_PATH"]).read_text("utf-8"))
commands = configuration["inspectCommands"]
if not commands or any(Path(row["knowledge_path"]).resolve() != knowledge for row in commands.values()):
    raise ValueError("Runtime configuration must use the host-resolved knowledge binding")


def read_fact(relative):
    target = (knowledge / relative).resolve(strict=True)
    target.relative_to(knowledge)
    if not target.is_file():
        raise ValueError("Declared business fact is not a regular file")
    return target.read_text("utf-8")


manifest = json.loads(read_fact("agents.manifest.json"))
facts = []
candidates = []
for system in manifest["systems"]:
    facts.append(read_fact(system["agentsPath"]))
    for unit in system["deployUnits"]:
        identifier = unit["deployUnitId"]
        if not isinstance(identifier, str) or not identifier or identifier.strip() != identifier:
            raise ValueError("Invalid declared deployment unit")
        candidates.append(identifier)
        facts.append(read_fact(unit["factsPath"]))
if len(candidates) != len(set(candidates)):
    raise ValueError("Duplicate deployment unit")

data = Path(os.environ["DEVCLAW_PLUGIN_DATA_ROOT"])
with (data / "collector-runs.jsonl").open("a", encoding="utf-8") as evidence:
    evidence.write(json.dumps({"pid": os.getpid(), "candidates": sorted(candidates)}) + "\n")
print(json.dumps({"candidates": sorted(candidates), "sessionContext": "\n".join(facts)}))
