# vk-2995 live evidence

Run at `59ffd45` on a clean tree. The commit adding this file changes nothing
else, so the code it describes is the code in the commit that contains it.

Command, from the repo root:

```
RUNIR_TEST_SLOW_LANE=1 RUNIR_TEST_SURREAL_URL=http://127.0.0.1:8000 npx vitest run src/__tests__/surreal-client-reconnect-live-sql.test.ts src/__tests__/surreal-read-classifier.test.ts src/__tests__/lock-outcome-unknown.test.ts
```

In slow-lane mode `beforeAll` throws when SurrealDB is unreachable, so these
tests fail rather than skip. Server: SurrealDB 3.1.4.

**56 passed, 0 failed, 0 skipped** (of 56).

## surreal-client-reconnect-live-sql.test.ts (18, live)

Each test counts what the client put on the socket and, for writes, what the
server committed (rows, or the next sequence value).

- ✅ re-sends a read pending during a dropped socket once, then recovers and logs the drop
- ✅ does not re-send a write lost with its socket and reports its outcome as unknown
- ✅ does not re-send a write batch after one of its statements failed, whatever the message
- ✅ does not re-send a read-only batch after one of its statements failed, whatever the message
- ✅ signs in again and re-sends once when the server refuses the whole request as unauthenticated
- ✅ reports an unknown outcome when the socket drops during a write's permitted re-send
- ✅ re-sends a write once when the real SDK refused to send it on a closed socket
- ✅ acquireLock returns its lease when the CREATE committed but the response was lost
- ✅ does not re-send a RETURN that advanced a sequence when its response was lost
- ✅ releaseLock re-sends its holder-scoped DELETE once when the response was lost
- ✅ re-sends a write once when the SDK refused the first send with ConnectionUnavailableError
- ✅ sends a write issued after the socket dropped exactly once, on a new connection
- ✅ fails instead of looping when the socket drops again during a read's re-send
- ✅ does not re-send a read whose caller timed out before the socket dropped
- ✅ does not re-send a read whose caller timed out while the reconnect was under way
- ✅ fails fast while reconnects are refused and recovers once the database is reachable
- ✅ gives up on a reconnect whose handshake never completes, then recovers
- ✅ does not send queries from work that was abandoned before they started

## lock-outcome-unknown.test.ts (4)

- ✅ returns the holder when the lease did commit, so the caller releases it
- ✅ rethrows when the lease did not commit
- ✅ rethrows when the read-back fails; the lease, if any, expires after its TTL
- ✅ marks its holder-scoped DELETE safe to re-send

## surreal-read-classifier.test.ts (34)

All 34 passed: 10 reads and 24 writes. Writes include `sequence::nextval`,
`file::`, an unknown namespace, `fn::`, `http::`, `ml::` and `api::` calls,
writes later in a batch, nested writes, and conservative handling of
comments and literals.

## Against the previous client

With `surreal-client.ts` from `2140e4f` (the classifier before this fix), 5
of these tests fail: the four new classifier write cases (`sequence::` twice,
`file::`, an unknown namespace) and the live sequence test.
