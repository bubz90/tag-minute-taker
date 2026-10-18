const $ = (id) => document.getElementById(id);
let db;
let topics = [];
let currentTopic = null;

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('tag-minute-taker', 1);
    req.onupgradeneeded = () => {
      const d = req.result;
      d.createObjectStore('topics', { keyPath: 'id', autoIncrement: true });
      const entries = d.createObjectStore('entries', { keyPath: 'id', autoIncrement: true });
      entries.createIndex('topicId', 'topicId');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function run(store, mode, fn) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, mode);
    const req = fn(tx.objectStore(store));
    tx.oncomplete = () => resolve(req && req.result);
    tx.onerror = () => reject(tx.error);
  });
}

const getTopics = () => run('topics', 'readonly', (s) => s.getAll());
const addTopic = (name) => run('topics', 'readwrite', (s) => s.add({ name, createdAt: Date.now() }));
const renameTopic = (id, name) => run('topics', 'readwrite', (s) => {
  const req = s.get(id);
  req.onsuccess = () => s.put({ ...req.result, name });
  return req;
});
const deleteTopic = (id) => new Promise((resolve, reject) => {
  const tx = db.transaction(['topics', 'entries'], 'readwrite');
  tx.objectStore('topics').delete(id);
  const idx = tx.objectStore('entries').index('topicId');
  idx.openKeyCursor(IDBKeyRange.only(id)).onsuccess = (e) => {
    const c = e.target.result;
    if (c) { tx.objectStore('entries').delete(c.primaryKey); c.continue(); }
  };
  tx.oncomplete = resolve;
  tx.onerror = () => reject(tx.error);
});
const clearTopicEntries = (id) => new Promise((resolve, reject) => {
  const tx = db.transaction('entries', 'readwrite');
  const store = tx.objectStore('entries');
  store.index('topicId').openKeyCursor(IDBKeyRange.only(id)).onsuccess = (e) => {
    const c = e.target.result;
    if (c) { store.delete(c.primaryKey); c.continue(); }
  };
  tx.oncomplete = resolve;
  tx.onerror = () => reject(tx.error);
});
const renameSpeaker = (topicId, from, to) => new Promise((resolve, reject) => {
  const tx = db.transaction('entries', 'readwrite');
  const store = tx.objectStore('entries');
  store.index('topicId').openCursor(IDBKeyRange.only(topicId)).onsuccess = (e) => {
    const c = e.target.result;
    if (!c) return;
    if (c.value.actor.toLowerCase() === from.toLowerCase()) c.update({ ...c.value, actor: to });
    c.continue();
  };
  tx.oncomplete = resolve;
  tx.onerror = () => reject(tx.error);
});
const purgeAll = () => new Promise((resolve, reject) => {
  const tx = db.transaction(['topics', 'entries'], 'readwrite');
  tx.objectStore('topics').clear();
  tx.objectStore('entries').clear();
  tx.oncomplete = resolve;
  tx.onerror = () => reject(tx.error);
});
const updateEntry = (id, topicId, actor, text) => new Promise((resolve, reject) => {
  const tx = db.transaction('entries', 'readwrite');
  const store = tx.objectStore('entries');
  let found = false;
  store.get(id).onsuccess = (e) => {
    const cur = e.target.result;
    if (cur && cur.topicId === topicId) {
      found = true;
      store.put({ ...cur, actor, text });
    }
  };
  tx.oncomplete = () => resolve(found);
  tx.onerror = () => reject(tx.error);
});
const deleteEntry = (id, topicId) => new Promise((resolve, reject) => {
  const tx = db.transaction('entries', 'readwrite');
  const store = tx.objectStore('entries');
  let found = false;
  store.get(id).onsuccess = (e) => {
    if (e.target.result && e.target.result.topicId === topicId) {
      found = true;
      store.delete(id);
    }
  };
  tx.oncomplete = () => resolve(found);
  tx.onerror = () => reject(tx.error);
});
const getEntries = (topicId) => run('entries', 'readonly', (s) => s.index('topicId').getAll(topicId));
const addEntry = (e) => run('entries', 'readwrite', (s) => s.add(e));

function colorFor(name) {
  let h = 0;
  for (const c of name.toLowerCase()) h = (h * 31 + c.charCodeAt(0)) % 360;
  return `hsl(${h}, 70%, 35%)`;
}

function parse(text) {
  const m = text.trim().match(/^(\S+)\s*(.*)$/s);
  if (!m) return null;
  const actor = m[1].replace(/[:,;]+$/, '');
  return actor ? { actor, text: m[2] } : null;
}

