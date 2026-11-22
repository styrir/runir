# vk-2995 live evidence

Run at `c63f52e` on a clean tree. The commit adding this file changes nothing
else, so the code it describes is the code in the commit that contains it.

Command, from the repo root:

```
RUNIR_TEST_SLOW_LANE=1 RUNIR_TEST_SURREAL_URL=http://127.0.0.1:8000 npx vitest run src/__tests__/surreal-client-reconnect-live-sql.test.ts src/__tests__/surreal-read-classifier.test.ts src/__tests__/lock-outcome-unknown.test.ts
```

In slow-lane mode `beforeAll` throws when SurrealDB is unreachable, so these
tests fail rather than skip. Server: SurrealDB 3.1.4.

**72 passed, 0 failed, 0 skipped** (of 72).

## surreal-client-reconnect-live-sql.test.ts (23, live)

The re-send tests count what the client put on the socket and, for writes,
what the server committed: rows, lease rows, or the next sequence value. The
connection tests (refused reconnects, stalled handshake) check timing and
recovery instead.

The expired-token and invalid-auth tests inject the SDK's `NotAllowedError`
with the server's detail shape, because inducing those refusals for real
would mean changing root users on the shared server. The anonymous-session
test uses the server's real refusal.

- ✅ re-sends a read pending during a dropped socket once, then recovers and logs the drop
- ✅ does not re-send a write lost with its socket and reports its outcome as unknown
- ✅ does not re-send a write batch after one of its statements failed, whatever the message
- ✅ does not re-send a read-only batch after one of its statements failed, whatever the message
- ✅ signs in again and re-sends once when the server refuses the whole request as unauthenticated
- ✅ reports an unknown outcome when the socket drops during a write's permitted re-send
- ✅ re-sends a write once when the real SDK refused to send it on a closed socket
- ✅ acquireLock returns its lease when the CREATE committed but the response was lost
- ✅ does not re-send a RETURN that advanced a sequence when its response was lost (plain)
- ✅ does not re-send a RETURN that advanced a sequence when its response was lost (inside an object, after a field's colon)
- ✅ does not re-send a RETURN that advanced a sequence when its response was lost (spaced around ::)
- ✅ acquireLock rethrows when its lease committed but expired before the read-back
- ✅ signs in again and re-sends once after a whole-request TokenExpired refusal
- ✅ signs in again and re-sends once after a whole-request InvalidAuth refusal
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

## surreal-read-classifier.test.ts (45)

All 45 passed: 11 reads and 34 writes. Writes include `sequence::nextval`
written plain, inside an object after a field's colon, spaced around `::`
(spaces, newline, tab), and with each comment style before `::`; an escaped
name, a bare `::`, `file::`, an unknown namespace, `fn::`, `http::`, `ml::`
and `api::`; writes later in a batch and nested writes. Reads include a
spaced allowlisted chain inside an object.

## Against the previous client

Run by hand, not recorded beyond this note: with `surreal-client.ts` from
`e3a1537` (the classifier before this fix), 11 of these tests fail. Nine are
classifier cases (the spaced allowlisted read and eight write spellings);
two are the live sequence tests for the object and spaced spellings.
