const $ = (id) => document.getElementById(id);
let info;
(async () => {
  info = await window.lockPanel.info();
  $("heading").textContent =
    info.mode === "setup"
      ? "设置隐私锁密码"
      : info.mode === "manage"
        ? "管理页面保护"
        : "解锁页面";
  $("description").textContent =
    info.mode === "setup"
      ? "设置至少 10 个字符的独立密码。完成后锁住当前页面。"
      : info.mode === "manage"
        ? "选择要取消保护的页面，并输入密码确认。"
        : "输入密码后，在这次查看期间显示已锁页面。";
  $("confirm-row").hidden = info.mode !== "setup";
  $("confirm").required = info.mode === "setup";
  $("submit").textContent =
    info.mode === "setup"
      ? "设置密码并锁页"
      : info.mode === "manage"
        ? "取消页面保护"
        : "解锁查看";
  if (info.mode === "manage") {
    $("pages").hidden = false;
    const select = document.createElement("select");
    select.id = "page";
    for (const p of info.pages) {
      const o = document.createElement("option");
      o.value = p.id;
      o.textContent = p.title;
      select.append(o);
    }
    $("pages").append(select);
    if (!info.pages.length) {
      $("submit").disabled = true;
      $("error").textContent = "还没有添加受保护页面。";
    }
  }
  $("password").focus();
})().catch(() => {
  $("error").textContent = "无法读取锁定状态，请关闭后重试。";
  $("submit").disabled = true;
});
$("cancel").onclick = () => window.lockPanel.close();
$("form").onsubmit = async (e) => {
  e.preventDefault();
  $("submit").disabled = true;
  $("error").textContent = "";
  try {
    if (info.mode === "setup" && $("password").value !== $("confirm").value)
      throw Error("两次密码不一致。");
    const result = await window.lockPanel.submit({
      password: $("password").value,
      id: $("page")?.value,
    });
    $("password").value = "";
    $("confirm").value = "";
    if (!result.ok) throw Error(result.error || "未能解锁。");
    window.lockPanel.close();
  } catch (e) {
    $("error").textContent = e.message;
    $("password").value = "";
    $("password").focus();
  } finally {
    $("submit").disabled = false;
  }
};
