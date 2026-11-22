import { describe, expect, it } from "vitest";
import { isReadOnlyQuery } from "../storage/surreal/surreal-client.js";
import { SOURCE_FACT_LOOKUP_SQL, SOURCE_TURN_LOOKUP_SQL } from "../storage/surreal/verified-source-turns.js";

// vk-2995: only a read-only query may be re-sent after its connection dropped
// mid-flight. Anything the check is unsure about must count as a write.

describe("isReadOnlyQuery", () => {
  it.each([
    "SELECT * FROM semiote WHERE user_id = $userId;",
    "  \n select id, search::score(1) AS s FROM semiote WHERE text @1@ $q ORDER BY s DESC LIMIT 10;",
    "SELECT id FROM semiote WHERE embedding <|10,300|> $qvec AND vector::similarity::cosine(embedding, $qvec) > 0.2;",
    "RETURN 1;",
    "RETURN $tag; SLEEP 1500ms; RETURN 'done';",
    "INFO FOR DB;",
    "SELECT count() AS count FROM replay_probe WHERE updated_at > $since GROUP ALL;",
    SOURCE_FACT_LOOKUP_SQL,
    SOURCE_TURN_LOOKUP_SQL,
  ])("treats %j as a read", (sql) => {
    expect(isReadOnlyQuery(sql)).toBe(true);
  });

  it.each([
    "CREATE staleness_backlog SET memory_id = $id;",
    "UPSERT project_state:abc SET summary = $s;",
    "UPDATE semiote SET active = false WHERE id = $id;",
    "DELETE semiote WHERE id = $id;",
    "INSERT INTO semiote $rows;",
    "RELATE $a->supports->$b;",
    "DEFINE TABLE replay_probe SCHEMALESS;",
    "REMOVE NAMESPACE test;",
    "LET $x = SELECT * FROM semiote; RETURN $x;",
    "SELECT * FROM semiote; DELETE semiote WHERE stale = true;",
    "SELECT * FROM (CREATE semiote SET text = 'x');",
    "RETURN fn::rebuild_index();",
    "RETURN http::post('https://example.com', {});",
    "SELECT * FROM semiote WHERE text CONTAINS 'delete';",
    "-- comment first\nSELECT * FROM semiote;",
    "BEGIN TRANSACTION; SELECT * FROM semiote; COMMIT TRANSACTION;",
    "SLEEP 1s;",
    "",
  ])("treats %j as a write", (sql) => {
    expect(isReadOnlyQuery(sql)).toBe(false);
  });
});
