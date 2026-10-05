# Configuration

Runtime environment variables are parsed in `@onecore/config`. `.env.example` contains non-secret local defaults; real `.env` files are ignored by Git. Production secrets must come from the deployment platform's secret manager and must never be logged or committed.
