const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Vault, pageId } = require("../src/core.cjs");
const A = "12345678123412341234123456789abc",
  B = "abcdefabcdefabcdefabcdefabcdefab";
const make = () =>
  new Vault(
    path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), "npl-test-")),
      "state.json",
    ),
  );
test("page identity is stable across slugs, UUIDs, fragments and peek query", () => {
  assert.equal(pageId("https://www.notion.so/LifeOS-" + A + "#block"), A);
  assert.equal(
    pageId("https://app.notion.com/12345678-1234-1234-1234-123456789abc"),
    A,
  );
  assert.equal(pageId("https://www.notion.so/" + A + "?p=" + B), B);
  for (const u of [
    "https://notion.so.evil.test/" + A,
    "https://evilnotion.so/" + A,
    "http://notion.so/" + A,
    "https://notion.so/login",
  ])
    assert.equal(pageId(u), null);
});
test("independent password, durable locks, wrong password and relaunch", async () => {
  const v = make();
  await assert.rejects(v.setup("short"));
  await v.setup("correct horse battery");
  v.protect(A, "LifeOS");
  assert(!fs.readFileSync(v.file, "utf8").includes("correct horse battery"));
  assert.equal(fs.statSync(v.file).mode & 0o777, 0o600);
  assert.equal(await v.verify("correct horse battery"), true);
  v.unlocked.add(A);
  assert.deepEqual(v.state().lockedIds, []);
  const restored = new Vault(v.file);
  assert.deepEqual(restored.state().lockedIds, [A]);
  assert.equal(await restored.verify("wrong password"), false);
  await assert.rejects(restored.verify("wrong password"), /稍后/);
  v.lockAll();
  assert.deepEqual(v.state().lockedIds, [A]);
  v.remove(A);
  assert.deepEqual(new Vault(v.file).state().protectedIds, []);
});
test("corrupted configuration fails closed and is never overwritten", async () => {
  const v = make();
  fs.writeFileSync(v.file, "{broken");
  const c = new Vault(v.file);
  assert(c.state().corrupt);
  await assert.rejects(c.setup("a long enough password"));
  assert.throws(() => c.save());
  assert.equal(fs.readFileSync(v.file, "utf8"), "{broken");
});
test("a failed disk write never changes the protection policy in memory", async () => {
  const v = make();
  await v.setup("a correct test password");
  v.protect(A, "LifeOS");
  const file = v.file,
    before = fs.readFileSync(file, "utf8"),
    generation = v.generation;
  v.file = path.join(file, "invalid-child");
  assert.throws(() => v.remove(A));
  assert.deepEqual(v.state().lockedIds, [A]);
  assert.throws(() => v.protect(B, "Another"));
  assert.deepEqual(v.state().protectedIds, [A]);
  assert.equal(v.generation, generation);
  assert.equal(fs.readFileSync(file, "utf8"), before);
});
test("malformed saved page metadata fails closed", async () => {
  const v = make();
  await v.setup("a correct test password");
  const data = { ...v.data, pages: { [A]: null } };
  fs.writeFileSync(v.file, JSON.stringify(data));
  assert(new Vault(v.file).state().corrupt);
});
