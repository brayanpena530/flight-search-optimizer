---
name: flight-optimizer-goals
description: Product goal and data-source status for the flight-search-optimizer project
metadata:
  type: project
---

The flight-search-optimizer's core purpose is to find the best purchasing option for a flight and decide whether to pay cash or use miles/points. The optimizer engine (cpp math, balance/threshold rules, transfer-partner logic, ranking) is complete and well-tested.

As of 2026-06-25: live **cash** fares work through Amadeus (real OAuth + flight-offers, now with cabin-mapping fix, 429 retry/backoff, per-search request budget, partial-failure tolerance, and a `/api/providers/health` connectivity check + UI button). To use live cash, set `AMADEUS_CLIENT_ID`/`AMADEUS_CLIENT_SECRET` in `.env`.

The remaining big gap is **live award data** — no automated retrieval from United/Delta/Southwest/JetBlue/Frontier exists; award prices must be imported manually as JSON. Duffel is still a stub. See README "Current limitations".
