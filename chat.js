(function () {
  const SUPABASE_URL = "https://cazrzfqmnrdlfzqsoycu.supabase.co";
  const SUPABASE_KEY = "sb_publishable_nKyN0JhaSmiQ5NRYOX3afA_ptTDNMms";
  const FAKE_DOMAIN = "@mailinator.com";
  const AI_USER = { id: "ai", username: "🤖 עוזר AI" };
  const MAX_FILE = 10 * 1024 * 1024;
  const $ = (id) => document.getElementById(id);

  let session = JSON.parse(localStorage.getItem("session") || "null");
  let currentChat = null;
  let pollTimer = null;
  let aiBusy = false;
  let clearBtn = null;
  let attachBtn = null;
  let fileInput = null;
  let uploadNote = null;
  let lastMsgs = [];
  let lastSig = "";
  let selectedId = null;
  let editingId = null;
  const blobCache = {};

  function show(viewId) {
    ["view-auth", "view-contacts", "view-chat"].forEach((v) =>
      $(v).classList.toggle("hidden", v !== viewId));
  }

  function saveSession(s) {
    session = s;
    if (s) localStorage.setItem("session", JSON.stringify(s));
    else localStorage.removeItem("session");
  }

  async function rawFetch(path, options = {}, token) {
    const headers = {
      apikey: SUPABASE_KEY,
      "Content-Type": "application/json",
      ...(options.headers || {}),
    };
    if (token) headers.Authorization = "Bearer " + token;
    return fetch(SUPABASE_URL + path, { ...options, headers });
  }

  async function refreshToken() {
    const r = await rawFetch("/auth/v1/token?grant_type=refresh_token", {
      method: "POST",
      body: JSON.stringify({ refresh_token: session.refresh_token }),
    });
    if (!r.ok) { logout(); throw new Error("פג תוקף החיבור, התחבר שוב"); }
    const d = await r.json();
    saveSession({ ...session, access_token: d.access_token, refresh_token: d.refresh_token });
  }

  async function db(path, options = {}) {
    let r = await rawFetch(path, options, session.access_token);
    if (r.status === 401) {
      await refreshToken();
      r = await rawFetch(path, options, session.access_token);
    }
    return r;
  }

  function readCreds() {
    const username = $("auth-user").value.trim().toLowerCase();
    const password = $("auth-pass").value;
    if (!/^[a-z0-9_]{3,20}$/.test(username)) {
      throw new Error("שם משתמש: 3-20 תווים, אותיות באנגלית, מספרים או _ בלבד");
    }
    if (password.length < 6) throw new Error("הסיסמה חייבת להכיל לפחות 6 תווים");
    return { username, password };
  }

  async function signup() {
    try {
      const { username, password } = readCreds();
      $("auth-msg").textContent = "";
      const r = await rawFetch("/auth/v1/signup", {
        method: "POST",
        body: JSON.stringify({
          email: username + FAKE_DOMAIN,
          password,
          data: { username },
        }),
      });
      const d = await r.json();
      if (!r.ok) {
        const m = d.msg || d.error_description || d.message || "";
        throw new Error(/already/i.test(m) ? "שם המשתמש תפוס" : (m || "ההרשמה נכשלה"));
      }
      await login();
    } catch (e) { $("auth-msg").textContent = e.message; }
  }

  async function login() {
    try {
      const { username, password } = readCreds();
      $("auth-msg").textContent = "";
      const r = await rawFetch("/auth/v1/token?grant_type=password", {
        method: "POST",
        body: JSON.stringify({ email: username + FAKE_DOMAIN, password }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error("שם משתמש או סיסמה שגויים");
      saveSession({
        access_token: d.access_token,
        refresh_token: d.refresh_token,
        user_id: d.user.id,
        username,
      });
      openContacts();
    } catch (e) { $("auth-msg").textContent = e.message; }
  }

  function logout() {
    saveSession(null);
    clearInterval(pollTimer);
    currentChat = null;
    show("view-auth");
  }

  async function openContacts() {
    clearInterval(pollTimer);
    currentChat = null;
    $("me-name").textContent = "שלום, " + session.username;
    $("search").value = "";
    show("view-contacts");
    loadRecentContacts();
  }

  function renderContacts(list, emptyText, includeAI) {
    const ul = $("contacts");
    ul.innerHTML = "";
    if (includeAI) {
      const li = document.createElement("li");
      li.textContent = AI_USER.username;
      li.style.fontWeight = "bold";
      li.style.background = "#f3f6ff";
      li.onclick = () => openChat(AI_USER);
      ul.appendChild(li);
    }
    if (!list.length) {
      const li = document.createElement("li");
      li.textContent = emptyText || "אין תוצאות";
      li.style.color = "#888";
      ul.appendChild(li);
      return;
    }
    list.forEach((u) => {
      const li = document.createElement("li");
      li.textContent = u.username;
      li.onclick = () => openChat(u);
      ul.appendChild(li);
    });
  }

  async function loadRecentContacts() {
    renderContacts([], "חפש משתמש כדי להתחיל שיחה", true);
    const r = await db(
      "/rest/v1/messages?select=sender_id,receiver_id&order=created_at.desc&limit=200"
    );
    if (!r.ok) return;
    const msgs = await r.json();
    const ids = [];
    msgs.forEach((m) => {
      const other = m.sender_id === session.user_id ? m.receiver_id : m.sender_id;
      if (!ids.includes(other)) ids.push(other);
    });
    if (!ids.length) return;
    const pr = await db(`/rest/v1/profiles?select=id,username&id=in.(${ids.join(",")})`);
    const profiles = await pr.json();
    renderContacts(ids.map((id) => profiles.find((p) => p.id === id)).filter(Boolean), "", true);
  }

  async function searchUsers() {
    const q = $("search").value.trim().toLowerCase().replace(/[^a-z0-9_]/g, "");
    if (!q) return loadRecentContacts();
    const r = await db(
      `/rest/v1/profiles?select=id,username&username=ilike.*${q}*&id=neq.${session.user_id}&limit=20`
    );
    if (r.ok) renderContacts(await r.json(), "", false);
  }

  // ---------- העוזר (AI) ----------
  function aiKey() { return "ai_history_" + session.user_id; }

  function getAIHistory() {
    try { return JSON.parse(localStorage.getItem(aiKey()) || "[]"); }
    catch (e) { return []; }
  }

  function saveAIHistory(h) {
    localStorage.setItem(aiKey(), JSON.stringify(h.slice(-50)));
  }

  function addBubble(text, who) {
    const div = document.createElement("div");
    div.className = "bubble " + who;
    div.textContent = text;
    $("messages").appendChild(div);
  }

  function renderAI(typing, errText) {
    const box = $("messages");
    box.innerHTML = "";
    const hist = getAIHistory();
    if (!hist.length) addBubble("שלום! אני עוזר AI. איך אפשר לעזור?", "them");
    hist.forEach((m) => addBubble(m.content, m.role === "user" ? "me" : "them"));
    if (typing) addBubble("…", "them");
    if (errText) addBubble("⚠️ " + errText, "them");
    box.scrollTop = box.scrollHeight;
  }

  async function sendToAI(content) {
    if (aiBusy) return;
    aiBusy = true;
    const hist = getAIHistory();
    hist.push({ role: "user", content });
    saveAIHistory(hist);
    renderAI(true);
    let err = "";
    try {
      const r = await db("/functions/v1/ai-chat", {
        method: "POST",
        body: JSON.stringify({ messages: hist.slice(-20) }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok || !d.reply) throw new Error(d.error || "העוזר לא זמין כרגע, נסה שוב");
      hist.push({ role: "assistant", content: d.reply });
      saveAIHistory(hist);
    } catch (e) { err = e.message; }
    aiBusy = false;
    if (currentChat && currentChat.id === "ai") renderAI(false, err);
  }

  // ---------- קבצים ----------
  function getBlobUrl(path) {
    if (!blobCache[path]) {
      blobCache[path] = db(`/storage/v1/object/authenticated/chat-files/${path}`)
        .then(async (r) => {
          if (!r.ok) throw new Error("download failed");
          return URL.createObjectURL(await r.blob());
        })
        .catch((e) => { delete blobCache[path]; throw e; });
    }
    return blobCache[path];
  }

  async function downloadFile(path, name) {
    try {
      const url = await getBlobUrl(path);
      const a = document.createElement("a");
      a.href = url;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      a.remove();
    } catch (e) { alert("ההורדה נכשלה"); }
  }

  function setNote(text) {
    if (uploadNote) uploadNote.textContent = text || "";
  }

  async function sendFile(file) {
    if (!file || !currentChat || currentChat.id === "ai") return;
    if (file.size > MAX_FILE) { setNote("הקובץ גדול מדי (מקסימום 10MB)"); return; }
    setNote("מעלה קובץ...");
    const extMatch = file.name.match(/\.[A-Za-z0-9]{1,8}$/);
    const ext = extMatch ? extMatch[0] : "";
    const path = `${session.user_id}/${Date.now()}_${Math.random().toString(36).slice(2, 8)}${ext}`;
    try {
      const up = await db(`/storage/v1/object/chat-files/${path}`, {
        method: "POST",
        headers: { "Content-Type": file.type || "application/octet-stream" },
        body: file,
      });
      if (!up.ok) throw new Error("ההעלאה נכשלה");
      const r = await db("/rest/v1/messages", {
        method: "POST",
        headers: { Prefer: "return=minimal" },
        body: JSON.stringify({
          sender_id: session.user_id,
          receiver_id: currentChat.id,
          content: file.name.slice(0, 200),
          file_path: path,
          file_type: file.type || "application/octet-stream",
        }),
      });
      if (!r.ok) {
        await db(`/storage/v1/object/chat-files/${path}`, { method: "DELETE" });
        throw new Error("שליחת ההודעה נכשלה");
      }
      setNote("");
      loadMessages();
    } catch (e) { setNote(e.message); }
  }

  // ---------- שיחה ----------
  function openChat(user) {
    currentChat = user;
    $("chat-with").textContent = user.username;
    $("messages").innerHTML = "";
    delete $("messages").dataset.init;
    clearInterval(pollTimer);
    lastMsgs = [];
    lastSig = "";
    selectedId = null;
    editingId = null;
    setNote("");
    show("view-chat");
    if (user.id === "ai") {
      clearBtn.classList.remove("hidden");
      attachBtn.style.display = "none";
      renderAI(aiBusy);
    } else {
      clearBtn.classList.add("hidden");
      attachBtn.style.display = "";
      loadMessages();
      pollTimer = setInterval(loadMessages, 3000);
    }
    $("msg-input").focus();
  }

  function smallBtn(text, onclick) {
    const b = document.createElement("button");
    b.textContent = text;
    b.style.cssText =
      "background:rgba(0,0,0,.18);color:inherit;border:0;border-radius:6px;" +
      "padding:3px 8px;font-size:12px;cursor:pointer;margin-inline-end:6px;";
    b.onclick = (e) => { e.stopPropagation(); onclick(); };
    return b;
  }

  function fileNode(m) {
    const wrap = document.createElement("div");
    const isImg = (m.file_type || "").startsWith("image/");
    if (isImg) {
      const img = document.createElement("img");
      img.alt = m.content;
      img.style.cssText =
        "max-width:200px;max-height:240px;border-radius:8px;display:block;" +
        "background:rgba(0,0,0,.08);min-width:60px;min-height:40px;cursor:zoom-in;";
      getBlobUrl(m.file_path)
        .then((u) => { img.src = u; })
        .catch(() => { img.replaceWith(document.createTextNode("⚠️ לא ניתן לטעון את התמונה")); });
      img.onclick = (e) => {
        e.stopPropagation();
        const big = img.dataset.big === "1";
        img.dataset.big = big ? "0" : "1";
        img.style.maxWidth = big ? "200px" : "100%";
        img.style.maxHeight = big ? "240px" : "none";
        img.style.cursor = big ? "zoom-in" : "zoom-out";
      };
      wrap.appendChild(img);
      const cap = document.createElement("div");
      cap.textContent = m.content;
      cap.style.cssText = "font-size:11px;opacity:.7;margin-top:2px;word-break:break-all;";
      wrap.appendChild(cap);
    } else {
      const t = document.createElement("span");
      t.textContent = "📎 " + m.content;
      t.style.wordBreak = "break-all";
      wrap.appendChild(t);
    }
    const row = document.createElement("div");
    row.style.marginTop = "6px";
    row.appendChild(smallBtn("⬇ הורד", () => downloadFile(m.file_path, m.content)));
    wrap.appendChild(row);
    return wrap;
  }

  function renderMessages() {
    const me = session.user_id;
    const box = $("messages");
    const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
    box.innerHTML = "";
    lastMsgs.forEach((m) => {
      const mine = m.sender_id === me;
      const isFile = !!m.file_path;
      const div = document.createElement("div");
      div.className = "bubble " + (mine ? "me" : "them");

      if (editingId === m.id && !isFile) {
        const input = document.createElement("input");
        input.value = m.content;
        input.maxLength = 1000;
        input.style.cssText = "width:100%;padding:6px;border-radius:6px;border:0;color:#222;margin-bottom:6px;";
        input.onkeydown = (e) => {
          if (e.key === "Enter") saveEdit(m.id, input.value);
          if (e.key === "Escape") { editingId = null; renderMessages(); }
        };
        input.onclick = (e) => e.stopPropagation();
        div.appendChild(input);
        const row = document.createElement("div");
        row.appendChild(smallBtn("שמור", () => saveEdit(m.id, input.value)));
        row.appendChild(smallBtn("ביטול", () => { editingId = null; renderMessages(); }));
        div.appendChild(row);
        setTimeout(() => input.focus(), 0);
      } else {
        if (isFile) {
          div.appendChild(fileNode(m));
        } else {
          const t = document.createElement("span");
          t.textContent = m.content;
          div.appendChild(t);
          if (m.edited_at) {
            const e = document.createElement("span");
            e.textContent = " (נערכה)";
            e.style.cssText = "font-size:11px;opacity:.7;";
            div.appendChild(e);
          }
        }
        if (mine) {
          div.style.cursor = "pointer";
          div.onclick = () => {
            selectedId = selectedId === m.id ? null : m.id;
            renderMessages();
          };
          if (selectedId === m.id) {
            const row = document.createElement("div");
            row.style.marginTop = "6px";
            if (!isFile) {
              row.appendChild(smallBtn("✏️ ערוך", () => { editingId = m.id; renderMessages(); }));
            }
            row.appendChild(smallBtn("🗑 מחק", () => deleteMsg(m.id)));
            div.appendChild(row);
          }
        }
      }
      box.appendChild(div);
    });
    if (atBottom || !box.dataset.init) { box.scrollTop = box.scrollHeight; box.dataset.init = "1"; }
  }

  async function loadMessages() {
    if (!currentChat || currentChat.id === "ai") return;
    const me = session.user_id, other = currentChat.id;
    const filter = `or=(and(sender_id.eq.${me},receiver_id.eq.${other}),and(sender_id.eq.${other},receiver_id.eq.${me}))`;
    const r = await db(`/rest/v1/messages?select=id,sender_id,content,edited_at,file_path,file_type&${filter}&order=created_at.asc&limit=200`);
    if (!r.ok) return;
    const msgs = await r.json();
    const sig = JSON.stringify(msgs);
    if (sig === lastSig) return;
    lastSig = sig;
    lastMsgs = msgs;
    if (editingId !== null) return;   // לא מרעננים בזמן עריכה
    renderMessages();
  }

  async function saveEdit(id, text) {
    text = text.trim();
    const old = lastMsgs.find((m) => m.id === id);
    editingId = null;
    selectedId = null;
    if (!text || (old && old.content === text)) { renderMessages(); return; }
    const r = await db(`/rest/v1/messages?id=eq.${id}`, {
      method: "PATCH",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify({ content: text, edited_at: new Date().toISOString() }),
    });
    if (!r.ok) alert("העריכה נכשלה");
    await loadMessages();
  }

  async function deleteMsg(id) {
    if (!confirm("למחוק את ההודעה?")) return;
    selectedId = null;
    const old = lastMsgs.find((m) => m.id === id);
    const r = await db(`/rest/v1/messages?id=eq.${id}`, {
      method: "DELETE",
      headers: { Prefer: "return=minimal" },
    });
    if (!r.ok) { alert("המחיקה נכשלה"); return; }
    if (old && old.file_path) {
      db(`/storage/v1/object/chat-files/${old.file_path}`, { method: "DELETE" }).catch(() => {});
      delete blobCache[old.file_path];
    }
    await loadMessages();
  }

  async function sendMessage() {
    const input = $("msg-input");
    const content = input.value.trim();
    if (!content || !currentChat) return;
    input.value = "";
    if (currentChat.id === "ai") { sendToAI(content); return; }
    await db("/rest/v1/messages", {
      method: "POST",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify({
        sender_id: session.user_id,
        receiver_id: currentChat.id,
        content,
      }),
    });
    loadMessages();
  }

  // ---------- רכיבים שנוצרים מהקוד (בלי לשנות HTML) ----------
  clearBtn = document.createElement("button");
  clearBtn.className = "link hidden";
  clearBtn.textContent = "🗑 נקה";
  clearBtn.onclick = () => {
    if (confirm("למחוק את השיחה עם העוזר?")) {
      localStorage.removeItem(aiKey());
      renderAI(false);
    }
  };
  $("chat-with").parentElement.appendChild(clearBtn);

  const composer = $("msg-input").parentElement;

  uploadNote = document.createElement("div");
  uploadNote.style.cssText = "color:#c0392b;font-size:13px;min-height:0;";
  composer.parentElement.insertBefore(uploadNote, composer);

  attachBtn = document.createElement("button");
  attachBtn.textContent = "📎";
  attachBtn.title = "צירוף קובץ או תמונה";
  attachBtn.style.cssText =
    "background:#e6e9f0;color:#222;padding:8px 10px;font-size:16px;border:0;border-radius:8px;cursor:pointer;";
  composer.insertBefore(attachBtn, $("msg-input"));

  fileInput = document.createElement("input");
  fileInput.type = "file";
  fileInput.style.display = "none";
  document.body.appendChild(fileInput);
  attachBtn.onclick = () => fileInput.click();
  fileInput.onchange = (e) => { sendFile(e.target.files[0]); e.target.value = ""; };

  $("btn-login").onclick = login;
  $("btn-signup").onclick = signup;
  $("btn-logout").onclick = logout;
  $("btn-back").onclick = openContacts;
  $("btn-send").onclick = sendMessage;
  $("msg-input").onkeydown = (e) => { if (e.key === "Enter") sendMessage(); };
  $("auth-pass").onkeydown = (e) => { if (e.key === "Enter") login(); };
  let searchDelay;
  $("search").oninput = () => { clearTimeout(searchDelay); searchDelay = setTimeout(searchUsers, 300); };

  if (session) openContacts(); else show("view-auth");
})();