const pad = (n) => String(n).padStart(2, '0');
function fmt(ts) {
  const d = new Date(ts);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function renderTabs() {
  const tabs = $('tabs');
  const menu = $('topicMenu');
  tabs.innerHTML = '';
  menu.innerHTML = '';
  menu.classList.add('hidden');
  const cur = topics.find((t) => t.id === currentTopic);
  if (cur) {
    const b = document.createElement('button');
    b.textContent = cur.name;
    b.className = 'px-3 py-1 border border-gray-500 bg-white font-bold';
    tabs.appendChild(b);
  }
  const others = topics.filter((t) => t.id !== currentTopic);
  $('moreTopics').parentElement.classList.toggle('hidden', !others.length);
  for (const t of others) {
    const li = document.createElement('li');
    li.textContent = t.name;
    li.className = 'px-3 py-1 cursor-pointer hover:bg-blue-700 hover:text-white';
    li.onclick = () => selectTopic(t.id);
    menu.appendChild(li);
  }
}

$('moreTopics').onclick = (e) => {
  e.stopPropagation();
  $('topicMenu').classList.toggle('hidden');
};
document.addEventListener('click', () => $('topicMenu').classList.add('hidden'));

async function renderLog() {
  const log = $('log');
  const actors = $('actors');
  log.innerHTML = '';
  actors.innerHTML = '';
  if (currentTopic == null) {
    log.textContent = 'Create a topic with "+ Topic" to start taking minutes.';
    return;
  }
  const entries = (await getEntries(currentTopic)).sort((a, b) => a.ts - b.ts || a.id - b.id);
  const seen = new Map();
  let lastDay = null;
  for (const e of entries) {
    const day = new Date(e.ts).toDateString();
    if (day !== lastDay) {
      lastDay = day;
      const sep = document.createElement('div');
      sep.className = 'flex items-center gap-2 my-2 text-xs text-gray-500';
      sep.innerHTML = '<hr class="flex-1 border-gray-300"><span></span><hr class="flex-1 border-gray-300">';
      sep.querySelector('span').textContent = new Date(e.ts).toLocaleDateString(undefined, {
        weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
      });
      log.appendChild(sep);
    }
    const row = document.createElement('div');
    const time = document.createElement('span');
    time.className = 'text-gray-500';
    time.textContent = `[${fmt(e.ts)}] #${e.id} `;
    const who = document.createElement('span');
    who.className = 'inline-block px-2 mr-1 rounded-full text-white text-xs font-bold align-middle';
    who.style.backgroundColor = colorFor(e.actor);
    who.textContent = e.actor;
    who.title = 'Click to edit this entry';
    who.style.cursor = 'pointer';
    who.onclick = () => {
      $('input').value = `/edit ${e.id} ${e.actor} ${e.text}`;
      $('input').focus();
    };
    const msg = document.createElement('span');
    msg.textContent = e.text;
    row.append(time, who, msg);
    log.appendChild(row);
    seen.set(e.actor.toLowerCase(), (seen.get(e.actor.toLowerCase()) || 0) + 1);
  }
  for (const [name, n] of seen) {
    const li = document.createElement('li');
    li.style.color = colorFor(name);
    li.textContent = `${name} (${n})`;
    actors.appendChild(li);
  }
  log.scrollTop = log.scrollHeight;
}

const COMMANDS = [
  ['/help', 'show this list'],
  ['/new [name]', 'create a new topic'],
  ['/topic [name]', 'rename the current topic'],
  ['/speaker [old] [new]', 'rename a speaker in this topic'],
  ['/edit <id> <speaker> <message>', 'edit an entry (or click its badge)'],
  ['/edit <id> --delete', 'delete an entry'],
  ['/export', 'export the current topic to CSV'],
  ['/export all', 'export all topics to one CSV'],
  ['/clear', 'clear all entries in the current topic'],
  ['/delete', 'delete the current topic'],
  ['/purge', 'delete all topics and entries'],
];

function showSystem() {
  const log = $('log');
  const box = document.createElement('div');
  box.className = 'my-2 px-2 py-1 border border-yellow-400 bg-yellow-50 text-gray-700';
  const title = document.createElement('div');
  title.className = 'font-bold';
  title.textContent = `*** [${fmt(Date.now())}] Available commands:`;
  box.appendChild(title);
  for (const [cmd, desc] of COMMANDS) {
    const line = document.createElement('div');
    line.textContent = `  ${cmd} - ${desc}`;
    box.appendChild(line);
  }
  log.appendChild(box);
  log.scrollTop = log.scrollHeight;
}

const csvCell = (v) => `"${String(v).replace(/"/g, '""')}"`;

async function exportCsv(all) {
  const list = all ? topics : topics.filter((t) => t.id === currentTopic);
  const rows = [['topic', 'timestamp', 'speaker', 'message']];
  for (const t of list) {
    const entries = (await getEntries(t.id)).sort((a, b) => a.ts - b.ts || a.id - b.id);
    for (const e of entries) {
      const row = [new Date(e.ts).toISOString(), e.actor, e.text];
      rows.push([t.name, ...row]);
    }
  }
  const csv = '\ufeff' + rows.map((r) => r.map(csvCell).join(',')).join('\r\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  const name = all ? 'all-topics' : list[0].name.replace(/[^\w-]+/g, '_');
  a.download = `minutes-${name}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
}

async function selectTopic(id) {
  currentTopic = id;
  localStorage.setItem('currentTopic', id);
  renderTabs();
  await renderLog();
  $('input').focus();
}

async function createTopic(preset) {
  const name = typeof preset === 'string' ? preset : prompt('Topic name?');
  if (!name || !name.trim()) return;
  const id = await addTopic(name.trim());
  topics = await getTopics();
  await selectTopic(id);
}

$('addTopic').onclick = createTopic;

// Submitting the form covers Enter in the text field.
$('form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  if (currentTopic == null) return createTopic();
  if (/^\/delete\s*$/i.test($('input').value)) {
    const t = topics.find((x) => x.id === currentTopic);
    if (!confirm(`Delete topic "${t.name}" and all its entries?`)) return;
    await deleteTopic(currentTopic);
    $('input').value = '';
    topics = await getTopics();
    if (!topics.length) {
      await addTopic('General');
      topics = await getTopics();
    }
    return selectTopic(topics[0].id);
  }
  if (/^\/purge\s*$/i.test($('input').value)) {
    if (!confirm('Delete ALL topics and entries? This cannot be undone.')) return;
    await purgeAll();
    await addTopic('General');
    topics = await getTopics();
    $('input').value = '';
    return selectTopic(topics[0].id);
  }
  if (/^\/help\s*$/i.test($('input').value)) {
    $('input').value = '';
    return showSystem();
  }
  if (/^\/clear\s*$/i.test($('input').value)) {
    const t = topics.find((x) => x.id === currentTopic);
    if (!confirm(`Clear all entries in "${t.name}"? This cannot be undone.`)) return;
    await clearTopicEntries(currentTopic);
    $('input').value = '';
    return renderLog();
  }
  const del = $('input').value.trim().match(/^\/edit\s+#?(\d+)\s+--delete$/i);
  if (del) {
    const ok = await deleteEntry(Number(del[1]), currentTopic);
    if (!ok) return alert(`No entry #${del[1]} in this topic.`);
    $('input').value = '';
    return renderLog();
  }
  const ed = $('input').value.trim().match(/^\/edit\s+#?(\d+)\s+(.+)$/is);
  if (ed) {
    const parsed = parse(ed[2]);
    if (!parsed) return;
    const ok = await updateEntry(Number(ed[1]), currentTopic, parsed.actor, parsed.text);
    if (!ok) return alert(`No entry #${ed[1]} in this topic.`);
    $('input').value = '';
    return renderLog();
  }
  const exp = $('input').value.trim().match(/^\/export(\s+all)?$/i);
  if (exp) {
    $('input').value = '';
    return exportCsv(!!exp[1]);
  }
  const nw = $('input').value.trim().match(/^\/new(?:\s+(.+))?$/i);
  if (nw) {
    $('input').value = '';
    return createTopic(nw[1] ? nw[1].trim() : undefined);
  }
  const spk = $('input').value.trim().match(/^\/speaker\s+(\S+)\s+(\S+)$/i);
  if (spk) {
    await renameSpeaker(currentTopic, spk[1], spk[2]);
    $('input').value = '';
    return renderLog();
  }
  const cmd = $('input').value.trim().match(/^\/topic\s+(.+)$/i);
  if (cmd) {
    await renameTopic(currentTopic, cmd[1].trim());
    topics = await getTopics();
    $('input').value = '';
    renderTabs();
    return;
  }
  const parsed = parse($('input').value);
  if (!parsed) return;
  await addEntry({ topicId: currentTopic, ts: Date.now(), ...parsed });
  $('input').value = '';
  await renderLog();
});

(async () => {
  db = await openDb();
  topics = await getTopics();
  if (!topics.length) {
    await addTopic('General');
    topics = await getTopics();
  }
  const saved = Number(localStorage.getItem('currentTopic'));
  await selectTopic(topics.some((t) => t.id === saved) ? saved : topics[0].id);
})();

// Skip refocus when the user is selecting text to copy.
$('log').addEventListener('click', () => {
  if (window.getSelection().toString() === '') $('input').focus();
});
