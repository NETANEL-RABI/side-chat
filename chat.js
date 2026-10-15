(function () {
  const $ = (id) => document.getElementById(id);
  const FAKE_DOMAIN = "@gmail.com";

  let session = JSON.parse(localStorage.getItem("session") || "null");
  let currentChat = null;
  let pollTimer = null;

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

  function renderContacts(list, emptyText) {
    const ul = $("contacts");
    ul.innerHTML = "";
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
    if (!ids.length) { renderContacts([], "חפש משתמש כדי להתחיל שיחה"); return; }
    const pr = await db(`/rest/v1/profiles?select=id,username&id=in.(${ids.join(",")})`);
    const profiles = await pr.json();
    renderContacts(ids.map((id) => profiles.find((p) => p.id === id)).filter(Boolean));
  }

  async function searchUsers() {
    const q = $("search").value.trim().toLowerCase().replace(/[^a-z0-9_]/g, "");
    if (!q) return loadRecentContacts();
    const r = await db(
      `/rest/v1/profiles?select=id,username&username=ilike.*${q}*&id=neq.${session.user_id}&limit=20`
    );
    if (r.ok) renderContacts(await r.json());
  }

  function openChat(user) {
    currentChat = user;
    $("chat-with").textContent = user.username;
    $("messages").innerHTML = "";
    delete $("messages").dataset.init;
    show("view-chat");
    loadMessages();
    clearInterval(pollTimer);
    pollTimer = setInterval(loadMessages, 3000);
    $("msg-input").focus();
  }

  async function loadMessages() {
    if (!currentChat) return;
    const me = session.user_id, other = currentChat.id;
    const filter = `or=(and(sender_id.eq.${me},receiver_id.eq.${other}),and(sender_id.eq.${other},receiver_id.eq.${me}))`;
    const r = await db(`/rest/v1/messages?select=id,sender_id,content&${filter}&order=created_at.asc&limit=200`);
    if (!r.ok) return;
    const msgs = await r.json();
    const box = $("messages");
    const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
    box.innerHTML = "";
    msgs.forEach((m) => {
      const div = document.createElement("div");
      div.className = "bubble " + (m.sender_id === me ? "me" : "them");
      div.textContent = m.content;
      box.appendChild(div);
    });
    if (atBottom || !box.dataset.init) { box.scrollTop = box.scrollHeight; box.dataset.init = "1"; }
  }

  async function sendMessage() {
    const input = $("msg-input");
    const content = input.value.trim();
    if (!content || !currentChat) return;
    input.value = "";
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
