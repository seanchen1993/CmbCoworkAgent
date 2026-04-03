# Trace Evolver Service

Local-only FastAPI service that ingests Cowork traces and exports trace-grounded skill bundle candidates.

## Run

```bash
cd trace_evolver_service
python -m uvicorn trace_evolver.main:app --reload
```

## Test

```bash
cd trace_evolver_service
pytest
```
