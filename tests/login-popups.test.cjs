const test = require("node:test");
const assert = require("node:assert/strict");
const { isLoginPopup } = require("../src/login-popups.cjs");

test("only trusted login pages can open the Notion auth popup routes", () => {
  for (const route of [
    "googlepopupredirect",
    "applepopupredirect",
    "chatgptloginredirect",
    "verifyNoPopupBlockerHtmlAndRedirect",
  ]) {
    assert(
      isLoginPopup(
        "https://app.notion.com/login",
        `https://www.notion.so/${route}?callbackType=web`,
      ),
    );
  }
  assert(isLoginPopup("https://app.notion.com/login", "about:blank"));
  for (const opener of [
    "https://evil.test/login",
    "https://notion.com.evil.test/login",
    "http://app.notion.com/login",
    "https://app.notion.com/private-page",
  ]) {
    assert(!isLoginPopup(opener, "about:blank"));
  }
  for (const destination of [
    "javascript:alert(1)",
    "file:///tmp/test",
    "https://evil.test/googlepopupredirect",
    "https://notion.so/private-page",
  ]) {
    assert(!isLoginPopup("https://app.notion.com/login", destination));
  }
});
