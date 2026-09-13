"use strict";
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { promisify } = require("node:util");
const scrypt = promisify(crypto.scrypt);
function pageId(value) {
  if (typeof value !== "string") return null;
  try {
    const u = new URL(value);
    if (
      u.protocol !== "https:" ||
      !["notion.so", "notion.com"].some(
        (h) => u.hostname === h || u.hostname.endsWith("." + h),
      )
    )
      return null;
    const candidate =
      u.searchParams.get("p") ||
      u.pathname.split("/").filter(Boolean).at(-1) ||
      "";
    const match = candidate.match(
      /([0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i,
    );
    return match ? match[1].replaceAll("-", "").toLowerCase() : null;
  } catch {
    return null;
  }
}
class Vault {
  constructor(file) {
    this.file = file;
    this.data = { version: 1, credential: null, pages: {} };
    this.unlocked = new Set();
    this.generation = 0;
    this.failures = 0;
    this.nextTry = 0;
    this.corrupt = false;
    try {
      const d = JSON.parse(fs.readFileSync(file, "utf8"));
      if (
        d.version !== 1 ||
        !d.pages ||
        Array.isArray(d.pages) ||
        typeof d.pages !== "object" ||
        (d.credential &&
          (!/^[a-f0-9]{32}$/.test(d.credential.salt) ||
            !/^[a-f0-9]{64}$/.test(d.credential.hash))) ||
        (!d.credential && Object.keys(d.pages).length) ||
        Object.entries(d.pages).some(
          ([k, v]) =>
            !/^[a-f0-9]{32}$/.test(k) ||
            !v ||
            typeof v.title !== "string" ||
            v.title.length > 160,
        )
      )
        throw Error("Invalid store");
      this.data = d;
    } catch (e) {
      if (e.code !== "ENOENT") this.corrupt = true;
    }
  }
  save(next = this.data) {
    if (this.corrupt)
      throw Error("锁定配置损坏。请恢复配置备份，不能自动清除保护。");
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const temp = this.file + ".tmp";
    fs.writeFileSync(temp, JSON.stringify(next), { mode: 0o600 });
    fs.chmodSync(temp, 0o600);
    fs.renameSync(temp, this.file);
    this.data = next;
  }
  async setup(password) {
    if (this.corrupt || this.data.credential)
      throw Error("已设置密码或配置不可读。");
    if (
      typeof password !== "string" ||
      password.length < 10 ||
      password.length > 256
    )
      throw Error("请使用 10–256 个字符的独立密码。");
    const salt = crypto.randomBytes(16).toString("hex");
    const hash = (
      await scrypt(password, salt, 32, {
        N: 32768,
        r: 8,
        p: 1,
        maxmem: 64 * 1024 * 1024,
      })
    ).toString("hex");
    this.save({ ...this.data, credential: { salt, hash } });
  }
  async verify(password) {
    if (this.corrupt || !this.data.credential) return false;
    if (Date.now() < this.nextTry) throw Error("尝试过多，请稍后再试。");
    if (typeof password !== "string" || password.length > 256) return false;
    const { salt, hash } = this.data.credential;
    const actual = await scrypt(password, salt, 32, {
      N: 32768,
      r: 8,
      p: 1,
      maxmem: 64 * 1024 * 1024,
    });
    const ok = crypto.timingSafeEqual(actual, Buffer.from(hash, "hex"));
    if (ok) {
      this.failures = 0;
      this.nextTry = 0;
    } else {
      this.failures++;
      this.nextTry =
        Date.now() + Math.min(30000, 500 * 2 ** Math.min(this.failures - 1, 6));
    }
    return ok;
  }
  protect(id, title) {
    if (!this.data.credential || !/^[a-f0-9]{32}$/.test(id))
      throw Error("请先设置密码并打开一个 Notion 页面。");
    this.save({
      ...this.data,
      pages: {
        ...this.data.pages,
        [id]: { title: String(title || "未命名页面").slice(0, 160) },
      },
    });
    this.unlocked.delete(id);
    this.generation++;
  }
  remove(id) {
    const pages = { ...this.data.pages };
    delete pages[id];
    this.save({ ...this.data, pages });
    this.unlocked.delete(id);
    this.generation++;
  }
  lockAll() {
    this.unlocked.clear();
    this.generation++;
  }
  state() {
    return {
      configured: !!this.data.credential,
      corrupt: this.corrupt,
      lockedIds: Object.keys(this.data.pages).filter(
        (id) => !this.unlocked.has(id),
      ),
      protectedIds: Object.keys(this.data.pages),
    };
  }
}
module.exports = { pageId, Vault };
