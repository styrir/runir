// auth.ts reads RUNIR_API_KEY/RUNIR_REQUIRE_API_KEY directly, so without this
// hermetic shim operator-exported values leak past vi.mock and produce 401s.
delete process.env.RUNIR_API_KEY;
delete process.env.RUNIR_REQUIRE_API_KEY;
