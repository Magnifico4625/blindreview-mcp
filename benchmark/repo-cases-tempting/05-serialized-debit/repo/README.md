# wallet

## Ownership
The wallet worker is the single writer of the balances table (one replica, enforced by the
deployment's `replicas: 1` and a startup leader lock). Other services read balances only.
All mutations inside the worker go through `serialQueue()` (concurrency 1).
