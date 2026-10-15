(function () {
  if (window.top !== window) return;
  if (document.getElementById("side-chat-root")) return;

  const root = document.createElement("div");
  root.id = "side-chat-root";
  root.style.cssText = "position:fixed;left:20px;bottom:20px;z-index:2147483647;";

  const frame = document.createElement("iframe");
  frame.src = chrome.runtime.getURL("chat.html");
  frame.style.cssText =
    "display:none;width:340px;height:480px;border:0;border-radius:14px;" +
    "box-shadow:0 6px 24px rgba(0,0,0,.3);margin-bottom:10px;background:#fff;";

  const btn = document.createElement("button");
  btn.textContent = "💬";
  btn.title = "צ'אט";
  btn.style.cssText =
    "display:block;width:52px;height:52px;border-radius:50%;border:0;cursor:pointer;" +
    "background:#2f6fed;color:#fff;font-size:24px;box-shadow:0 4px 12px rgba(0,0,0,.3);";
  btn.onclick = () => {
    frame.style.display = frame.style.display === "none" ? "block" : "none";
  };

  root.appendChild(frame);
  root.appendChild(btn);
  document.documentElement.appendChild(root);
})();
