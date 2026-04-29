if (process.platform === "win32" && !global.lbug) {
  require("./common.js");
}

const itOnWindows = process.platform === "win32" ? it : it.skip;

itOnWindows("opens an on-disk database with a native absolute Windows path", async function () {
  const fs = require("fs");
  const path = require("path");

  const testRoot = "C:\\adham\\lbug-test";
  fs.rmSync(testRoot, { recursive: true, force: true });
  fs.mkdirSync(testRoot, { recursive: true });
  const dbPath = path.join(testRoot, "db_wasm_iso.lbug");
  assert.include(dbPath, "\\");
  assert.match(dbPath, /^C:\\/);

  let db;
  let conn;
  try {
    db = new lbug.Database(dbPath);
    conn = new lbug.Connection(db);
    await conn.query("CREATE NODE TABLE IF NOT EXISTS T(id STRING PRIMARY KEY)");
    await conn.query("CREATE (:T {id: 'one'})");
    const res = await conn.query("MATCH (t:T) RETURN t.id");
    const rows = await res.getAll();
    assert.deepEqual(rows, [{ "t.id": "one" }]);
    res.close();
  } finally {
    if (conn) {
      await conn.close();
    }
    if (db) {
      await db.close();
    }
    fs.rmSync(testRoot, { recursive: true, force: true });
  }
});
