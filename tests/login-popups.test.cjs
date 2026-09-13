const test = require("node:test");
const assert = require("node:assert/strict");
const { isLoginPopup, isWebLoginURL, isAllowedLoginNavigation } = require("../src/login-popups.cjs");

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
    "https://user:password@app.notion.com/googlepopupredirect",
    "https://app.notion.com:444/googlepopupredirect",
  ]) {
    assert(!isLoginPopup("https://app.notion.com/login", destination));
  }
});


test("authentication callbacks use web mode without granting normal tabs provider access", () => {
  for (const route of ["login", "signup", "appleauthcallback", "chatgptauthcallback", "oauth2callback"])
    assert(isWebLoginURL("https://app.notion.com/" + route));
  for (const url of ["https://evil.test/login", "https://app.notion.com/login-evil", "https://app.notion.com/private-page"])
    assert(!isWebLoginURL(url));
  for (const url of ["https://auth.openai.com/oauth/authorize", "https://appleid.apple.com/auth/authorize", "https://app.notion.com/login"])
    assert(!isAllowedLoginNavigation({}, url));
});
