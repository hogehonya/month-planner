import { getStore } from "@netlify/blobs";
import crypto from "node:crypto";

const STORE_NAME = "two-week-planner";
const MAX_RETRIES = 6;

const json = (body, status = 200) =>
  Response.json(body, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const validDate = (value) => /^\d{4}-\d{2}-\d{2}$/.test(String(value ?? ""));
const validField = (value) => ["slot1", "slot2", "note"].includes(value);

function securePinEqual(a, b) {
  const aa = Buffer.from(String(a ?? ""));
  const bb = Buffer.from(String(b ?? ""));
  if (aa.length !== bb.length) return false;
  return crypto.timingSafeEqual(aa, bb);
}

async function readEntry(store, date) {
  const result = await store.getWithMetadata(`entries/${date}.json`, {
    type: "json",
    consistency: "strong",
  });
  if (!result) return { row: null, etag: null };
  return { row: result.data, etag: result.etag };
}

async function writeFieldAtomic(store, { entryDate, field, value, editorName }) {
  const key = `entries/${entryDate}.json`;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const { row, etag } = await readEntry(store, entryDate);
    const now = new Date().toISOString();
    const next = {
      entry_date: entryDate,
      slot1: row?.slot1 ?? "",
      slot2: row?.slot2 ?? "",
      note: row?.note ?? "",
      last_editor: editorName,
      updated_at: now,
      [field]: value,
    };

    const result = row
      ? await store.setJSON(key, next, { onlyIfMatch: etag })
      : await store.setJSON(key, next, { onlyIfNew: true });

    if (result.modified) return next;
    await sleep(20 + Math.floor(Math.random() * 35));
  }

  throw new Error("同時更新が多いため保存できませんでした。もう一度入力してください。");
}

async function addHistory(store, item) {
  const id = `${Date.now()}-${crypto.randomUUID()}`;
  await store.setJSON(`history/${id}.json`, { id, ...item });
}

async function listEntries(store, start, end) {
  const { blobs } = await store.list({ prefix: "entries/" });
  const wanted = blobs
    .map((b) => b.key.match(/^entries\/(\d{4}-\d{2}-\d{2})\.json$/)?.[1])
    .filter((d) => d && d >= start && d <= end);

  const rows = await Promise.all(
    wanted.map(async (date) => {
      const row = await store.get(`entries/${date}.json`, {
        type: "json",
        consistency: "strong",
      });
      return row;
    })
  );

  return rows.filter(Boolean).sort((a, b) => a.entry_date.localeCompare(b.entry_date));
}

async function listHistory(store, limit = 30) {
  const { blobs } = await store.list({ prefix: "history/" });
  const latest = blobs
    .slice()
    .sort((a, b) => b.key.localeCompare(a.key))
    .slice(0, limit);

  const items = await Promise.all(
    latest.map((b) => store.get(b.key, { type: "json", consistency: "strong" }))
  );
  return items.filter(Boolean).sort((a, b) => b.changed_at.localeCompare(a.changed_at));
}

export default async (req) => {
  const store = getStore(STORE_NAME);

  if (req.method === "GET") {
    const url = new URL(req.url);
    const start = url.searchParams.get("start");
    const end = url.searchParams.get("end");
    if (!validDate(start) || !validDate(end) || start > end) {
      return json({ error: "日付範囲が不正です" }, 400);
    }

    try {
      const [entries, history] = await Promise.all([
        listEntries(store, start, end),
        listHistory(store, 30),
      ]);
      return json({ entries, history });
    } catch (error) {
      console.error(error);
      return json({ error: "データの読み込みに失敗しました" }, 500);
    }
  }

  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const editPin = process.env.EDIT_PIN;
  if (!editPin) return json({ error: "EDIT_PIN がNetlifyに設定されていません" }, 500);

  let body;
  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid JSON" }, 400);
  }

  if (!securePinEqual(body?.pin, editPin)) {
    await sleep(300);
    return json({ error: "PINが違います" }, 401);
  }

  if (body?.action === "verify") return json({ ok: true });
  if (body?.action !== "save") return json({ error: "Unknown action" }, 400);

  const entryDate = String(body.entry_date ?? "");
  const field = String(body.field ?? "");
  const value = String(body.value ?? "");
  const editorName = String(body.editor_name ?? "").trim();

  if (!validDate(entryDate)) return json({ error: "日付が不正です" }, 400);
  if (!validField(field)) return json({ error: "変更欄が不正です" }, 400);
  if (!editorName || editorName.length > 40) {
    return json({ error: "編集者名は1〜40文字で入力してください" }, 400);
  }

  const maxLen = field === "note" ? 3000 : 1200;
  if (value.length > maxLen) {
    return json({ error: `入力が長すぎます（最大${maxLen}文字）` }, 400);
  }

  try {
    const row = await writeFieldAtomic(store, { entryDate, field, value, editorName });
    await addHistory(store, {
      entry_date: entryDate,
      editor_name: editorName,
      field_name: field,
      changed_at: row.updated_at,
    });
    return json({ ok: true, row });
  } catch (error) {
    console.error(error);
    return json({ error: error?.message || "保存に失敗しました" }, 500);
  }
};
