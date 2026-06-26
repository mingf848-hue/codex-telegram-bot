import fs from "node:fs";
import path from "node:path";
import { MongoClient } from "mongodb";

const root = path.resolve(new URL("../", import.meta.url).pathname);
loadDotEnv(path.join(root, ".env"));

const uri = process.env.MONGODB_URI;
const dbName = process.env.KNOWLEDGE_DB_NAME || "hajimi";
const cachePath = process.env.KNOWLEDGE_CACHE_PATH || path.join(root, "data", "knowledge-cache.json");
const query = process.argv.slice(2).join(" ").trim();

if (!query) {
  console.error("Usage: node scripts/search-knowledge.mjs <query>");
  process.exit(1);
}

if (fs.existsSync(cachePath)) {
  const cache = JSON.parse(fs.readFileSync(cachePath, "utf8"));
  const result = searchLocalCache(cache, query);
  console.log(JSON.stringify({ query, source: "local-cache", syncedAt: cache.syncedAt, ...result }, null, 2));
} else {
  if (!uri) {
    console.error("Missing local cache and MONGODB_URI in .env");
    process.exit(1);
  }
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 15000 });
  await client.connect();
  try {
    const db = client.db(dbName);
    const result = await searchRemote(db, query);
    console.log(JSON.stringify({ query, source: "mongodb", ...result }, null, 2));
  } finally {
    await client.close().catch(() => {});
  }
}

async function searchRemote(db, query) {
  const pattern = new RegExp(escapeRegExp(query), "i");
  const [units, training, rules, templates] = await Promise.all([
    db
      .collection("knowledge_units")
      .find({
        enabled: { $ne: false },
        $or: [
          { title: pattern },
          { content: pattern },
          { retrievalText: pattern },
          { keywordsText: pattern },
          { tagsText: pattern },
          { category: pattern },
          { domain: pattern },
          { venue: pattern },
        ],
      })
      .project({ embedding: 0 })
      .limit(8)
      .toArray(),
    db
      .collection("training_data")
      .find({ $or: [{ question: pattern }, { answer: pattern }, { type: pattern }] })
      .limit(6)
      .toArray(),
    db
      .collection("venue_rules")
      .find({ $or: [{ name: pattern }, { rules: pattern }] })
      .limit(4)
      .toArray(),
    db
      .collection("templates")
      .find({ $or: [{ type: pattern }, { front: pattern }, { inner: pattern }, { mail: pattern }] })
      .limit(4)
      .toArray(),
  ]);

  const result = [
    ...units.map((doc) => ({
      collection: "knowledge_units",
      title: doc.title || doc.category || String(doc._id),
      text: doc.content || doc.retrievalText || "",
      meta: compact({
        category: doc.category,
        domain: doc.domain,
        venue: doc.venue,
        tags: doc.tagsText,
      }),
    })),
    ...training.map((doc) => ({
      collection: "training_data",
      title: doc.question || String(doc._id),
      text: doc.answer || "",
      meta: compact({ type: doc.type, time: doc.time }),
    })),
    ...rules.map((doc) => ({
      collection: "venue_rules",
      title: doc.name || String(doc._id),
      text: doc.rules || "",
      meta: compact({ updateTime: doc.updateTime, imageCount: doc.imageCount }),
    })),
    ...templates.map((doc) => ({
      collection: "templates",
      title: doc.type || String(doc._id),
      text: [doc.front, doc.inner, doc.mail].filter(Boolean).join("\n\n"),
      meta: compact({ time: doc.time }),
    })),
  ].map((item) => ({
    ...item,
    text: normalize(item.text).slice(0, 1200),
  }));

  return { count: result.length, results: result };
}

function searchLocalCache(cache, query) {
  const pattern = new RegExp(escapeRegExp(query), "i");
  const collections = cache.collections || {};

  const units = (collections.knowledge_units || [])
    .filter((doc) =>
      [
        doc.title,
        doc.content,
        doc.retrievalText,
        doc.keywordsText,
        doc.tagsText,
        doc.category,
        doc.domain,
        doc.venue,
      ].some((value) => pattern.test(String(value || ""))),
    )
    .slice(0, 8);
  const training = (collections.training_data || [])
    .filter((doc) => [doc.question, doc.answer, doc.type].some((value) => pattern.test(String(value || ""))))
    .slice(0, 6);
  const rules = (collections.venue_rules || [])
    .filter((doc) => [doc.name, doc.rules].some((value) => pattern.test(String(value || ""))))
    .slice(0, 4);
  const templates = (collections.templates || [])
    .filter((doc) => [doc.type, doc.front, doc.inner, doc.mail].some((value) => pattern.test(String(value || ""))))
    .slice(0, 4);

  const results = [
    ...units.map((doc) => ({
      collection: "knowledge_units",
      title: doc.title || doc.category || String(doc._id),
      text: doc.content || doc.retrievalText || "",
      meta: compact({
        category: doc.category,
        domain: doc.domain,
        venue: doc.venue,
        tags: doc.tagsText,
      }),
    })),
    ...training.map((doc) => ({
      collection: "training_data",
      title: doc.question || String(doc._id),
      text: doc.answer || "",
      meta: compact({ type: doc.type, time: doc.time }),
    })),
    ...rules.map((doc) => ({
      collection: "venue_rules",
      title: doc.name || String(doc._id),
      text: doc.rules || "",
      meta: compact({ updateTime: doc.updateTime, imageCount: doc.imageCount }),
    })),
    ...templates.map((doc) => ({
      collection: "templates",
      title: doc.type || String(doc._id),
      text: [doc.front, doc.inner, doc.mail].filter(Boolean).join("\n\n"),
      meta: compact({ time: doc.time }),
    })),
  ].map((item) => ({
    ...item,
    text: normalize(item.text).slice(0, 1200),
  }));

  return { count: results.length, results };
}

function loadDotEnv(filePath) {
  if (!fs.existsSync(filePath)) {
    return;
  }

  for (const rawLine of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }
    const separator = line.indexOf("=");
    if (separator === -1) {
      continue;
    }
    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] ||= value;
  }
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalize(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function compact(value) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined && item !== null && item !== ""));
}
